/**
 * Loopback WebSocket bridge between this plugin and the Profile Autocomplete
 * browser extension. The wire protocol mirrors the retired Python backend so
 * the extension's transport code stays unchanged: the extension dials in, sends
 * `hello {browser}`, receives `ready`, then answers each `command` with a
 * `result`. The extension also pushes `tabs` and `ping`.
 *
 * The bridge owns its own `node:http` listener instead of depending on
 * `ctx.webServer` because the browser HTTP carrier is mounted only by the web
 * application bundle; a form-filling session must work under any entry point.
 * @module @deepseek-ai/dsh-experimental-form-filler/bridge
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
const COMMAND_TIMEOUT_MS = 30_000;
const HELLO_TIMEOUT_MS = 5_000;
/**
 * Owns the loopback listener, the connected browsers, and the request/result
 * correlation for extension commands.
 */
export class Bridge {
    options;
    clients = new Map();
    pending = new Map();
    wss = new WebSocketServer({ noServer: true });
    server;
    listeningPort = 0;
    constructor(options) {
        this.options = options;
    }
    /** The bound port (the resolved value when the configured port is 0). */
    get port() {
        return this.listeningPort;
    }
    /** Start listening and resolve once the socket is bound. */
    async start() {
        const server = createServer((req, res) => {
            if (req.url === '/health') {
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.end('ok');
                return;
            }
            res.writeHead(404);
            res.end();
        });
        this.server = server;
        server.on('upgrade', (req, socket, head) => { this.handleUpgrade(req, socket, head); });
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(this.options.port, this.options.host, () => {
                server.off('error', reject);
                /* v8 ignore next -- a post-listen listener error cannot be provoked deterministically */
                server.on('error', () => { });
                const address = server.address();
                /* v8 ignore next -- a loopback TCP listener always yields an AddressInfo */
                this.listeningPort = address !== null && typeof address === 'object' ? address.port : this.options.port;
                resolve();
            });
        });
    }
    /** Reject every in-flight command and close the listener and clients. */
    async stop() {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('form-filler bridge is shutting down'));
        }
        this.pending.clear();
        for (const client of this.clients.values())
            client.socket.close();
        this.clients.clear();
        await new Promise((resolve) => { this.wss.close(() => { resolve(); }); });
        const server = this.server;
        this.server = undefined;
        if (server !== undefined)
            await new Promise((resolve) => { server.close(() => { resolve(); }); });
    }
    /**
     * Connected browsers with their currently known tabs.
     * @returns one `{ browser, tabs }` entry per connected browser.
     */
    browsers() {
        return [...this.clients.values()].map(client => ({ browser: client.browser, tabs: [...client.tabs] }));
    }
    /**
     * Find a tab by id across every connected browser (stable browser order).
     * @param tabId - the tab id reported by the extension.
     * @returns the owning browser and tab, or `undefined` when no browser has it.
     */
    findTab(tabId) {
        for (const client of this.clients.values()) {
            const tab = client.tabs.find(candidate => candidate.id === tabId);
            if (tab !== undefined)
                return { browser: client.browser, tab };
        }
        return undefined;
    }
    /**
     * Send one command to a browser and await its readback.
     * @param browser - the browser connection identity.
     * @param op - the extension operation name.
     * @param params - operation payload, spread into the command message.
     * @param signal - the tool execution signal; aborting cancels the command.
     * @param timeoutMs - per-call deadline overriding the instance default.
     * @returns the extension-provided result payload.
     */
    async request(browser, op, params = {}, signal, timeoutMs) {
        const client = this.clients.get(browser);
        if (client === undefined)
            throw new Error('浏览器扩展未连接；请确认扩展已连到本地服务');
        if (signal?.aborted === true)
            throw new Error('已取消');
        const id = randomUUID();
        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                void this.send(client, { type: 'cancel', id });
                reject(new Error('浏览器命令超时；请检查扩展连接与目标页面'));
            }, timeoutMs ?? this.options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS);
            this.pending.set(id, { browser, resolve, reject, timer });
        });
        const onAbort = () => {
            const pending = this.pending.get(id);
            /* v8 ignore next -- the listener is removed in finally; absence means a timer or result already settled it */
            if (pending === undefined)
                return;
            clearTimeout(pending.timer);
            this.pending.delete(id);
            void this.send(client, { type: 'cancel', id });
            pending.reject(new Error('已取消'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            await this.send(client, { type: 'command', id, op, ...params });
            return await promise;
        }
        finally {
            signal?.removeEventListener('abort', onAbort);
        }
    }
    async send(client, message) {
        /* v8 ignore next 3 -- send runs only while the client is registered, so its socket is open */
        if (client.socket.readyState !== client.socket.OPEN) {
            throw new Error('浏览器扩展连接已断开');
        }
        await new Promise((resolve, reject) => {
            /* v8 ignore next 4 -- a ws send callback reports an error only on a transport fault mid-write */
            client.socket.send(JSON.stringify(message), (error) => {
                if (error)
                    reject(error);
                else
                    resolve();
            });
        });
    }
    handleUpgrade(req, socket, head) {
        /* v8 ignore next -- an HTTP upgrade request always carries a target */
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname !== '/bridge') {
            socket.destroy();
            return;
        }
        const origin = req.headers.origin ?? '';
        if (origin !== '' && !origin.startsWith('chrome-extension://')) {
            socket.destroy();
            return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => { this.handleConnection(ws); });
    }
    handleConnection(socket) {
        let browser;
        const helloTimer = setTimeout(() => { socket.close(1008); }, this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
        socket.on('message', (raw) => {
            /* v8 ignore next -- ws yields a Buffer for every text frame the extension sends */
            if (!Buffer.isBuffer(raw))
                return;
            let message;
            try {
                message = JSON.parse(raw.toString('utf8'));
            }
            catch {
                return;
            }
            if (browser === undefined) {
                const identity = typeof message.browser === 'string' ? message.browser : '';
                if (message.type !== 'hello'
                    || identity === '' || identity.length > 100 || this.clients.has(identity)) {
                    socket.close(1008);
                    return;
                }
                browser = identity;
                clearTimeout(helloTimer);
                this.clients.set(identity, { browser: identity, socket, tabs: [] });
                this.safeSend(socket, { type: 'ready' });
                return;
            }
            const client = this.clients.get(browser);
            /* v8 ignore next -- the close handler removes the client, so no later frame can arrive */
            if (client === undefined)
                return;
            if (message.type === 'tabs') {
                client.tabs = Array.isArray(message.tabs) ? message.tabs : [];
                return;
            }
            if (message.type === 'result') {
                const id = String(message.id);
                const pending = this.pending.get(id);
                if (pending === undefined || pending.browser !== browser)
                    return;
                clearTimeout(pending.timer);
                this.pending.delete(id);
                if (message.ok === true)
                    pending.resolve(message.result);
                else
                    pending.reject(new Error(typeof message.error === 'string' ? message.error : '浏览器命令失败'));
                return;
            }
            if (message.type === 'ping')
                this.safeSend(socket, { type: 'pong' });
        });
        socket.on('close', () => {
            clearTimeout(helloTimer);
            if (browser !== undefined && this.clients.get(browser)?.socket === socket)
                this.clients.delete(browser);
        });
        socket.on('error', () => { });
    }
    safeSend(socket, message) {
        try {
            socket.send(JSON.stringify(message));
        }
        catch {
            /* the socket closed between the check and the send */
        }
    }
}
//# sourceMappingURL=bridge.js.map