const $ = (id) => document.getElementById(id);

let lastResult = null;

// 与采集器的 bestLabel 保持同序：优先语义信号，最后才退回几何邻域
function displayLabel(f) {
  const semantic =
    (f.ariaLabelledbyText && f.ariaLabelledbyText[0]) ||
    f.ariaLabel ||
    f.labelForText ||
    f.labelWrapText ||
    f.legendText;
  if (semantic) return { text: semantic, from: 'semantic' };

  const near = (f.nearbyText || []).find((n) => n.pos === 'left' || n.pos === 'above');
  if (near) return { text: near.text, from: 'geometry' };

  if (f.placeholder) return { text: f.placeholder, from: 'placeholder' };
  return { text: '（无法命名）', from: 'none' };
}

function describeKind(f) {
  let s = f.tag;
  if (f.type) s += `[${f.type}]`;
  if (f.role) s += ` role=${f.role}`;
  return s;
}

function renderFields(fields) {
  const out = $('out');
  out.innerHTML = '';

  if (!fields.length) {
    out.innerHTML =
      '<p class="empty">没有采集到任何字段。<br><br>' +
      '可能原因：页面还没加载完、这个页面确实没有表单、' +
      '或者扩展刚重新加载过而页面未刷新（请刷新目标页面后重试）。</p>';
    return;
  }

  for (const f of fields) {
    const label = displayLabel(f);
    const card = document.createElement('div');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'head';
    head.innerHTML = `<span class="id">#${f.id.replace('f_', '')}</span>
      <span class="kind">${escapeHtml(describeKind(f))}</span>
      <span class="label ${label.from === 'semantic' ? '' : 'fallback'}">${escapeHtml(label.text)}</span>`;
    card.appendChild(head);

    const tags = document.createElement('div');
    tags.className = 'tags';
    if (f.sectionTitle) tags.appendChild(tag(`区块: ${f.sectionTitle}`));
    if (f.required) tags.appendChild(tag('必填', 'req'));
    if (f.disabled) tags.appendChild(tag('禁用'));
    if (f.readonly) tags.appendChild(tag('只读'));
    if (f.visuallyHidden) tags.appendChild(tag('视觉隐藏', 'hidden'));
    if (label.from !== 'semantic') tags.appendChild(tag(`来源: ${label.from}`, 'hidden'));
    if (f.frameUrl) tags.appendChild(tag(`frame: ${shortUrl(f.frameUrl)}`));
    card.appendChild(tags);

    const near = f.nearbyText || [];
    if (near.length) {
      const div = document.createElement('div');
      div.className = 'near';
      div.innerHTML =
        '邻域: ' +
        near
          .map(
            (n) =>
              `<span class="chip"><span class="pos ${n.pos}">${n.pos}</span> ${escapeHtml(
                n.text
              )}</span>`
          )
          .join('');
      card.appendChild(div);
    }

    if (f.options && f.options.length) {
      const div = document.createElement('div');
      div.className = 'opts';
      div.textContent =
        '选项: ' + f.options.map((o) => `${o.label}=${o.value}`).join(' | ');
      card.appendChild(div);
    }

    if (f.currentValue) {
      const div = document.createElement('div');
      div.className = 'opts';
      div.textContent = '当前值: ' + f.currentValue;
      card.appendChild(div);
    }

    out.appendChild(card);
  }
}

function tag(text, extra = '') {
  const s = document.createElement('span');
  s.className = `tag ${extra}`;
  s.textContent = text;
  return s;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    return x.host + x.pathname.slice(0, 24);
  } catch {
    return String(u).slice(0, 30);
  }
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function doScan() {
  const tab = await currentTab();
  if (!tab || !tab.id) {
    $('status').textContent = '找不到当前标签页';
    return;
  }
  if (/^(edge|chrome|about|devtools|extension):/i.test(tab.url || '')) {
    $('status').textContent = '浏览器内置页面无法注入脚本';
    return;
  }

  $('scan').disabled = true;
  $('status').textContent = '扫描中…';

  const t0 = performance.now();
  try {
    const res = await chrome.runtime.sendMessage({ type: 'PA_SCAN_TAB', tabId: tab.id });
    if (!res || !res.ok) {
      $('status').textContent = '扫描失败: ' + ((res && res.error) || '未知错误');
      return;
    }

    lastResult = res;
    const ms = Math.round(performance.now() - t0);
    $('status').textContent = `${res.fields.length} 个字段 · ${ms}ms`;

    renderFields(res.fields);

    if (res.errors && res.errors.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = `有 ${res.errors.length} 个 frame 报错：` +
        res.errors.map((e) => `${shortUrl(e.frameUrl)}: ${e.error}`).join(' ; ');
      $('out').prepend(p);
    }

    $('rawwrap').hidden = false;
    $('raw').textContent = JSON.stringify(res.fields, null, 2);
  } catch (e) {
    $('status').textContent = '扫描异常: ' + ((e && e.message) || e);
  } finally {
    $('scan').disabled = false;
  }
}

async function init() {
  const tab = await currentTab();
  $('tabsite').textContent = tab ? `${tab.title || ''} — ${shortUrl(tab.url || '')}` : '—';
  $('tabsite').title = tab ? tab.url || '' : '';
}

$('scan').addEventListener('click', doScan);
init();
