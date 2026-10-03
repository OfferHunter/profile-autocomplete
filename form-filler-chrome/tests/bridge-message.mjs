// Regression: side-panel senders may have no URL or tab; content scripts do have a tab.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { configurationError } from '../src/sidepanel/diagnostics.js';

assert.match(configurationError({ version: '0.1.0', background: { service_worker: 'worker.js' },
  permissions: ['storage'], host_permissions: ['https://api.deepseek.com/*'] }), /module.*alarms.*本地服务/);
assert.equal(configurationError(JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url)))), null);
console.log('PASS old loaded manifest diagnosed before attempting a background connection');

let listener;
let onConnect;
const noopEvent = { addListener() {} };
const chrome = {
  runtime: { id: 'test-extension', getURL: p => `chrome-extension://test-extension/${p}`, onConnect: { addListener(fn) { onConnect = fn; } },
    onMessage: { addListener(fn) { listener = fn; } } },
  tabs: { onUpdated: noopEvent, onRemoved: noopEvent },
  alarms: { onAlarm: noopEvent, create() {} },
  storage: { local: { async get() { return {}; }, async set() {} } },
};
// The bridge dials the local server on startup; the handshake is irrelevant here,
// so a stub that never fires events keeps `connect()` off the real network.
class FakeWebSocket {
  constructor() { this.readyState = 0; }
  close() {}
  send() {}
}
const bridgeSource = fs.readFileSync(new URL('../src/background/bridge.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace('export function startBridge', 'function startBridge');
// bridge.js imports this helper; the vm strips imports, so inline its body too.
const timeoutSource = fs.readFileSync(new URL('../src/background/with-timeout.js', import.meta.url), 'utf8')
  .replace('export function withTimeout', 'function withTimeout');
const source = timeoutSource + '\n' + bridgeSource;
const context = vm.createContext({ chrome, crypto, URL, WebSocket: FakeWebSocket, clearTimeout, clearInterval, setTimeout, setInterval });
await vm.runInContext(source + '\nstartBridge(() => {});', context);
const receive = sender => new Promise(resolve => listener({ type: 'PA_STATUS' }, sender, resolve));
assert.equal((await receive({ id: chrome.runtime.id })).ok, true);
assert.equal((await receive({ id: chrome.runtime.id, tab: { id: 1 }, url: chrome.runtime.getURL('src/sidepanel/sidepanel.html') })).ok, true);
assert.equal((await receive({ id: chrome.runtime.id, tab: { id: 1 }, url: 'https://example.com/' })).ok, false);
assert.equal((await receive({ id: 'other-extension' })).ok, false);
console.log('PASS side-panel sender without URL; extension tab accepted; content script rejected explicitly');

function fakePort() {
  let messageListener;
  const replies = [];
  const port = { name: 'pa-panel-v1', sender: { id: chrome.runtime.id },
    onDisconnect: noopEvent, onMessage: { addListener(fn) { messageListener = fn; } },
    postMessage(message) { replies.push(message); } };
  onConnect(port);
  return { replies, send: message => messageListener(message) };
}
// A request arriving while storage initializes must wait, not use/overwrite empty config.
let release;
chrome.storage.local.get = () => new Promise(resolve => { release = resolve; });
const starting = vm.runInContext('startBridge(() => {});', context);
const early = fakePort();
early.send({ id: 23, data: { type: 'PA_STATUS' } });
await new Promise(resolve => setImmediate(resolve));
assert.equal(early.replies.length, 0);
release({});
await starting;
await new Promise(resolve => setImmediate(resolve));
assert.equal(early.replies[0].id, 23);
assert.equal(early.replies[0].result.ok, true);

chrome.storage.local.get = async () => { throw new Error('storage unavailable'); };
await vm.runInContext('startBridge(() => {});', context).catch(() => {});
const broken = fakePort();
broken.send({ id: 24, data: { type: 'PA_STATUS' } });
await new Promise(resolve => setImmediate(resolve));
assert.equal(broken.replies[0].result.ok, false);
assert.match(broken.replies[0].result.error, /storage unavailable/);
console.log('PASS dedicated port waits for cold startup and explicitly reports initialization failures');

// Regression: one command that never settles must not block the queue forever. The
// host cancels after its own deadline; the extension has to drop that wait, advance
// the queue, and still serve the next command.
{
  const sent = [];
  class ScriptedWebSocket {
    static OPEN = 1;
    static last = null;
    constructor() { this.readyState = 1; ScriptedWebSocket.last = this; }
    close() { this.readyState = 3; }
    send(data) { sent.push(JSON.parse(data)); }
  }
  chrome.storage.local.get = async () => ({});
  chrome.tabs.get = async () => ({ id: 1, url: 'https://jobs.example.com/apply', title: 't', active: true });
  context.WebSocket = ScriptedWebSocket;

  // The collector never resolves: this command hangs inside command().
  await vm.runInContext('startBridge(() => new Promise(() => {}));', context);
  const ws = ScriptedWebSocket.last;
  const deliver = payload => ws.onmessage({ data: JSON.stringify(payload) });

  deliver({ type: 'command', id: 'hang', op: 'observe', tabId: 1, view: {} });
  await new Promise(resolve => setImmediate(resolve));
  deliver({ type: 'cancel', id: 'hang' });
  deliver({ type: 'command', id: 'next', op: 'bogus', tabId: 1 });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  const results = sent.filter(message => message.type === 'result');
  assert.ok(results.some(message => message.id === 'next' && message.ok === false),
    'the queue advanced after cancel: the second command produced a result');
  assert.ok(results.some(message => message.id === 'hang' && message.ok === false),
    'the cancelled command settled with an error instead of hanging');
  console.log('PASS a cancelled command releases the serialized queue');
}
