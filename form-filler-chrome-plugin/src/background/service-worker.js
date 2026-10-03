// Browser-only bridge. Model, knowledge and task ownership live in the DSH plugin.
import { startBridge } from './bridge.js';

const QUIET_MS = 600; // 最后一个 frame 回报后，再等这么久就收工
const HARD_MS = 8000; // 硬上限，防止某个 frame 不回报时永久挂起

chrome.runtime.onInstalled.addListener(() => {
  // 点击工具栏图标直接开侧边栏（没有 popup 时 icon 不会再触发 action.onClicked）
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

const pending = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // 各 frame 主动推送的快照
  if (msg.type === 'PA_DOM_RESULT') {
    const state = pending.get(msg.reqId);
    if (state && sender.tab?.id === state.tabId) {
      state.frames.push({
        // 顶层文档的 frameId 恒为 0，其余由 Chrome 分配。快照文件按 frameId 命名，
        // 动作也按 frameId 路由 —— 地址只在各自的 document 内有效。
        frameId: sender.frameId != null ? sender.frameId : 0,
        documentId: msg.documentId,
        frameUrl: msg.frameUrl,
        title: msg.title,
        html: msg.html,
        nodes: msg.nodes,
        error: msg.error || null,
      });
      state.arm();
    }
    return; // 不需要回应
  }

});

async function snapshotTab(tabId) {
  const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));

  const state = {
    tabId,
    frames: [],
    timer: null,
    arm() {
      clearTimeout(this.timer);
      this.timer = setTimeout(finish, QUIET_MS);
    },
  };

  function finish() {
    if (!pending.has(reqId)) return;
    clearTimeout(state.timer);
    pending.delete(reqId);
    resolveDone();
  }

  pending.set(reqId, state);
  state.timer = setTimeout(finish, HARD_MS);

  // 不带 frameId → 广播给该标签页的所有 frame。不等它的返回值：响应本来就忽略，
  // 而一条卡住的 sendMessage（渲染进程冻住）会让我们永远走不到下面的 `await done`，
  // 把整条命令队列堵死。HARD_MS 会兜住 `done`，这里只要把消息发出去。
  chrome.tabs.sendMessage(tabId, { type: 'PA_DOM_SNAPSHOT', reqId }).catch(() => {});
  await done;

  return { ok: true, reqId, frames: state.frames, noFrames: state.frames.length === 0 };
}

startBridge(snapshotTab).catch(error => console.error('Profile Autocomplete bridge startup:', error.message));
