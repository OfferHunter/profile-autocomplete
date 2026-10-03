import { configurationError } from './diagnostics.js';

// Dedicated panel/background channel: every request has exactly one explicit reply.
// runtime.sendMessage broadcasts to other extension listeners as well, so it is not
// suitable for distinguishing an empty reply from a background startup failure.
let port = null;
let seq = 0;
const pending = new Map();

function connect() {
  const problem = configurationError(chrome.runtime.getManifest());
  if (problem) throw new Error(problem);
  if (port) return port;
  const current = chrome.runtime.connect({ name: 'pa-panel-v1' });
  port = current;
  current.onMessage.addListener(message => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.result?.ok) request.resolve(message.result);
    else request.reject(new Error(message.result?.error || '扩展后台返回了无效响应'));
  });
  current.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message || '扩展后台连接已断开';
    if (port !== current) return;
    port = null;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`${reason}。面板将在下次刷新时重新连接；若扩展刚更新，请关闭并重新打开侧边栏。`));
    }
    pending.clear();
  });
  return current;
}

export function send(data) {
  return new Promise((resolve, reject) => {
    let channel;
    try { channel = connect(); }
    catch (error) { reject(new Error(`扩展连接失败：${error.message}`)); return; }
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('扩展后台 15 秒未响应。请查看扩展管理页中 service worker 的错误。'));
      if (port === channel) { channel.disconnect(); port = null; }
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    try { channel.postMessage({ id, data }); }
    catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      port = null;
      reject(new Error(`扩展消息发送失败：${error.message}`));
    }
  });
}
