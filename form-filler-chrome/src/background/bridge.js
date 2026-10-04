import * as cdp from './cdp.js';
import { withTimeout } from './with-timeout.js';

const DEFAULT_URL = 'http://127.0.0.1:8765';
// 单条 chrome.tabs.sendMessage 的时限；内容脚本的 dispatch 是同步的，正常远快于此。
const CALL_TIMEOUT_MS = 15000;
// 兜底：host 自己的期限（最长 120s）才是真正的上限，这里只保证"绝不永久挂住"。
const COMMAND_BACKSTOP_MS = 180000;
let socket, reconnectTimer, heartbeat, snapshotTab;
let config = {}, connected = false, lastError = '';
const observations = new Map();
// 在途命令：id → 能让该命令"放弃等待"的 reject 句柄。promise 无法被停止，所以
// cancel 只能结束等待，不能终止 command() 本身（它会变成孤儿自生自灭）。
const aborts = new Map();
// 命令按标签页分道并行：不同标签页的操作（内容脚本 / 各自 document）互不相干，可同时跑；
// 同一标签页的命令排在同一条道里仍先后执行。唯一需要独占的是截图 —— 非前台标签页的
// captureBeyondViewport 会永不返回，所以截图的 ensureActive→抓图整段走一条全局锁，
// 避免两次截图互相把对方的标签页踢到后台。
const lanes = new Map();
let captureLock = Promise.resolve();

function send(data) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
}

async function publishTabs() {
  const tabs = (await chrome.tabs.query({})).filter(t => /^https?:/.test(t.url || ''));
  send({ type: 'tabs', tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title })) });
}

function validUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('服务地址必须是 http://127.0.0.1:端口');
  }
  return url.origin;
}

async function act(tabId, frame, documentId, call) {
  const response = await withTimeout(
    chrome.tabs.sendMessage(tabId, { type: 'PA_ACT', documentId, call }, { frameId: frame }),
    CALL_TIMEOUT_MS, 'PA_ACT',
  );
  if (!response?.ok) throw new Error(response?.error || '页面执行没有返回结果');
  return response.result;
}

// 顶层文档的当前 documentId。shot 不带快照，裁剪前需要它来做 stale_document 校验。
async function topDocumentId(tabId) {
  try {
    const response = await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: 'PA_PING' }, { frameId: 0 }),
      CALL_TIMEOUT_MS, 'PA_PING',
    );
    return response?.documentId || null;
  } catch {
    return null;
  }
}

// 截图选择：n 定向裁剪 > y 分窗 > 整页概览。任何一步失败都退到下一档，绝不让
// "确认图没取到"把一次成功的写入变成失败。
//
// 整段套全局锁：截图独占"前台标签页"（非前台标签页的 captureBeyondViewport 会永不
// 返回），并发截图会互相把对方踢到后台。不吃前台的 DOM 操作不在此锁内，可跨标签页并行。
function capture(tab, view, topDocumentId) {
  const run = captureLock.then(async () => {
    await cdp.attach(tab.id);
    try {
      let shot;
      if (view.n != null && (view.frame || 0) === 0 && topDocumentId) {
        const box = await act(tab.id, 0, topDocumentId, { op: 'box', n: view.n });
        if (box.ok && box.box && box.box.top !== false) {
          try { shot = await cdp.cropAround(tab.id, box.box); } catch { /* 退到整页 */ }
        }
      }
      if (!shot && view.y > 0) {
        const size = await cdp.contentSize(tab.id);
        shot = await cdp.region(tab.id, { x: 0, y: Math.min(view.y, Math.max(0, size.height - 1)), width: size.width, height: 2000 });
      }
      if (!shot) shot = await cdp.overview(tab.id);
      return shot;
    } finally {
      await cdp.detach(tab.id);
    }
  });
  captureLock = run.then(() => {}, () => {});
  return run;
}

// DOM 级就走 content script（在页面上下文里做，稳且少一层转义）。
const DOM_OPS = new Set(['fill', 'click', 'read', 'box', 'focus', 'hover', 'scroll']);
// scan / fill_many / record 也要在页面上下文里跑（活 DOM 的可见性与几何），且要整个 call 透传。
const ACT_OPS = new Set([...DOM_OPS, 'type', 'upload', 'scan', 'fill_many', 'record']);
// 这些动作不吃单个整数地址 n。
const NO_ADDRESS_OPS = new Set(['type', 'scan', 'fill_many', 'record']);

