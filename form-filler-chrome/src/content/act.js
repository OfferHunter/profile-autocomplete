// 页面侧的「写」：把地址（data-pa-n）解析成元素，施加动作，然后回读真实结果。
//
// 回读不是可选步骤：受控组件、自定义控件、被网站 JS 拒绝的写入，全都表现为
// "看起来填了、其实没进去"。只有回读能区分这两者，所以每个动作都返回实际状态。
(() => {
  const PA = (window.__PA = window.__PA || {});
  const isPlaceholder = value => /^(请选择.*|请选.*|选择[.。…]*|please select.*|select[.。…]*|--.*--)$/i.test(norm(value));

  function resolve(n) {
    const el = PA.dom.elementFor(n);
    if (!el) return { error: `地址 ${n} 已失效（元素已被页面替换或移除），请重新读取快照` };
    return { el };
  }

  function describe(el) {
    return {
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute('type') || '').toLowerCase() || null,
      role: el.getAttribute('role') || null,
      idAttr: el.id || null,
    };
  }

  // 当前状态的统一读法。三种控件三种读法，但对外只暴露一个形状。
  function baseState(el) {
    const tag = el.tagName;
    const base = { ...describe(el) };
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return { ...base, checked: el.checked, value: el.value };
      return { ...base, value: el.value };
    }
    if (tag === 'TEXTAREA') return { ...base, value: el.value };
    if (tag === 'SELECT') {
      const sel = el.selectedOptions && el.selectedOptions[0];
      return {
        ...base,
        value: el.value,
        selectedText: sel ? (sel.textContent || '').trim() : '',
        options: [...el.options].map((o) => ({ value: o.value, label: (o.textContent || '').trim(), disabled: o.disabled })),
      };
    }
    if (el.isContentEditable) return { ...base, value: (el.textContent || '').trim() };
    return { ...base, value: (el.textContent || '').trim(), text: (el.textContent || '').trim().slice(0, 200) };
  }

  // 是不是一个"浮层选择控件"（自定义下拉/级联/虚拟列表）。只有这类元素才去解析
  // 活动项——普通文本框读法一个字不变、零额外开销。判定全按 ARIA，不做任何猜测。
  function popupish(el) {
    if (el.getAttribute('aria-activedescendant')) return true;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'combobox' || role === 'listbox') return true;
    return !!(el.closest && el.closest('[role=combobox],[role=listbox],[aria-activedescendant]'));
  }

  // 按 id 取节点。id 可能不是合法选择器，所以优先用 getElementById（不做选择器解析）。
  function byId(el, id) {
    const root = el.getRootNode ? el.getRootNode() : document;
    try { if (root.getElementById) { const o = root.getElementById(id); if (o) return o; } } catch { /* shadow 根没有 getElementById */ }
    try { return document.getElementById(id); } catch { return null; }
  }

  function optionInfo(o) {
    return {
      id: o.id || null,
      text: norm(o.textContent).slice(0, 200),
      ...(PA.dom && typeof PA.dom.nFor === 'function' ? { n: PA.dom.nFor(o) } : {}),
    };
  }

  // 键盘导航下"当前高亮的是哪一项"。焦点留在 combobox 上，高亮项靠
  // aria-activedescendant 指向的 id 标记（每按一次方向键就换一个 id）——这是页面
  // 自己写的事实，本地只是把它翻译成文字，不猜、不裁决。主通道认这个属性（自身或
  // 邻近祖先上），兜底认 listbox 里 aria-selected=true 的项；都没有则返回 null。
  function activeOptionOf(el) {
    let scope = el;
    for (let hops = 0; scope && hops < 6; scope = scope.parentElement, hops++) {
      const ad = scope.getAttribute && scope.getAttribute('aria-activedescendant');
      if (ad) {
        const o = byId(el, ad);
        if (o) return optionInfo(o);
      }
    }
    const role = (el.getAttribute('role') || '').toLowerCase();
    const listbox = role === 'listbox' ? el : (el.querySelector ? el.querySelector('[role=listbox]') : null);
    const holder = listbox || el;
    const selected = holder.querySelector ? holder.querySelector('[role=option][aria-selected=true]') : null;
    return selected ? optionInfo(selected) : null;
  }

  // 对外统一读法：在基础状态上，给浮层控件补一个 activeOption。三种控件三种读法
  // 的形状不变，只是列表类多带"停在第几项"。
  function readState(el) {
    const st = baseState(el);
    if (popupish(el)) {
      const active = activeOptionOf(el);
      if (active) return { ...st, activeOption: active };
    }
    return st;
  }

  // 该元素中心点实际命中谁：把"点了等于没点"从静默失败变成可诊断结果。目标被弹窗
  // 遮罩盖住、或元素本身零尺寸/被幽灵定位（虚拟列表用超大负偏移测量）时，
  // hitsTarget 会是 false。在元素自己的 frame 里跑，坐标即该 frame 的视口坐标。
  function hitTest(el) {
    const r = el.getBoundingClientRect();
    const p = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    // 优先在元素自己的根节点里测命中：shadow root 内用顶层 document 测会被重定向到宿主，
    // 从而把"点中了内部节点"误判成"没命中"。
    const root = el.getRootNode ? el.getRootNode() : document;
    let hit = null;
    try {
      hit = root.elementFromPoint ? root.elementFromPoint(p.x, p.y) : document.elementFromPoint(p.x, p.y);
    } catch { /* 分离节点或坐标非法 */ }
    const hitsTarget = !!(hit && (hit === el || el.contains(hit) || hit.contains(el)));
    return {
      hitsTarget,
      hit: hit ? {
        tag: hit.tagName.toLowerCase(),
        id: hit.id || null,
        text: norm(hit.textContent).slice(0, 80),
        ...(PA.dom && typeof PA.dom.nFor === 'function' ? { n: PA.dom.nFor(hit) } : {}),
      } : null,
    };
  }

  // React 等框架在 value 上装了 setter，直接 `el.value = v` 会被它自己的渲染流程
  // 覆盖掉。必须绕过实例、走原型上的原生 setter，再派发 input/change 让框架同步。
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 元素在**文档坐标**里的位置，给 CDP 裁剪用。
  // 注意不是 getBoundingClientRect 的视口坐标 —— Page.captureScreenshot 的 clip 吃文档坐标，
  // 少加这一次 scroll 就会在滚动过的页面上裁到错误的区域。
  function boxOf(el) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null; // display:none 之类，没有可裁的东西
    return {
      x: r.left + window.scrollX,
      y: r.top + window.scrollY,
      width: r.width,
      height: r.height,
      // 视口坐标给 CDP 的鼠标事件用（Input.dispatchMouseEvent 吃的是视口坐标，
      // 不是文档坐标）。
      viewport: { x: r.left, y: r.top, width: r.width, height: r.height },
      // 裁剪只在顶层文档做。iframe 内的元素拿到的是它自己 document 的坐标，
      // 换算到顶层要叠加各级 iframe 的位置与滚动 —— 跨域时根本拿不到，猜错会裁到
      // 别的字段上（比裁不出来更糟：模型会自信地读错标签）。所以这里如实标注。
      top: window === window.top,
    };
  }

  function norm(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  // 选项匹配。模型在快照里看得见 <option> 的文字，所以它给的候选通常就是原文；
  // 这里只做无歧义的兜底（空白归一、大小写、唯一包含），绝不猜。
  function matchOption(el, wanted) {
    const opts = [...el.options];
    const w = norm(wanted);
    const wl = w.toLowerCase();
    const usable = (o) => !o.disabled && norm(o.value);

    let hit = opts.find((o) => usable(o) && o.value === wanted);
    if (!hit) hit = opts.find((o) => usable(o) && norm(o.value) === w);
    if (!hit) hit = opts.find((o) => norm(o.textContent) === w);
    if (!hit) hit = opts.find((o) => usable(o) && norm(o.value).toLowerCase() === wl);
    if (!hit) hit = opts.find((o) => norm(o.textContent).toLowerCase() === wl);
    if (!hit) {
      // 包含匹配只在唯一命中时才认，否则宁可不填。
      const loose = opts.filter((o) => usable(o) && (norm(o.textContent).includes(w) || w.includes(norm(o.textContent))) && w);
      if (loose.length === 1) hit = loose[0];
    }
    return hit || null;
  }

  function selectOption(el, wanted) {
    const hit = matchOption(el, wanted);
    if (!hit) {
      return {
        ok: false,
        reason: 'no_option_match',
        message: '下拉里没有能唯一确定匹配的选项，请从 options 里挑一个准确的 label 重试。',
        actual: readState(el),
      };
    }
    el.value = hit.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const after = readState(el);
    return {
      ok: norm(after.value) === norm(hit.value),
      matchedOption: { value: hit.value, label: norm(hit.textContent) },
      actual: after,
    };
  }

  // 一个元素"当前是否已经有内容"的统一判据。
  // 注意 radio/checkbox：它们的 value 是 HTML 里写死的选项值（"female"），
  // 永远非空，拿它当"有内容"会导致单选框永远无法被填。这类控件的状态是 checked。
  function stateValue(el) {
    const tag = el.tagName;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) return el.checked ? 'on' : '';
    if (tag === 'SELECT') {
      const option = el.selectedOptions[0];
      if (!option || option.disabled || isPlaceholder(option.textContent)) return '';
    }
    if (el.isContentEditable) return (el.textContent || '').trim();
    return el.value;
  }

  function applyValue(el, value) {
    const tag = el.tagName;
    const type = (el.getAttribute('type') || '').toLowerCase();

    if (tag === 'SELECT') return selectOption(el, value);

    if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) {
      // 勾选/取消走 click()：改 checked 属性不会触发网站自己的监听。
      const want = value === true || value === 'true' || value === '1' || value === 'on' || value === 'yes';
      if (el.checked !== want) el.click();
      const after = readState(el);
      return { ok: after.checked === want, actual: after };
    }

    if (el.isContentEditable) {
      el.focus();
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      const after = readState(el);
      return { ok: norm(after.value) === norm(value), actual: after };
    }

    setNativeValue(el, value);
    const after = readState(el);
    // 回读是判据：有些站点会立刻把不合法的输入清掉，写进去了也不代表生效。
    const ok = norm(after.value) === norm(value);
    return {
      ok,
      actual: after,
      ...(ok ? {} : { reason: 'readback_mismatch', message: '写入后被页面改掉或清空了 —— 很可能是格式校验拒绝了这个值。' }),
    };
  }

  function fill(n, value) {
    const r = resolve(n);
    if (r.error) return { ok: false, reason: 'stale_address', message: r.error };

    const el = r.el;
    {
      if (!(el.matches('input,textarea,select') || el.isContentEditable) ||
          el.matches('input[type=hidden],input[type=file],input[type=submit],input[type=button],input[type=reset],input[type=image]') ||
          el.matches(':disabled,[aria-disabled=true]') || el.readOnly || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') {
        return { ok: false, reason: 'unsupported_or_disabled' };
      }
      const group = el.type === 'radio' && el.name
        ? [...el.getRootNode().querySelectorAll('input[type=radio]')].some(x => x.name === el.name && x.form === el.form && x.checked)
        : false;
      if (norm(stateValue(el)) || group) {
        return { ok: false, reason: 'already_filled', actual: readState(el) };
      }
    }
    let out;
    try {
      out = applyValue(el, value);
    } catch (e) {
      return { ok: false, reason: 'exception', message: String((e && e.message) || e) };
    }
    // 顺带把位置带回去：宿主每次填完都要裁一张这个字段的图让模型当场确认，
    // 单独再问一次坐标就是白多一个来回。
    return { ...out, box: boxOf(el) };
  }

  // 批量写入：一条命令在页面内连续写多个控件，省去逐字段的往返。
  // 逐个复用 fill()，因此守卫（stale 地址、unsupported/disabled、already_filled、写后回读）
  // 完全一致 —— 只是把每项的 box 丢掉保持精简，批量窗口不需要它。
  function fillMany(items) {
    const results = [];
    for (const item of (Array.isArray(items) ? items : [])) {
      let r;
      try {
        r = fill(item && item.n, item && item.value);
      } catch (e) {
        r = { ok: false, reason: 'exception', message: String((e && e.message) || e) };
      }
      const rest = { ...(r || { ok: false }) };
      delete rest.box; // 批量窗口不需要逐项坐标
      results.push({ n: item && item.n, ...rest });
    }
    return { ok: true, results };
  }

  function click(n) {
    const r = resolve(n);
    if (r.error) return { ok: false, reason: 'stale_address', message: r.error };
    const el = r.el;
    // Click is a general DOM action. Only reject targets the browser cannot interact with.
    if (el.matches(':disabled,[aria-disabled=true]') || el.closest('[inert]') ||
        !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') {
      return { ok: false, reason: 'not_interactable', message: '目标元素不可见或已禁用' };
    }
    try {
      // 先滚动到视野内再点：scrollIntoView 会改变 scrollY，所以 box 必须在点完之后再取。
      r.el.scrollIntoView({ block: 'center' });
      // 命中自校验在点击前做：点击可能关掉浮层，事后再测就把"点中了"误报成"没点中"。
      const hit = hitTest(r.el);
      if (typeof r.el.click === 'function') r.el.click();
      else r.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window }));
      return { ok: true, dispatched: true, actual: readState(r.el), box: boxOf(r.el), ...hit };
    } catch (e) {
      return { ok: false, reason: 'exception', message: String((e && e.message) || e) };
    }
  }

  // 单独取位置：read_field_region 要对任意元素裁图，不限于刚填过的那个。
  function box(n) {
    const r = resolve(n);
    if (r.error) return { ok: false, reason: 'stale_address', message: r.error };
    const b = boxOf(r.el);
    if (!b) return { ok: false, reason: 'no_box', message: '该元素没有可见尺寸（display:none 或尚未渲染），裁不出图。' };
    return { ok: true, box: b };
  }

  function read(n) {
    const r = resolve(n);
    if (r.error) return { ok: false, reason: 'stale_address', message: r.error };
    return { ok: true, actual: readState(r.el) };
  }

  // 聚焦：真实键入（CDP Input.insertText）只会进到当前焦点，所以先在这里把焦点
  // 落到目标元素上，再让宿主去 insertText。
  function focus(n) {
    const r = resolve(n);
    if (r.error) return { ok: false, reason: 'stale_address', message: r.error };
    try {
      r.el.scrollIntoView({ block: 'center' });
      if (typeof r.el.focus === 'function') r.el.focus({ preventScroll: true });
      return { ok: document.activeElement === r.el || r.el.contains(document.activeElement), box: boxOf(r.el) };
    } catch (e) {
      return { ok: false, reason: 'exception', message: String((e && e.message) || e) };
    }
  }

  // 悬停：目录/提示类菜单只对鼠标事件反应。这里派发 DOM 级的 mouseover/enter/move；
  // 需要 isTrusted 的控件由宿主改走 CDP 真实移动（call.trusted）。
  function hover(n) {
    const r = resolve(n);
    if (r.error) return { ok: false, reason: 'stale_address', message: r.error };
    const el = r.el;
    if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') {
      return { ok: false, reason: 'not_interactable', message: '目标元素不可见' };
    }
    try {
      const box = boxOf(el);
      const point = { clientX: box.viewport.x + box.viewport.width / 2, clientY: box.viewport.y + box.viewport.height / 2 };
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window, ...point }));
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: false, view: window, ...point }));
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window, ...point }));
      return { ok: true, dispatched: true, box };
    } catch (e) {
      return { ok: false, reason: 'exception', message: String((e && e.message) || e) };
    }
  }

  // 元素自身/最近祖先里那个真正可滚的容器（虚拟列表的 holder）。窗口滚动不算。
  function scrollContainerOf(el) {
    for (let e = el; e; e = e.parentElement) {
      let cs;
      try { cs = getComputedStyle(e); } catch { break; }
      if (e.scrollHeight - e.clientHeight > 1 && /(auto|scroll|overlay)/.test(cs.overflowY)) return e;
    }
    return null;
  }

  // 滚动：给 n+dy 就滚该元素所在的内部容器（浮层/虚拟列表），给 n 就滚到视野中央，
  // 给 y 就滚窗口。如实汇报真实的滚动结果，不做别的判断。
  function scroll(n, y, dy) {
    try {
      if (n != null && dy != null) {
        const r = resolve(n);
        if (r.error) return { ok: false, reason: 'stale_address', message: r.error };
        const c = scrollContainerOf(r.el);
        if (!c) return { ok: false, reason: 'no_scroll_container', message: '该元素没有可滚动的内部容器；滚窗口请用 y。' };
        const max = Math.max(0, c.scrollHeight - c.clientHeight);
        c.scrollTop = Math.max(0, Math.min(c.scrollTop + dy, max));
        return { ok: true, scrolled: dy, scrollTop: Math.round(c.scrollTop), scrollHeight: c.scrollHeight, clientHeight: c.clientHeight };
      }
      if (n != null) {
        const r = resolve(n);
        if (r.error) return { ok: false, reason: 'stale_address', message: r.error };
        r.el.scrollIntoView({ block: 'center' });
      } else if (y != null) {
        window.scrollTo({ top: Math.max(0, y) });
      } else {
        return { ok: false, reason: 'bad_call', message: 'scroll 需要 n（可选 +dy）或 y' };
      }
      return { ok: true, scrollY: window.scrollY };
    } catch (e) {
      return { ok: false, reason: 'exception', message: String((e && e.message) || e) };
    }
  }

  // CDP 交接用的临时记号：地址（data-pa-n）只存在于本模块的 Map 里，CDP 拿不到。
  // 给目标元素打一个短命、随机的真属性，宿主据此用 DOM.performSearch 在整棵 frame
  // 树里把它找回来（文件上传/真实鼠标事件都要先拿到 CDP 节点），用完立刻 unmark。
  // 任何元素都可以打 —— 这些动作不限于 file 输入框。
  function mark(n) {
    const r = resolve(n);
    if (r.error) return { ok: false, reason: 'stale_address', message: r.error };
    const token = `pa${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    r.el.setAttribute('data-pa-mark', token);
    return { ok: true, mark: token };
  }

  function unmark(token) {
    const el = token ? document.querySelector(`[data-pa-mark="${token}"]`) : null;
    if (el) el.removeAttribute('data-pa-mark');
    return { ok: true };
  }

  function dispatch(call) {
    if (!call || typeof call !== 'object') return { ok: false, reason: 'bad_call' };
    switch (call.op) {
      case 'fill':
        return fill(call.n, call.value);
      case 'fill_many':
        return fillMany(call.items);
      case 'scan':
        return PA.scan ? PA.scan.scan(call) : { ok: false, reason: 'scan_unavailable', message: 'scan.js 未加载' };
      case 'record_arm':
        return PA.record ? PA.record.arm() : { ok: false, reason: 'record_unavailable', message: 'record.js 未加载' };
      case 'record_collect':
        return PA.record ? PA.record.collect(call) : { ok: false, reason: 'record_unavailable', message: 'record.js 未加载' };
      case 'click':
        return click(call.n);
      case 'read':
        return read(call.n);
      case 'box':
        return box(call.n);
      case 'focus':
        return focus(call.n);
      case 'hover':
        return hover(call.n);
      case 'scroll':
        return scroll(call.n, call.y, call.dy);
      case 'hit_test': {
        const r = resolve(call.n);
        if (r.error) return { ok: false, reason: 'stale_address', message: r.error };
        return { ok: true, ...hitTest(r.el) };
      }
      case 'mark':
        return mark(call.n);
      case 'unmark':
        return unmark(call.mark);
      default:
        return { ok: false, reason: 'unknown_op', message: `不认识的动作 ${call.op}` };
    }
  }

  PA.act = { dispatch, fill, fillMany, click, read, box, readState, matchOption, stateValue, activeOptionOf, hitTest };
})();
