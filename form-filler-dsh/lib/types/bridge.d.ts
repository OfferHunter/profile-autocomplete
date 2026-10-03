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
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
/** One open HTTP(S) tab published by a connected browser. */
export type TabInfo = {
    id: number;
    url: string;
    title: string;
};
/** One frame's live-DOM snapshot returned by `observe`. */
export type ObserveFrame = {
    frameId: number;
    documentId: string;
    frameUrl: string;
    title: string;
    html: string;
    nodes: number;
    error?: string | null;
};
/** The bundled result of one `observe` command. */
export type ObserveResult = {
    url: string;
    title: string;
    document: string;
    snapshot: string;
    frames: ObserveFrame[];
    image: string;
    clip: Region;
    pageHeight: number;
};
/** One document-coordinate rectangle covered by a screenshot. */
export type Region = {
    x: number;
    y: number;
    width: number;
    height: number;
};
/** One element rectangle in document coordinates (`top` is false inside iframes). */
export type ElementBox = {
    x: number;
    y: number;
    width: number;
    height: number;
    top: boolean;
};
/** The readback returned by every element-targeted action. */
export type ActResult = {
    ok: boolean;
    reason?: string;
    message?: string;
    dispatched?: boolean;
    actual?: JsonValue;
    box?: ElementBox | null;
    matchedOption?: {
        value: string;
        label: string;
    };
    /** Document offset after a `scroll`. */
    scrollY?: number;
    /** Attached paths after an `upload`. */
    files?: string[];
    /** Synthesized pointer position after a trusted click or hover. */
    point?: {
        x: number;
        y: number;
    };
};
/** The result of a screenshot-only command. */
export type ShotResult = {
    image: string;
    clip: Region;
    pageHeight: number;
};
/** What the model may ask for on the next observation. */
export type ObserveView = {
    /** Crop around document row `y` (a window of the page). */
    y?: number;
    /** Crop around element address `n` in `frame`. */
    n?: number;
    frame?: number;
};
/** Listener, identity, and timing options for one {@link Bridge}. */
export interface BridgeOptions {
    host: string;
    port: number;
    /** Deadline for one extension command. Defaults to 30s. */
    commandTimeoutMs?: number;
    /** Deadline for a new connection to complete its `hello`. Defaults to 5s. */
    helloTimeoutMs?: number;
}
/**
 * Owns the loopback listener, the connected browsers, and the request/result
 * correlation for extension commands.
 */
export declare class Bridge {
    private readonly options;
    private readonly clients;
    private readonly pending;
    private readonly wss;
    private server;
    private listeningPort;
    constructor(options: BridgeOptions);
    /** The bound port (the resolved value when the configured port is 0). */
    get port(): number;
    /** Start listening and resolve once the socket is bound. */
    start(): Promise<void>;
    /** Reject every in-flight command and close the listener and clients. */
    stop(): Promise<void>;
    /**
     * Connected browsers with their currently known tabs.
     * @returns one `{ browser, tabs }` entry per connected browser.
     */
    browsers(): Array<{
        browser: string;
        tabs: TabInfo[];
    }>;
    /**
     * Find a tab by id across every connected browser (stable browser order).
     * @param tabId - the tab id reported by the extension.
     * @returns the owning browser and tab, or `undefined` when no browser has it.
     */
    findTab(tabId: number): {
        browser: string;
        tab: TabInfo;
    } | undefined;
    /**
     * Send one command to a browser and await its readback.
     * @param browser - the browser connection identity.
     * @param op - the extension operation name.
     * @param params - operation payload, spread into the command message.
     * @param signal - the tool execution signal; aborting cancels the command.
     * @param timeoutMs - per-call deadline overriding the instance default.
     * @returns the extension-provided result payload.
     */
    request(browser: string, op: string, params?: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
    private send;
    private handleUpgrade;
    private handleConnection;
    private safeSend;
}
//# sourceMappingURL=bridge.d.ts.map