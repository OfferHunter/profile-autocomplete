// chrome.* promise-style APIs carry no deadline of their own. One that never settles
// (a flaky chrome.debugger.attach, a sendMessage into a frozen renderer) would otherwise
// stall the whole command queue — see the queue in bridge.js. Race every such await
// against a timer so the await always finishes, one way or the other.
export function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms 没有响应`)), ms);
    }),
  ]).finally(() => { clearTimeout(timer); });
}