function domAct(tabId, frame, call) {
  return act(tabId, frame.frameId, frame.documentId, call);
}

// CDP 真实鼠标事件吃视口坐标，且只对顶层文档有效（iframe 内元素换算坐标需要跨级
// 累加 iframe 位置与滚动，跨域时拿不到）。
async function trustedPointer(tabId, frame, n, action) {
  const box = await domAct(tabId, frame, { op: 'box', n });
  if (!box.ok) return box;
  if (box.box.top === false) {
    return { ok: false, reason: 'iframe_unsupported', message: '真实鼠标事件暂不支持 iframe 内元素；先试 trusted=false 的 DOM 版本' };
  }
  await cdp.attach(tabId);
  try { return await action(tabId, box.box.viewport); }
  finally { await cdp.detach(tabId); }
}

async function typeInto(tabId, frame, call) {
  if (call.n != null) {
    const focused = await domAct(tabId, frame, { op: 'focus', n: call.n });
    if (focused.ok === false) return focused;
  }
  await cdp.attach(tabId);
  try {
    if (call.text) await cdp.typeText(tabId, call.text);
    if (call.key) await cdp.pressKey(tabId, call.key);
  } finally {
    await cdp.detach(tabId);
  }
  if (call.n != null) {
    const back = await domAct(tabId, frame, { op: 'read', n: call.n });
    return { ok: true, dispatched: true, actual: back.actual, box: back.box };
  }
  return { ok: true, dispatched: true };
}

async function uploadFile(tabId, frame, call) {
  if ((frame.frameId || 0) !== 0) {
    return { ok: false, reason: 'iframe_unsupported', message: '文件上传只支持顶层文档' };
  }
  const marked = await domAct(tabId, frame, { op: 'mark', n: call.n });
  if (!marked.ok) return marked;
  await cdp.attach(tabId);
  try {
    return await cdp.setFiles(tabId, marked.mark, call.path);
  } finally {
    try { await domAct(tabId, frame, { op: 'unmark', mark: marked.mark }); } catch { /* 页面可能已导航 */ }
    await cdp.detach(tabId);
  }
}

// 把一批操作包起来跑，只回报它们引起的 DOM 变化：arm 各 frame → 按序跑 ops → collect 各 frame。
// ops 复用 runAct 的既有分派（含 trusted 走 CDP），行为与单条操作完全一致；禁止嵌套 record。
async function recordRun(tabId, frame, call) {
  const observed = observations.get(tabId);
  if (!observed) return { ok: false, reason: 'stale_snapshot' };
  const frames = observed.frames;
  const ops = Array.isArray(call.ops) ? call.ops : [];

  const before = await topDocumentId(tabId);
  await Promise.all(frames.map(f => domAct(tabId, f, { op: 'record_arm' }).catch(() => null)));

  const results = [];
  for (const op of ops) {
    if (!op || !ACT_OPS.has(op.op) || op.op === 'record') {
      results.push({ ok: false, reason: 'bad_op', message: `record 不支持的操作 ${op && op.op}` });
      continue;
    }
    const opFrame = frames.find(f => f.frameId === (op.frame ?? frame.frameId)) ?? frame;
    try {
      results.push(await runAct(tabId, opFrame, op));
    } catch (e) {
      results.push({ ok: false, reason: 'exception', message: String((e && e.message) || e) });
    }
  }

  const collected = await Promise.all(frames.map(f => domAct(tabId, f, {
    op: 'record_collect', settleMs: call.settleMs, maxWaitMs: call.maxWaitMs, limit: call.limit,
  }).catch(e => ({ ok: false, reason: 'collect_failed', message: String((e && e.message) || e) }))));

  const after = await topDocumentId(tabId);
  const navigated = before !== null && after !== null && before !== after;
  const frameDiffs = frames.map((f, i) => ({ frameId: f.frameId, ...collected[i] }));
  return { ops: results, frames: frameDiffs, ...(navigated ? { navigated: true } : {}) };
}

