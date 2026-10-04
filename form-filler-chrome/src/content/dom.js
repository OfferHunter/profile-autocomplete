// 页面侧的「读」：把活 DOM 序列化成一份可读的、带地址的冻结快照。
//
// 这里没有任何筛选、判断或启发式 —— 不决定"什么算字段"，不猜标签，不做语义归并。
// 它只做两件事：给每个元素一个可被引用的地址（data-pa-n），把此刻的真实 DOM 写出来。
// 哪些元素该填、填什么，全部交给 VLM。
//
// 快照不写回页面：data-pa-n 是**输出文本**，不是落到第三方页面上的属性。
// 地址→元素的对应关系留在本模块的 Map 里，页面 DOM 一个字节都不改。
(() => {
  const PA = (window.__PA = window.__PA || {});
  PA.documentId = PA.documentId || crypto.randomUUID();

  const N_ATTR = 'data-pa-n';

  // 这些元素的内容对填表没有意义，却是页面上最大的文本块（内联脚本/样式/SVG 路径），
  // 留着会让整份快照被它们淹没。保留标签本身，内容省略。
  const OMIT_CONTENT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'MATH']);

  const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);

  // ---- 地址分配：单调、不复用、跨快照稳定 ----
  // 页面动态插入节点时，老元素的号码必须保持不变，否则模型上一轮读到的地址
  // 下一轮就指向别的元素了。
  const numOf = new WeakMap();
  const byNum = new Map();
  let seq = 0;

  function nFor(el) {
    let n = numOf.get(el);
    if (n === undefined) {
      n = ++seq;
      numOf.set(el, n);
      byNum.set(n, el);
    }
    return n;
  }

  function elementFor(n) {
    const el = byNum.get(Number(n));
    // 元素被 React 之类的框架换掉后就不再连接，此时地址失效 —— 返回 null 让调用方
    // 重新快照，而不是拿着一个陈旧节点继续操作。
    return el && el.isConnected ? el : null;
  }

  // 只读查询：元素是否已经有过地址。与 nFor 不同，它**不分配**新地址 ——
  // 被移除的节点若从没进过快照，给它一个新号码毫无意义（模型从没见过它）。
  function numIfKnown(el) {
    return numOf.get(el);
  }

  // ---- 序列化 ----

  function escText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 快照要反映"此刻页面上的真实状态"，而不只是 HTML 里写死的属性：
  // 文本框当前的值、复选框勾没勾，都不出现在 outerHTML 里，但对填表是决定性的
  // （既用来判断要不要填，也是"用户已经改过这个字段"的证据）。
  function liveAttrs(el) {
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return el.checked ? ['checked'] : [];
      if (t === 'file') return [];
      return el.value ? [`value="${escAttr(el.value)}"`] : [];
    }
    if (tag === 'TEXTAREA') return el.value ? [`value="${escAttr(el.value)}"`] : [];
    if (tag === 'OPTION') return el.selected ? ['selected'] : [];
    if (tag === 'SELECT') return el.value ? [`data-pa-value="${escAttr(el.value)}"`] : [];
    return [];
  }

  function openTag(el) {
    const tag = el.tagName.toLowerCase();
    const parts = [];
    const seen = new Set();
    for (const a of el.attributes) {
      if (a.name === N_ATTR) continue;
      // Live properties override stale HTML defaults, including transitions to empty/unchecked.
      if (((el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['radio', 'checkbox', 'file'].includes(el.type))) && a.name === 'value') ||
          (el.tagName === 'INPUT' && a.name === 'checked') ||
          (el.tagName === 'OPTION' && a.name === 'selected') || a.name === 'data-pa-value') continue;
      seen.add(a.name);
      parts.push(a.value === '' ? a.name : `${a.name}="${escAttr(a.value)}"`);
    }
    // 此刻的真实状态跟在后面（别与 HTML 里写死的同名属性重复）。
    for (const s of liveAttrs(el)) {
      const name = s.split('=')[0];
      if (!seen.has(name)) parts.push(s);
    }
    // 地址永远排在最前，且永远存在 —— 它是操作工具的唯一入口。
    parts.unshift(`${N_ATTR}="${nFor(el)}"`);
    return `<${tag} ${parts.join(' ')}>`;
  }

  function textOf(el) {
    if (el.tagName === 'TEXTAREA') return el.value;
    let t = '';
    for (const c of el.childNodes) if (c.nodeType === 3) t += c.nodeValue;
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }

  function elementChildren(el) {
    const out = [];
    for (const c of el.childNodes) if (c.nodeType === 1) out.push(c);
    return out;
  }

  function serialize(root) {
    const lines = [];
    let nodes = 0;

    const push = (s, depth) => lines.push('  '.repeat(depth) + s);

    function walk(el, depth) {
      nodes++;

      const tag = el.tagName.toLowerCase();
      const open = openTag(el);

      if (OMIT_CONTENT.has(el.tagName)) {
        push(VOID_TAGS.has(tag) ? open : `${open}…</${tag}>`, depth);
        return;
      }

      const kids = elementChildren(el);
      const shadow = el.shadowRoot;
      const t = textOf(el);

      if (VOID_TAGS.has(tag)) {
        push(open, depth);
        return;
      }

      // 无子元素、无影子树、无文字：单行闭合。
      if (!kids.length && !shadow && !t) {
        push(`${open}</${tag}>`, depth);
        return;
      }
      // 只有文字：也压成一行，可读性最好。
      if (!kids.length && !shadow) {
        push(`${open}${escText(t)}</${tag}>`, depth);
        return;
      }

      push(open, depth);
      if (t) push(escText(t), depth + 1);

      // 开放的 shadow root：内容不在 outerHTML 里，直接吞掉会让一整片字段
      // 在快照里凭空消失。用注释标出边界，内容照常带地址。
      if (shadow) {
        push('<!-- shadow-root (open) -->', depth + 1);
        for (const c of shadow.childNodes) {
          if (c.nodeType === 1) walk(c, depth + 2);
          else if (c.nodeType === 3 && c.nodeValue.trim()) push(escText(c.nodeValue.replace(/\s+/g, ' ').trim()), depth + 2);
        }
      }

      for (const k of kids) walk(k, depth + 1);
      push(`</${tag}>`, depth);
    }

    walk(root === document ? document.documentElement : root, 0);

    return { text: lines.join('\n'), nodes };
  }

  function header() {
    return [
      '<!-- Profile Autocomplete DOM 快照',
      `     url: ${location.href}`,
      `     time: ${new Date().toISOString()}`,
      '     每个元素都带 data-pa-n="N"。N 就是操作时用来指认元素的地址（fill/click 的 n）。',
      '     文本框的 value 与勾选状态是"此刻页面上的真实状态"，与 HTML 里写死的属性可能不同。',
      '     <script>/<style>/<svg> 的内容已省略。',
      '-->',
    ].join('\n');
  }

  function snapshot() {
    const { text, nodes } = serialize(document);
    return {
      documentId: PA.documentId,
      html: header() + '\n' + text,
      frameUrl: location.href,
      title: document.title,
      nodes,
    };
  }

  PA.dom = { snapshot, serialize, elementFor, nFor, numIfKnown, N_ATTR };
})();
