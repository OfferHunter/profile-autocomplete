// content script 入口。运行在每一个 frame 里（all_frames: true），
// 只扫自己这个 document，多 frame 汇总由 service worker 完成。
(() => {
  const PA = (window.__PA = window.__PA || {});

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'PA_SCAN_COLLECT') return;

    let fields = [];
    let error = null;
    try {
      fields = PA.collector.collect();
    } catch (e) {
      error = String((e && e.stack) || e);
    }

    // 结果走 runtime.sendMessage 推送，不依赖 sendResponse ——
    // tabs.sendMessage 广播时只会采用第一个 frame 的 sendResponse。
    const sent = chrome.runtime.sendMessage({
      type: 'PA_SCAN_RESULT',
      scanId: msg.scanId,
      frameUrl: location.href,
      fields,
      error,
    });
    if (sent && sent.catch) sent.catch(() => {});

    sendResponse({ ack: true });
  });
})();
