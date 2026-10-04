// content script 入口。运行在每一个 frame 里（all_frames: true），只管自己这个 document。
// 多 frame 的快照汇总与动作路由由 service worker 完成。
(() => {
  const PA = (window.__PA = window.__PA || {});

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;

    if (msg.type === 'PA_PING') {
      sendResponse({ ok: true, frameUrl: location.href, documentId: PA.documentId });
      return;
    }

    // 出快照：每个 frame 各自回报，官方去汇总成一份 per-frame 文件集。
    if (msg.type === 'PA_DOM_SNAPSHOT') {
      let payload;
      try {
        payload = PA.dom.snapshot();
      } catch (e) {
        sendResponse({ ok: false, frameUrl: location.href, error: String((e && e.stack) || e) });
        return;
      }
      // 快照本身走 runtime.sendMessage 回推：tabs.sendMessage 广播时只会采用
      // 第一个 frame 的 sendResponse，装不下多 frame 的结果。
      const sent = chrome.runtime.sendMessage({
        type: 'PA_DOM_RESULT',
        reqId: msg.reqId,
        frameUrl: location.href,
        ...payload,
      });
      if (sent && sent.catch) sent.catch(() => {});
      sendResponse({ ack: true });
      return;
    }

    // 执行动作：官方用 frameId 精确定位到某一个 frame，所以这里可以直接用返回值。
    // dispatch 可能是异步的（record_collect 要等 DOM 静默），所以统一包成 Promise 并 return true
    // 保持消息通道开启；同步动作走同一条路径，只是立刻 settle。
    if (msg.type === 'PA_ACT') {
      if (msg.documentId && msg.documentId !== PA.documentId) {
        sendResponse({ ok: true, result: { ok: false, reason: 'stale_document' } });
        return;
      }
      Promise.resolve()
        .then(() => PA.act.dispatch(msg.call))
        .then(
          result => { sendResponse({ ok: true, result }); },
          e => { sendResponse({ ok: false, error: String((e && e.stack) || e) }); },
        );
      return true;
    }
  });
})();
