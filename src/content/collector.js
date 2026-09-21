// 采集器：只收集信号，不判断"哪个是标签"。判断交给 LLM。
(() => {
  const PA = (window.__PA = window.__PA || {});

  const CANDIDATE_SELECTOR = [
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
    '[role="textbox"]',
    '[role="combobox"]',
    '[role="listbox"]',
    '[role="radio"]',
    '[role="checkbox"]',
    '[role="switch"]',
    '[role="spinbutton"]',
  ].join(',');

  const OVERLAY_ATTR = 'data-pa-overlay';

  // 几何搜索区，向外膨胀的像素数
  const PAD = { l: 260, r: 120, t: 40, b: 24 };
  const MAX_NEARBY = 8;

  // ---- 幂等 ID：WeakMap 保页面内身份，signature 保跨页面缓存命中 ----
  const idMap = new WeakMap();
  const byId = new Map();
  let seq = 0;

  function idFor(el) {
    let id = idMap.get(el);
    if (!id) {
      id = 'f_' + ++seq;
      idMap.set(el, id);
      byId.set(id, el);
    }
    return id;
  }

  function elementFor(id) {
    const el = byId.get(id);
    if (el && el.isConnected) return el;
    return null;
  }

  function hashString(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  // ---- 工具 ----
  function clean(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function isOverlay(el) {
    return Boolean(el.closest && el.closest(`[${OVERLAY_ATTR}]`));
  }

  // head 里的 style/title 也有文本子节点，但没有布局意义，遍历时跳过。
  // shadow root 没有 body，原样返回。
  function iterableRoot(root) {
    return root.body || root;
  }

  // 递归下钻开放的 shadow root。closed 的进不去，这是浏览器边界。
  function queryAllDeep(root, selector, out = []) {
    out.push(...root.querySelectorAll(selector));
    for (const el of iterableRoot(root).querySelectorAll('*')) {
      if (el.shadowRoot) queryAllDeep(el.shadowRoot, selector, out);
    }
    return out;
  }

  function layoutOf(el) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    // 负方向越界是典型的"无障碍隐藏"写法（left:-9999px），
    // 正方向越界只是页面在滚动，不算隐藏。
    const offscreen = r.right < 0 || r.bottom < 0;
    return {
      rect: r,
      displayNone: cs.display === 'none',
      invisible: cs.visibility === 'hidden' || cs.opacity === '0',
      zeroSize: r.width === 0 && r.height === 0,
      offscreen,
    };
  }

  // ---- 语义层：全部来自 HTML 规范，与站点无关 ----
  function getRoot(el) {
    return el.getRootNode ? el.getRootNode() : document;
  }

  function lookupById(root, id) {
    const n = root.getElementById ? root.getElementById(id) : document.getElementById(id);
    return n ? n.textContent : null;
  }

  function semanticSignals(el) {
    const root = getRoot(el);
    const labelledby = (el.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .filter(Boolean);

    let labelForText = null;
    if (el.id && root.querySelector) {
      const lb = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lb) labelForText = clean(lb.textContent);
    }

    const wrapping = el.closest && el.closest('label');
    const fieldset = el.closest && el.closest('fieldset');
    const legend = fieldset && fieldset.querySelector('legend');

    return {
      ariaLabel: clean(el.getAttribute('aria-label')) || null,
      ariaLabelledbyText: labelledby.map((i) => clean(lookupById(root, i))).filter(Boolean),
      labelForText,
      labelWrapText: wrapping ? clean(wrapping.textContent) : null,
      legendText: legend ? clean(legend.textContent) : null,
      placeholder: clean(el.getAttribute('placeholder')) || null,
      name: el.getAttribute('name') || null,
      idAttr: el.id || null,
      autocomplete: el.getAttribute('autocomplete') || null,
      required: el.required === true || el.getAttribute('aria-required') === 'true',
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      readonly: el.readOnly === true,
    };
  }

  function hasAccessibleName(sig) {
    return Boolean(
      sig.ariaLabel ||
        sig.ariaLabelledbyText.length ||
        sig.labelForText ||
        sig.labelWrapText ||
        sig.legendText
    );
  }

  // 用于签名的最佳标签（只影响缓存键，不影响发给模型的信息量）
  function bestLabel(sig) {
    return (
      sig.ariaLabelledbyText[0] ||
      sig.ariaLabel ||
      sig.labelForText ||
      sig.labelWrapText ||
      sig.legendText ||
      sig.placeholder ||
      ''
    );
  }

  function labelOf(el) {
    const root = getRoot(el);
    if (el.id && root.querySelector) {
      const l = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return clean(l.textContent);
    }
    const w = el.closest && el.closest('label');
    if (w) return clean(w.textContent);
    return clean(el.getAttribute('aria-label')) || el.value || null;
  }

  function isHidden(lay) {
    return lay.displayNone || lay.invisible || lay.zeroSize || lay.offscreen;
  }

  // ---- 可见性过滤：不能一刀切用 offsetParent === null ----
  function shouldKeep(el, sig, lay) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'hidden') return false;

    const visuallyHidden = isHidden(lay);
    if (!visuallyHidden) return true;

    if (type === 'file') return true; // 上传入口常被漂亮按钮盖住，是真实入口
    if (type === 'radio' || type === 'checkbox') return true; // 自定义单选/多选的常规实现
    if (el.getAttribute('role')) return true; // 自定义控件
    if (hasAccessibleName(sig)) return true;
    return false;
  }

  // ---- 几何层：纯几何，不读 class，不读 DOM 结构 ----
  // 一次遍历建立文本索引，避免每个字段都全文档扫描 + 强制重排
  function buildTextIndex(root) {
    const items = [];
    for (const n of iterableRoot(root).querySelectorAll('*')) {
      if (isOverlay(n)) continue;
      const hasDirectText = Array.from(n.childNodes).some(
        (c) => c.nodeType === 3 && c.textContent.trim()
      );
      if (!hasDirectText) continue;
      const text = clean(n.textContent);
      if (!text || text.length > 60) continue;
      const r = n.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      items.push({ el: n, text, r });
    }
    return items;
  }

  function relativePos(a, b) {
    const vOverlap = b.bottom > a.top && b.top < a.bottom;
    if (vOverlap) {
      return b.left + b.width / 2 < a.left + a.width / 2 ? 'left' : 'right';
    }
    return b.top + b.height / 2 < a.top + a.height / 2 ? 'above' : 'below';
  }

  function harvestNeighborhood(rect, index, self) {
    const zone = {
      l: rect.left - PAD.l,
      t: rect.top - PAD.t,
      r: rect.right + PAD.r,
      b: rect.bottom + PAD.b,
    };
    const scx = rect.left + rect.width / 2;
    const scy = rect.top + rect.height / 2;

    const hits = [];
    for (const item of index) {
      if (item.el === self) continue;
      if (item.el.contains(self) || self.contains(item.el)) continue;
      const b = item.r;
      if (b.right < zone.l || b.left > zone.r || b.bottom < zone.t || b.top > zone.b) continue;

      const dx = Math.round(b.left + b.width / 2 - scx);
      const dy = Math.round(b.top + b.height / 2 - scy);
      hits.push({ item, dx, dy, dist: Math.hypot(dx, dy) });
    }

    hits.sort((a, b) => a.dist - b.dist);

    // 只为最终入选的几条算样式，避免大面积 getComputedStyle
    return hits.slice(0, MAX_NEARBY).map(({ item, dx, dy }) => {
      const cs = getComputedStyle(item.el);
      return {
        text: item.text,
        pos: relativePos(rect, item.r),
        dx,
        dy,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
      };
    });
  }

  // 区块上下文：文档顺序上最后一个出现在本字段之前的标题
  function sectionTitleFor(el, root) {
    let best = null;
    for (const h of iterableRoot(root).querySelectorAll(
      'h1,h2,h3,h4,h5,h6,[role="heading"],legend'
    )) {
      if (h === el || h.contains(el)) continue;
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = h;
    }
    return best ? clean(best.textContent).slice(0, 60) : null;
  }

  // ---- 选项：必须拿到真实 value，这是写入所必需的 ----
  function optionsFor(el, root) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();

    if (tag === 'select') {
      return Array.from(el.options).map((o) => ({
        value: o.value,
        label: clean(o.textContent),
      }));
    }

    if (type === 'radio' && el.name) {
      const group = iterableRoot(root).querySelectorAll(
        `input[type="radio"][name="${CSS.escape(el.name)}"]`
      );
      return Array.from(group).map((r) => ({ value: r.value, label: labelOf(r) }));
    }

    if (el.getAttribute('role') === 'listbox') {
      return Array.from(iterableRoot(root).querySelectorAll('[role="option"]')).map((o) => ({
        value: o.getAttribute('data-value') || clean(o.textContent),
        label: clean(o.textContent),
      }));
    }

    return null;
  }

  function currentValueOf(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'file') return el.files && el.files.length ? `${el.files.length} file(s)` : '';
    if (tag === 'select') return el.value;
    if (type === 'checkbox' || type === 'radio') return el.checked ? el.value || 'checked' : '';
    if (el.isContentEditable) return clean(el.textContent);
    return typeof el.value === 'string' ? el.value : '';
  }

  // ---- 主流程 ----
  function collect() {
    const root = document;
    const els = queryAllDeep(root, CANDIDATE_SELECTOR).filter((el) => !isOverlay(el));
    const index = buildTextIndex(root);
    const out = [];

    for (const el of els) {
      const lay = layoutOf(el);
      const sig = semanticSignals(el);
      if (!shouldKeep(el, sig, lay)) continue;

      const r = lay.rect;
      const desc = {
        id: idFor(el),
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute('type') || '').toLowerCase() || null,
        role: el.getAttribute('role') || null,

        // 语义信号，全部保留，不做取舍
        ariaLabel: sig.ariaLabel,
        ariaLabelledbyText: sig.ariaLabelledbyText,
        labelForText: sig.labelForText,
        labelWrapText: sig.labelWrapText,
        legendText: sig.legendText,
        sectionTitle: sectionTitleFor(el, root),

        // 几何邻域：不做语义判断，只打包
        nearbyText: harvestNeighborhood(r, index, el),

        placeholder: sig.placeholder,
        name: sig.name,
        idAttr: sig.idAttr,
        autocomplete: sig.autocomplete,

        box: {
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
        },
        required: sig.required,
        disabled: sig.disabled,
        readonly: sig.readonly,
        visuallyHidden: isHidden(lay),
        options: optionsFor(el, root),
        currentValue: currentValueOf(el),
      };

      desc.signature = hashString(
        [desc.tag, desc.type, desc.name, desc.idAttr, bestLabel(sig), desc.sectionTitle].join('|')
      );

      out.push(desc);
    }

    return out;
  }

  PA.collector = { collect, idFor, elementFor, hashString, OVERLAY_ATTR, clean };
})();
