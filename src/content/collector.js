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
    // getBoundingClientRect 是视口相对坐标，所以必须先换算到文档坐标再判越界，
    // 否则页面一滚动，视口上方的字段会全部被误判成"隐藏"。
    const absLeft = r.left + window.scrollX;
    const absTop = r.top + window.scrollY;
    const offscreen = absLeft + r.width < 0 || absTop + r.height < 0;
    return {
      rect: r,
      displayNone: cs.display === 'none',
      invisible: cs.visibility === 'hidden' || cs.opacity === '0',
      zeroSize: r.width === 0 && r.height === 0,
      offscreen,
    };
  }

  // 元素没有布局盒时（display:none / 视口外），rect 是 0,0,0,0。
  // 拿它当锚点会把搜索区画到文档原点，字段旁边的文字一个都采不到。
  // 退到最近的有盒祖先，用它的盒当锚点。
  //
  // 这个盒可能比控件大得多（一路退到整张表格行），锚点因此离控件很远，
  // 采到的邻居文字也就未必对得上 —— 此时退回 name/options 让模型自己判断。
  // （试过把锚点收成祖先左上角的一个点，那反而更差：实测量少了 6 个可真填的
  //   select 的标签。容器自身内容冒充标签的问题已由"排除控件显示中的值"解决，
  //   不再需要靠锚点躲开它。）
  function anchorRect(el, own) {
    if (own.width || own.height) return own;
    for (let n = el.parentElement; n; n = n.parentElement) {
      const r = n.getBoundingClientRect();
      if (r.width || r.height) {
        return r;
      }
    }
    return own;
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
    if (inClosedPopup(el)) return false;

    const visuallyHidden = isHidden(lay);
    if (!visuallyHidden) return true;

    if (type === 'file') return true; // 上传入口常被漂亮按钮盖住，是真实入口
    // 原生 <select> 同理：bootstrap-select 只是把它设成 opacity:0 / 0.5px 宽，
    // 可见外观换成旁边一个 button，但值仍然只能写进这个 select。
    if (el.tagName.toLowerCase() === 'select') return true;
    if (type === 'radio' || type === 'checkbox') return true; // 自定义单选/多选的常规实现
    if (el.getAttribute('role')) return true; // 自定义控件
    if (hasAccessibleName(sig)) return true;
    return false;
  }

  // 关闭状态的"选择弹层"。bootstrap-select / Element 这类组件把同一份选项渲染两遍：
  // 一遍进原生 <select>（真身），一遍进一组默认不显示的面板（连面板里的搜索框一起）。
  // 面板不是可填字段：用户看不见它，也没有"填"这个动作。
  //
  // 判据是"这一层有没有被渲染"，不是"里面有没有 role=option"。真实站点上
  // role=combobox 与 role=listbox 可能是兄弟节点，选项挂在别处；也有整个面板没有
  // 任何 option 子节点的情况。但真正的 ARIA 控件必须对用户可见才可能被填，
  // 所以"所在层不显示 + 这一层挂着这两个 role 之一"就足以判定它是关闭中的弹层。
  function inClosedPopup(el) {
    let hidden = false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') hidden = true;
      const role = n.getAttribute('role');
      if (hidden && (role === 'listbox' || role === 'combobox')) return true;
    }
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
      // 纯符号文本（表单里到处是的红色 * / ·）不含命名信息，却常常离字段更近，
      // 会把真正的标签挤出最近邻域。
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
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

  function harvestNeighborhood(rect, index, self, exclude) {
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
      if (exclude && exclude.has(item.text)) continue;
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

  // 区块标题：语义标题只是其中一种。真实站点大量用样式化的 span/div 当标题
  // （例如牛客的 <span class="section-header__title">基本信息</span>，18px/600），
  // 所以必须同时靠"视觉上更突出"这个不变量来兜底。
  const NON_HEADING_TAGS = new Set([
    'button', 'a', 'label', 'input', 'select', 'textarea', 'option',
    'script', 'style', 'noscript', 'svg', 'img', 'iframe',
  ]);

  function buildHeadingIndex(root) {
    const items = [];
    const push = (el, text, r, extra) => {
      if (r.width === 0 && r.height === 0) return;
      items.push({ el, text, r, ...extra });
    };

    // 语义标题
    for (const h of iterableRoot(root).querySelectorAll(
      'h1,h2,h3,h4,h5,h6,[role="heading"],legend'
    )) {
      const t = clean(h.textContent);
      if (!t || t.length > 60) continue;
      push(h, t, h.getBoundingClientRect(), { semantic: true, px: 0 });
    }

    // 几何兜底：字号更大或字重更粗的短文本
    for (const n of iterableRoot(root).querySelectorAll('*')) {
      if (isOverlay(n)) continue;
      if (NON_HEADING_TAGS.has(n.tagName.toLowerCase())) continue;
      if (n.closest('button,a,label,[role="button"]')) continue;
      const hasDirectText = Array.from(n.childNodes).some(
        (c) => c.nodeType === 3 && c.textContent.trim()
      );
      if (!hasDirectText) continue;
      const t = clean(n.textContent);
      if (!t || t.length > 30) continue;
      const r = n.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const cs = getComputedStyle(n);
      const px = parseFloat(cs.fontSize) || 0;
      const weight = parseInt(cs.fontWeight, 10) || 400;
      if (px < 16 && weight < 600) continue;
      push(n, t, r, { semantic: false, px });
    }

    return items;
  }

  // 取"上方最近的、视觉上突出的"那个标题。
  // 判定用的是"最近的上方"，这一点在垂直堆叠的页面上等价于"文档顺序上最后一个在本字段之前的标题"，
  // 所以距离多大都不会抓错区块 —— 上限只是为了挡掉页面最顶部的 h1 / 导航。
  function sectionTitleFor(el, rect, headings) {
    // 上限只用来挡掉页面最顶部那些跟本字段无关的 h1 / 导航。
    // 因为取的是"最近的上方"，放宽上限是安全的：真有更近的标题它会赢。
    const MAX_ABOVE = 2500;
    let best = null;

    for (const h of headings) {
      if (h.el === el || h.el.contains(el) || el.contains(h.el)) continue;
      if (h.r.bottom > rect.top + 4) continue; // 必须在字段上方
      if (rect.top - h.r.bottom > MAX_ABOVE) continue;

      // 水平方向要挨着，避免抓到侧栏 / 页脚里的标题
      const hCenter = h.r.left + h.r.width / 2;
      if (hCenter < rect.left - 600 || hCenter > rect.right + 600) continue;

      // 区块归属只看"最近的上方标题"，语义与否不参与排序。
      // 给语义标题加权会让远处的页面级 h1/h2 压过近处的真区块标题。
      if (!best || h.r.bottom > best.bottom) {
        best = { text: h.text, bottom: h.r.bottom };
      }
    }

    return best ? best.text.slice(0, 60) : null;
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

  // 全文档里每个 <select> 正在显示的那一行文字。它是"值"，不是"标签" ——
  // 哪怕它出现在另一个字段旁边，也仍然是某个控件在显示自己的值。
  // 省/市/区三联下拉是典型：只有选中省之后市才有真选项，未选中时三个都显示占位文字，
  // 而占位文字离邻居比邻居自己的真标签还近，于是互相冒充标签（实测「*籍贯」
  // 「*目前所在地」被邻居的"请选择市"顶掉，两个 required 字段因此无名）。
  function shownSelectValues(root) {
    const set = new Set();
    for (const s of queryAllDeep(root, 'select')) {
      const sel = s.selectedOptions && s.selectedOptions[0];
      const t = sel && clean(sel.textContent);
      if (t) set.add(t);
    }
    return set;
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
    const headings = buildHeadingIndex(root);
    const shownValues = shownSelectValues(root);
    const out = [];

    for (const el of els) {
      const lay = layoutOf(el);
      const sig = semanticSignals(el);
      if (!shouldKeep(el, sig, lay)) continue;

      const r = lay.rect;
      const anchor = anchorRect(el, r);
      const options = optionsFor(el, root);
      // 控件"正在显示的文字"不是标签，全排除掉：自己的全部选项（bootstrap-select
      // 把占位文字"请选择"画在旁边的可见代理上，离字段比真标签更近 —— 实测 21 个
      // 字段的标签退化成"请选择"），加上 shownValues（邻居下拉正在显示的值，见上）。
      const exclude = new Set(shownValues);
      if (options) for (const o of options) exclude.add(o.label);
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
        sectionTitle: sectionTitleFor(el, anchor, headings),

        // 几何邻域：不做语义判断，只打包
        nearbyText: harvestNeighborhood(anchor, index, el, exclude),

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
        options,
        currentValue: currentValueOf(el),
      };

      desc.signature = hashString(
        [desc.tag, desc.type, desc.name, desc.idAttr, bestLabel(sig), desc.sectionTitle].join('|')
      );

      out.push(desc);
    }

    return out;
  }

  // 诊断用：列出被过滤掉的候选元素及原因。
  // 排查"某个字段没被采到"时用，不影响 collect() 的正常路径。
  function rejectReason(el, sig, lay) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'hidden') return 'type=hidden';
    if (inClosedPopup(el)) return '在关闭的选择弹层内（真身是旁边的原生 select）';

    const parts = [];
    if (lay.displayNone) parts.push('display:none');
    if (lay.invisible) parts.push('visibility:hidden/opacity:0');
    if (lay.zeroSize) parts.push('零尺寸');
    if (lay.offscreen) parts.push('负方向越界');
    if (!parts.length) return '原因未知';
    return parts.join(' + ') + '，且无 label/aria/role';
  }

  function explain() {
    const els = queryAllDeep(document, CANDIDATE_SELECTOR).filter((el) => !isOverlay(el));
    const out = [];
    for (const el of els) {
      const lay = layoutOf(el);
      const sig = semanticSignals(el);
      if (shouldKeep(el, sig, lay)) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute('type') || '').toLowerCase() || null,
        name: el.getAttribute('name'),
        id: el.id || null,
        ariaLabel: sig.ariaLabel,
        size: `${Math.round(lay.rect.width)}x${Math.round(lay.rect.height)}`,
        reason: rejectReason(el, sig, lay),
      });
    }
    return out;
  }

  PA.collector = { collect, explain, idFor, elementFor, hashString, OVERLAY_ATTR, clean };
})();
