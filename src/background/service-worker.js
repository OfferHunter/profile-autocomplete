// service worker 是中枢：消息路由、多 frame 汇总、以及后续的存储与 LLM 调用。
// MV3 的 SW 会被随时休眠，因此任何状态都不能只放在内存里。

const QUIET_MS = 400; // 最后一个 frame 回报后，再等这么久就收工
const HARD_MS = 3000; // 硬上限，防止某个 frame 不回报时永久挂起

chrome.runtime.onInstalled.addListener(() => {
  // 点击工具栏图标直接开侧边栏（没有 popup 时 icon 不会再触发 action.onClicked）
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

const pendingScans = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // 各 frame 主动推送的扫描结果
  if (msg.type === 'PA_SCAN_RESULT') {
    const state = pendingScans.get(msg.scanId);
    if (state) {
      if (msg.error) state.errors.push({ frameUrl: msg.frameUrl, error: msg.error });
      for (const f of msg.fields || []) {
        state.fields.push({ ...f, frameUrl: msg.frameUrl });
      }
      state.arm();
    }
    return; // 不需要回应
  }

  if (msg.type === 'PA_SCAN_TAB') {
    scanTab(msg.tabId).then(sendResponse, (e) =>
      sendResponse({ ok: false, error: String((e && e.stack) || e) })
    );
    return true; // 异步响应，保持通道打开
  }
});

async function scanTab(tabId) {
  const scanId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));

  const state = {
    fields: [],
    errors: [],
    timer: null,
    arm() {
      clearTimeout(this.timer);
      this.timer = setTimeout(finish, QUIET_MS);
    },
  };

  function finish() {
    if (!pendingScans.has(scanId)) return;
    clearTimeout(state.timer);
    pendingScans.delete(scanId);
    resolveDone();
  }

  pendingScans.set(scanId, state);
  state.timer = setTimeout(finish, HARD_MS);

  // 不带 frameId → 广播给该标签页的所有 frame
  await chrome.tabs
    .sendMessage(tabId, { type: 'PA_SCAN_COLLECT', scanId })
    .catch(() => {});
  await done;

  return {
    ok: true,
    scanId,
    fields: state.fields,
    errors: state.errors,
    noFrames: state.fields.length === 0 && state.errors.length === 0,
  };
}
