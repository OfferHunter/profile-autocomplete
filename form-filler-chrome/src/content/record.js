// 页面侧的「批内差分」：把一批操作前后引起的 DOM 变化如实回报，供模型直接读。
//
// 不是常驻观察器：arm 时起、collect 后停，窗口由这批操作自己界定。也不做任何本地裁决 ——
// 不判断"什么算选项""哪个变化重要"，只回报"哪些子树是新插进来的、哪些元素的属性变了"，
// 由模型判断。序列化一律走 dom.js（与 form_observe 同一套 data-pa-n 地址与实时状态）。
(() => {
  const PA = (window.__PA = window.__PA || {});

  // 窗口内的记录上限，防一次操作引发变更风暴把内存撑爆（例如整页重渲染）。
  const CAP = 4000;
  // changed 桶里，子树过大的目标（body/html 之类的容器被加了 class）只报地址与改动属性名，
  // 不序列化整棵子树 —— 否则一个 body 的 class 变化会把整页 DOM 全带出来。
  const MAX_ELEM_NODES = 1500;

  const DEFAULT_SETTLE = 300;
  const DEFAULT_MAX_WAIT = 2000;
  const DEFAULT_LIMIT = 40000;

  const ATTRIBUTE_FILTER = ['style', 'class', 'hidden', 'aria-expanded', 'aria-hidden'];

  let observer = null;
  let added = null;    // Set<Element>：新插入的元素
  let changed = null;  // Map<Element, Set<string>>：属性变更目标 → 改动的属性名
  let lastMutationAt = 0;

  function arm() {
    if (observer) observer.disconnect();
    added = new Set();
    changed = new Map();
    lastMutationAt = performance.now();
    observer = new MutationObserver(records => {
      lastMutationAt = performance.now();
      for (const r of records) {
        if (r.type === 'childList') {
          for (const node of r.addedNodes) {
            if (node.nodeType === 1 && added.size < CAP) added.add(node);
          }
        } else if (r.type === 'attributes') {
          let names = changed.get(r.target);
          if (names === undefined) {
            if (changed.size >= CAP) continue;
            names = new Set();
            changed.set(r.target, names);
          }
          names.add(r.attributeName);
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ATTRIBUTE_FILTER,
    });
    return { ok: true };
  }

  const wait = ms => new Promise(resolve => { setTimeout(resolve, ms) });

  // 等 DOM 静默：距最后一次变更 >= settleMs 即收；到 maxWaitMs 强制收（永动动画页面兜底）。
  async function settle(settleMs, maxWaitMs) {
    const start = performance.now();
    while (true) {
      const now = performance.now();
      if (now - lastMutationAt >= settleMs) return;
      if (now - start >= maxWaitMs) return;
      await wait(Math.min(100, settleMs || 100));
    }
  }

  // 去掉祖先也在集合里的节点，只留最外层的若干个根。
  function topMost(nodes, set) {
    return nodes.filter(node => {
      let p = node.parentElement;
      while (p) { if (set.has(p)) return false; p = p.parentElement }
      return true;
    });
  }

  async function collect(options = {}) {
    if (observer === null) return { ok: false, reason: 'not_armed', message: 'record_collect 前未先 record_arm' };

    const settleMs = Number.isFinite(options.settleMs) ? Math.max(0, options.settleMs) : DEFAULT_SETTLE;
    const maxWaitMs = Number.isFinite(options.maxWaitMs) ? Math.max(0, options.maxWaitMs) : DEFAULT_MAX_WAIT;
    const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : DEFAULT_LIMIT;

    await settle(settleMs, maxWaitMs);
    observer.disconnect();
    observer = null;

    const addedList = [...added].filter(node => node.isConnected);
    const addedSet = new Set(addedList);
    const roots = topMost(addedList, addedSet);

    const changedEls = [];
    for (const [el, names] of changed) {
      if (!el.isConnected || addedSet.has(el)) continue;
      let insideAdded = false;
      let p = el.parentElement;
      while (p) { if (addedSet.has(p)) { insideAdded = true; break } p = p.parentElement }
      if (insideAdded) continue;
      changedEls.push([el, [...names]]);
    }

    let budget = limit;
    let truncated = false;

    const outAdded = [];
    for (const node of roots) {
      const { text } = PA.dom.serialize(node);
      if (text.length > budget) { truncated = true; break }
      budget -= text.length;
      outAdded.push({ n: PA.dom.nFor(node), tag: node.tagName.toLowerCase(), html: text });
    }

    const outChanged = [];
    for (const [el, names] of changedEls) {
      const entry = { n: PA.dom.nFor(el), tag: el.tagName.toLowerCase(), changes: names };
      if (el.querySelectorAll('*').length > MAX_ELEM_NODES) {
        outChanged.push(entry); // 容器级改动（如 body 的 class）：只报地址与属性名，不序列化整棵子树
        continue;
      }
      const { text } = PA.dom.serialize(el);
      if (text.length > budget) { truncated = true; break }
      budget -= text.length;
      outChanged.push({ ...entry, html: text });
    }

    return { ok: true, added: outAdded, changed: outChanged, truncated };
  }

  PA.record = { arm, collect };
})();