async function runAct(tabId, frame, call) {
  if (call.op === 'record') return recordRun(tabId, frame, call);
  if (call.op === 'click' && call.trusted === true) return trustedPointer(tabId, frame, call.n, cdp.realClick);
  if (call.op === 'hover' && call.trusted === true) return trustedPointer(tabId, frame, call.n, cdp.moveTo);
  if (call.op === 'type') return typeInto(tabId, frame, call);
  if (call.op === 'upload') return uploadFile(tabId, frame, call);
  // scan / fill_many 原样把整个 call 交给对应 frame 的 content script。
  if (call.op === 'scan' || call.op === 'fill_many') return domAct(tabId, frame, call);
  if (DOM_OPS.has(call.op)) return domAct(tabId, frame, { op: call.op, n: call.n, value: call.value, y: call.y });
  return { ok: false, reason: 'unknown_op', message: `不认识的动作 ${call.op}` };
}

async function command(msg) {
  const tab = await withTimeout(chrome.tabs.get(msg.tabId), CALL_TIMEOUT_MS, 'chrome.tabs.get');
  if (!/^https?:/.test(tab.url || '')) throw new Error('只支持 HTTP/HTTPS 网页');
  if (msg.op === 'observe') {
    const snapshot = await snapshotTab(tab.id);
    if (!snapshot.frames.some(f => f.frameId === 0)) throw new Error('页面脚本未就绪，请刷新网页');
    const top = snapshot.frames.find(f => f.frameId === 0);
    const id = crypto.randomUUID();
    observations.set(tab.id, { id, url: tab.url, frames: snapshot.frames });
    const shot = await capture(tab, msg.view || {}, top.documentId);
    const frames = snapshot.frames.sort((a, b) => a.frameId - b.frameId);
    return { url: tab.url, title: tab.title, document: top.documentId, snapshot: id,
      frames, image: shot.data, clip: shot.clip, pageHeight: shot.pageHeight };
  }
  if (msg.op === 'shot') {
    const shot = await capture(tab, msg.view || {}, await topDocumentId(tab.id));
    return { image: shot.data, clip: shot.clip, pageHeight: shot.pageHeight || 0 };
  }
  if (msg.op === 'act') {
    const observed = observations.get(tab.id);
    if (!observed || observed.id !== msg.snapshot || observed.url !== tab.url) {
      return { ok: false, reason: 'stale_snapshot' };
    }
    const frame = observed.frames.find(f => f.frameId === (msg.frame || 0));
    if (!frame) return { ok: false, reason: 'missing_frame' };
    const call = msg.call;
    // 只认白名单动作，绝不接受 force 或页面/模型给的任意代码。
    if (!call || !ACT_OPS.has(call.op)) return { ok: false, reason: 'unknown_op', message: '不支持的动作' };
    if (!NO_ADDRESS_OPS.has(call.op) && !Number.isInteger(call.n)) {
      return { ok: false, reason: 'bad_call', message: '这个动作需要一个整数地址 n' };
    }
    return runAct(tab.id, frame, call);
  }
  throw new Error('未知浏览器命令');
}

function connect() {
  clearTimeout(reconnectTimer);
  clearInterval(heartbeat);
  if (socket) { socket.onclose = null; socket.close(); }
  connected = false;
  // 新连接起全新的命令链：上一条连接遗留的孤儿任务绝不能再堵住这条。
  lanes.clear();
  captureLock = Promise.resolve();
  const ws = new WebSocket((config.url || DEFAULT_URL).replace('http:', 'ws:') + '/bridge');
  socket = ws;
  ws.onopen = () => send({ type: 'hello', browser: config.browser });
  ws.onmessage = ({ data }) => {
    if (socket !== ws) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'ready') {
      connected = true; lastError = '';
      publishTabs().catch(() => {});
      heartbeat = setInterval(() => { send({ type: 'ping' }); publishTabs().catch(() => {}); }, 20000);
    }
    if (msg.type === 'cancel') {
      const abort = aborts.get(msg.id);
      if (abort) { aborts.delete(msg.id); abort(new Error('命令已取消')); }
    }
    if (msg.type === 'command') {
      const id = msg.id;
      let abort;
      let cancelled = false;
      const aborted = new Promise((_, reject) => { abort = (error) => { cancelled = true; reject(error); }; });
      // cancel 可能在命令还没轮到执行时就到达，此时没人 await 它，先挂一个空处理。
      aborted.catch(() => {});
      aborts.set(id, abort);
      // 每条标签页一条道：别的标签页的命令不等这条道，本标签页的仍按序。
      const lane = lanes.get(msg.tabId) ?? Promise.resolve();
      const next = lane.catch(() => {}).then(async () => {
        // 还没开跑就被取消：直接跳过，别去启动一份注定被抛弃的工作。
        if (cancelled || socket !== ws || ws.readyState !== WebSocket.OPEN) { aborts.delete(id); return; }
        let backstop;
        try {
          const result = await Promise.race([
            command(msg),
            aborted,
            new Promise((_, reject) => {
              backstop = setTimeout(() => reject(new Error('扩展侧命令兜底超时')), COMMAND_BACKSTOP_MS);
            }),
          ]);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', id, ok: true, result }));
        } catch (e) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', id, ok: false, error: e.message }));
        } finally {
          clearTimeout(backstop);
          aborts.delete(id);
        }
      });
      lanes.set(msg.tabId, next);
    }
  };
  ws.onerror = () => { lastError = '无法连接本地服务'; };
  ws.onclose = (event) => {
    connected = false;
    clearInterval(heartbeat);
    if (event.code === 1008) lastError = '连接被拒绝：浏览器身份重复或消息非法';
    observations.clear();
    aborts.clear();
    reconnectTimer = setTimeout(connect, 3000);
  };
}

