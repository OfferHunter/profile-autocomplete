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
  function readState(el) {
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
      if (typeof r.el.click === 'function') r.el.click();
      else r.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window }));
      return { ok: true, dispatched: true, actual: readState(r.el), box: boxOf(r.el) };
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

  // 滚动：给 n 就把元素滚到视野中央，给 y 就滚窗口。只汇报真实 scrollY，不做别的判断。
  function scroll(n, y) {
    try {
      if (n != null) {
        const r = resolve(n);
        if (r.error) return { ok: false, reason: 'stale_address', message: r.error };
        r.el.scrollIntoView({ block: 'center' });
      } else if (y != null) {
        window.scrollTo({ top: Math.max(0, y) });
      } else {
        return { ok: false, reason: 'bad_call', message: 'scroll 需要 n 或 y' };
      }
      return { ok: true, scrollY: window.scrollY };
    } catch (e) {
      return { ok: false, reason: 'exception', message: String((e && e.message) || e) };
    }
  }

  // 文件上传的临时记号：地址只存在于本模块的 Map 里，CDP 拿不到；给目标元素打一个
  // 短命属性，宿主据此取到 CDP 节点后立刻 unmark。只允许 file 输入框。
  function mark(n) {
    const r = resolve(n);
    if (r.error) return { ok: false, reason: 'stale_address', message: r.error };
    if (!r.el.matches('input[type=file]')) {
      return { ok: false, reason: 'not_file_input', message: '目标不是文件输入框 input[type=file]' };
    }
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
        return scroll(call.n, call.y);
      case 'mark':
        return mark(call.n);
      case 'unmark':
        return unmark(call.mark);
      default:
        return { ok: false, reason: 'unknown_op', message: `不认识的动作 ${call.op}` };
    }
  }

  PA.act = { dispatch, fill, click, read, box, readState, matchOption, stateValue };
})();