async function panel(msg) {
  if (msg.type === 'PA_CONFIG') {
    config = { ...config, url: validUrl(msg.url) };
    await chrome.storage.local.set({ 'pa.bridge': config });
    connect();
    return { ok: true };
  }
  if (msg.type === 'PA_STATUS') {
    let tabs = [];
    try {
      tabs = (await chrome.tabs.query({})).filter(t => /^https?:/.test(t.url || ''))
        .map(t => ({ id: t.id, url: t.url, title: t.title }));
    } catch { /* 没有标签页权限时留空 */ }
    return { ok: true, connected, error: lastError, url: config.url || DEFAULT_URL,
      browser: config.browser, tabs };
  }
}

export function startBridge(collector) {
  snapshotTab = collector;
  let initialized;
  function isExtensionView(sender) {
    return sender.id === chrome.runtime.id && (
      !sender.tab || sender.url?.startsWith(chrome.runtime.getURL('src/sidepanel/'))
    );
  }
  async function dispatch(msg, sender) {
    if (!isExtensionView(sender)) {
      throw new Error('消息来源不是本扩展的侧边栏，请重新加载扩展并重新打开面板');
    }
    if (!['PA_CONFIG', 'PA_STATUS'].includes(msg?.type)) {
      throw new Error('不支持的侧边栏请求');
    }
    try { await initialized; }
    catch (error) { throw new Error(`扩展后台初始化失败：${error.message}`); }
    return panel(msg);
  }
  // Register synchronously, before reading storage: a panel can wake a sleeping SW.
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'pa-panel-v1') return;
    let open = true;
    port.onDisconnect.addListener(() => { open = false; });
    port.onMessage.addListener(message => {
      const reply = result => {
        if (open) {
          try { port.postMessage({ id: message.id, result }); } catch { /* panel closed */ }
        }
      };
      dispatch(message.data, port.sender).then(reply, error => reply({ ok: false, error: error.message }));
    });
  });
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!['PA_CONFIG', 'PA_STATUS'].includes(msg?.type)) return;
    dispatch(msg, sender).then(reply, e => reply({ ok: false, error: e.message }));
    return true;
  });
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (change.status === 'loading' || change.url) observations.delete(id);
    publishTabs().catch(() => {});
  });
  chrome.tabs.onRemoved.addListener(id => { observations.delete(id); lanes.delete(id); publishTabs().catch(() => {}); });
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'pa-reconnect' && !connected && socket?.readyState !== WebSocket.CONNECTING) connect();
  });
  initialized = (async () => {
    config = (await chrome.storage.local.get('pa.bridge'))['pa.bridge'] || {};
    config.browser ||= crypto.randomUUID();
    await chrome.storage.local.set({ 'pa.bridge': config });
    await chrome.alarms.create('pa-reconnect', { periodInMinutes: 1 });
    connect();
  })();
  // Initialization errors are reported through the port; avoid an unhandled rejection.
  initialized.catch(error => { lastError = `扩展后台初始化失败：${error.message}`; });
  return initialized;
}
