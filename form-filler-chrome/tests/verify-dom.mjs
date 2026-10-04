// dom.js / act.js 的自动化回归测试。
// 用 puppeteer-core 驱动本机已安装的 Edge（不下载浏览器），把 tests/fixture.html 载入，
// 注入两个 content script，对"快照"与"动作"做断言。
//
// 运行： node tests/verify-dom.mjs
//
// 这里断言的都是"模型能不能靠这份快照把表单填了"所依赖的性质：
// 地址稳定、地址可回解成元素、快照不做任何筛选、压缩页也能读、实时状态如实反映、
// 动作结果必须回读得到。

import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DOM_JS = path.join(ROOT, 'src', 'content', 'dom.js');
const ACT_JS = path.join(ROOT, 'src', 'content', 'act.js');
const RECORD_JS = path.join(ROOT, 'src', 'content', 'record.js');
const FIXTURE = pathToFileURL(path.join(ROOT, 'test', 'fixture.html')).href;

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? `  → ${detail}` : ''}`);
  }
}

const findEdge = () => EDGE_CANDIDATES.find((p) => fs.existsSync(p));

const browser = await puppeteer.launch({
  executablePath: findEdge(),
  headless: true,
  defaultViewport: { width: 1000, height: 1400 },
  args: ['--allow-file-access-from-files', '--no-sandbox'],
});

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push('console.error: ' + m.text());
  });

  await page.goto(FIXTURE, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 400)); // 等 srcdoc iframe 挂载
  await page.addScriptTag({ path: DOM_JS });
  await page.addScriptTag({ path: ACT_JS });

  // 从快照文本里读出某个元素的地址。做法与模型完全一致：找那一行，取 data-pa-n。
  const nOf = (html, marker) => {
    const line = html.split('\n').find((l) => l.includes(marker) && l.includes('data-pa-n='));
    if (!line) return null;
    const m = line.match(/data-pa-n="(\d+)"/);
    return m ? Number(m[1]) : null;
  };

  const snap = () => page.evaluate(() => window.__PA.dom.snapshot().html);
  const html1 = await snap();

  // ---------- 快照：不筛选 ----------
  console.log('\n【快照不做任何筛选：所有控件都要在文件里】');
  const MUST_APPEAR = [
    ['id="a1"', '标准 label[for] 文本框'],
    ['id="deg"', '原生 select'],
    ['name="gender"', 'radio'],
    ['name="agree"', 'checkbox'],
    ['id="cv"', '视口外的 file input'],
    ['name="csrfToken"', 'type=hidden 的隐藏字段'],
    ['id="nation"', 'display:none 的 select'],
    ['id="prov"', '联动三联·省'],
    ['id="city"', '联动三联·市'],
    ['id="dist"', '联动三联·区'],
    ['id="g1"', '离区块标题 620px 的字段'],
    ['id="ctl"', '受控组件'],
    ['id="d0"', '动态插入区的原有字段'],
  ];
  for (const [marker, what] of MUST_APPEAR) {
    const has = html1.includes(marker);
    check(`${what} 出现在快照里`, has, `快照里找不到 ${marker}`);
  }
  check(
    '纯几何字段（无 label/aria/name/id）也在快照里',
    (() => {
      const line = html1.split('\n').find((l) => l.includes('期望薪资'));
      if (!line) return false;
      // 它后面紧跟的那个 input 必须存在
      const idx = html1.split('\n').indexOf(line);
      return html1.split('\n').slice(idx, idx + 3).some((l) => l.includes('<input') && l.includes('data-pa-n='));
    })(),
    '期望薪资附近没有带地址的 input'
  );
  check(
    '没有采集器式的过滤：快照里不得出现"被排除/被拒绝"这类判断',
    !html1.includes('rejectReason') && !html1.includes('explain'),
    '快照里带了判断痕迹'
  );

  // ---------- 序列化：省略大块无用内容 ----------
  console.log('\n【序列化：script / style 内容省略，但标签本身保留】');
  check('保留 <script> 标签本身', html1.includes('<script'), 'script 标签没了');
  check('省略 <script> 的内容', !html1.includes('dynSeq'), '脚本正文进了快照');
  // 用只出现在 <style> 里的字串来断言。不能用 "Microsoft YaHei" —— 它同时出现在
  // iframe 的 srcdoc 属性里，那是 DOM 的正当内容，不该被省略。
  check('省略 <style> 的内容', !html1.includes('故意取得无意义'), '样式正文进了快照');
  check('省略 css 后快照显著小于原始 HTML', html1.length < (await page.content()).length, '快照没有变小');

  // ---------- 地址 ----------
  console.log('\n【地址：可从快照回解成元素，且跨快照稳定】');
  {
    const r = await page.evaluate(() => {
      const snapHtml = window.__PA.dom.snapshot().html;
      const line = snapHtml.split('\n').find((l) => l.includes('id="a1"') && l.includes('data-pa-n='));
      const n = Number(line.match(/data-pa-n="(\d+)"/)[1]);
      return { n, same: window.__PA.dom.elementFor(n) === document.getElementById('a1') };
    });
    check('快照里读到的地址能回解成同一个元素', r.same, `a1 的地址是 ${r.n}，但解不回 a1`);
  }
  {
    const r = await page.evaluate(() => {
      const grab = (m) => {
        const h = window.__PA.dom.snapshot().html;
        return Number(h.split('\n').find((l) => l.includes(m) && l.includes('data-pa-n=')).match(/data-pa-n="(\d+)"/)[1]);
      };
      const was = { a1: grab('id="a1"'), g1: grab('id="g1"'), prov: grab('id="prov"') };

      // 在文档最前面插入新节点。已有元素的地址不能因此漂移 —— 否则模型上一轮
      // 读到的地址，下一轮就指向别的元素了。
      for (let i = 0; i < 3; i++) {
        const d = document.createElement('div');
        d.innerHTML = '<label>插进来的' + i + '</label><input type="text">';
        document.body.insertBefore(d, document.body.firstChild);
      }
      const now = { a1: grab('id="a1"'), g1: grab('id="g1"'), prov: grab('id="prov"') };
      return { was, now };
    });
    check(
      '在文档最前面插入新节点后，原有元素的地址不变',
      r.was.a1 === r.now.a1 && r.was.g1 === r.now.g1 && r.was.prov === r.now.prov,
      `${JSON.stringify(r.was)} → ${JSON.stringify(r.now)}`
    );
    await page.reload({ waitUntil: 'load' });
    await new Promise((r2) => setTimeout(r2, 300));
    await page.addScriptTag({ path: DOM_JS });
    await page.addScriptTag({ path: ACT_JS });
  }

  // ---------- 不污染页面 ----------
  console.log('\n【快照不写回页面】');
  {
    await page.evaluate(() => window.__PA.dom.snapshot());
    const polluted = await page.evaluate(() => document.querySelectorAll('[data-pa-n]').length);
    check('快照之后页面 DOM 上一个 data-pa-n 都没有（地址只存在于输出文本里）', polluted === 0, `页面上有 ${polluted} 个`);
  }

  // ---------- 实时状态 ----------
  console.log('\n【快照反映此刻真实状态，而不只是 HTML 里写死的属性】');
  {
    const r = await page.evaluate(() => {
      document.getElementById('a1').value = '填进去的值';
      const deg = document.getElementById('deg');
      deg.value = 'master';
      document.querySelector('input[name="agree"]').checked = true;
      const h = window.__PA.dom.snapshot().html;
      return {
        textValue: h.split('\n').find((l) => l.includes('id="a1"')),
        selectValue: h.split('\n').find((l) => l.includes('id="deg"') && l.includes('data-pa-n=')),
        // 必须限定在 <option> 行上：select 自己的 data-pa-value="master" 也有
        // value="master" 这个子串，不限定就会匹配到 select 那一行。
        selectedOption: h.split('\n').find((l) => l.includes('<option') && l.includes('value="master"')),
        checkbox: h.split('\n').find((l) => l.includes('name="agree"')),
      };
    });
    check('文本框当前值写进了快照', /value="填进去的值"/.test(r.textValue || ''), r.textValue);
    check('下拉当前值写进了快照', /data-pa-value="master"/.test(r.selectValue || ''), r.selectValue);
    check('被选中的 option 带 selected 标记', /selected/.test(r.selectedOption || ''), r.selectedOption);
    check('被勾选的 checkbox 带 checked 标记', /checked/.test(r.checkbox || ''), r.checkbox);
  }

  // ---------- 压缩页也能读 ----------
  console.log('\n【压缩过的页面：快照仍然是分行的，不是一整行】');
  {
    const r = await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'minified-host';
      // 一整行、无换行的压缩 HTML —— 真实站点长这样。
      // 直接 split('\n') 的做法在这里会退化成"整份文档就是一行"。
      host.innerHTML =
        '<div class="wrapper"><form><div class="field"><label for="m1">姓名</label><input id="m1" type="text"></div>' +
        '<div class="field"><label for="m2">电话</label><input id="m2" type="tel"></div>' +
        '<div class="field"><label for="m3">邮箱</label><input id="m3" type="email"></div></form></div>';
      document.body.appendChild(host);
      const out = window.__PA.dom.serialize(host).text;
      host.remove();
      const lines = out.split('\n');
      return { out, lineCount: lines.length, maxLen: Math.max(...lines.map((l) => l.length)) };
    });
    check('压缩 HTML 被拆成多行', r.lineCount > 5, `只有 ${r.lineCount} 行`);
    check('每行都短到可以读', r.maxLen < 200, `最长一行 ${r.maxLen} 字符`);
    check('压缩页里的字段依然带地址', /data-pa-n="\d+"/.test(r.out) && r.out.includes('id="m2"'), r.out.slice(0, 120));
  }

  // ---------- shadow root ----------
  console.log('\n【开放的 shadow root：内容不能被吞掉】');
  {
    const r = await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'shadow-host';
      document.body.appendChild(host);
      const sr = host.attachShadow({ mode: 'open' });
      sr.innerHTML = '<label>影子里的字段</label><input id="sin" type="text">';
      const out = window.__PA.dom.serialize(host).text;
      const n = Number(out.split('\n').find((l) => l.includes('id="sin"')).match(/data-pa-n="(\d+)"/)[1]);
      const ok = window.__PA.dom.elementFor(n) === sr.getElementById('sin');
      host.remove();
      return { out, ok };
    });
    check('shadow root 被标记出来', r.out.includes('shadow-root (open)'), r.out.slice(0, 120));
    check('shadow root 里的控件出现在快照里', r.out.includes('id="sin"'), r.out.slice(0, 200));
    check('shadow root 里的地址能回解成元素', r.ok, '解不回去');
  }

  // ---------- 截断 ----------
  console.log('\n【节点上限：截断必须显式说明】');
  {
    const r = await page.evaluate(() => {
      const host = document.createElement('div');
      host.innerHTML = '<div><div><div><div><span>x</span></div></div></div></div>';
      const o = window.__PA.dom.serialize(host, { maxNodes: 3 });
      return { truncated: o.truncated, text: o.text };
    });
    check('超上限时报 truncated', r.truncated === true, '没报');
    check('快照里留下截断说明（不静默丢内容）', r.text.includes('已达节点上限'), r.text);
  }

  // 上面那块为了测"实时状态"直接改了页面上的值，那些值在语义上就是"用户填的"，
  // 会被 user_modified 保护挡住。动作测试要在干净的页面上跑。
  await page.reload({ waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 300));
  await page.addScriptTag({ path: DOM_JS });
  await page.addScriptTag({ path: ACT_JS });

  // ---------- 动作：四种控件都要写得进去、读得回来 ----------
  console.log('\n【动作：写入后必须回读得到】');
  const addr = async (marker) => page.evaluate((m) => {
    const h = window.__PA.dom.snapshot().html;
    const line = h.split('\n').find((l) => l.includes(m) && l.includes('data-pa-n='));
    return Number(line.match(/data-pa-n="(\d+)"/)[1]);
  }, marker);

  const act = (call) => page.evaluate((c) => window.__PA.act.dispatch(c), call);

  {
    const n = await addr('id="a1"');
    const r = await act({ op: 'fill', n, value: '张三' });
    check('原生 input：写入后回读等于写入值', r.ok && r.actual.value === '张三', JSON.stringify(r));
  }
  {
    const n = await addr('id="ctl"');
    const r = await act({ op: 'fill', n, value: '这是自我评价' });
    check('受控组件：写入即生效', r.ok && r.actual.value === '这是自我评价', JSON.stringify(r));
    // 模拟 React 重新渲染：直接赋值会被 state 回写冲掉，走原生 setter + 派发事件才不会。
    await page.click('#rerender');
    const survived = await page.evaluate(() => document.getElementById('ctl').value);
    check('受控组件：触发重新渲染后值仍在（证明走的是原生 setter 而非直接赋值）', survived === '这是自我评价', `重新渲染后变成了「${survived}」`);
  }
  {
    const n = await addr('id="deg"');
    const r = await act({ op: 'fill', n, value: '硕士' });
    check('select：按 label 写入选中的是正确项', r.ok && r.actual.value === 'master' && r.actual.selectedText === '硕士', JSON.stringify(r));
  }
  {
    const n = await addr('id="deg"');
    const r = await act({ op: 'fill', n, value: 'master' });
    check('select：按 value 写入也认', r.ok && r.actual.value === 'master', JSON.stringify(r));
  }
  {
    const n = await addr('id="deg"');
    const r = await act({ op: 'fill', n, value: '根本不存在的学历' });
    check('select：匹配不到时不猜，返回候选让模型重挑', r.ok === false && r.reason === 'no_option_match', JSON.stringify(r));
    check('select：不匹配时把真实选项回给模型', Array.isArray(r.actual && r.actual.options) && r.actual.options.length >= 4, JSON.stringify(r.actual && r.actual.options));
  }
  {
    const n = await addr('name="gender" value="female"');
    const r = await act({ op: 'fill', n, value: true });
    check('radio：选中后回读为已勾选', r.ok && r.actual.checked === true, JSON.stringify(r));
  }
  {
    const n = await addr('name="agree"');
    const r = await act({ op: 'fill', n, value: true });
    check('checkbox：勾选后回读为已勾选', r.ok && r.actual.checked === true, JSON.stringify(r));
  }
  {
    const n = await addr('id="cv"');
    const r = await act({ op: 'fill', n, value: 'C:/tmp/x.pdf' });
    check('file input：写不进去时如实报错，而不是假装成功', r.ok === false, JSON.stringify(r));
  }

  // ---------- 用户手改保护 ----------
  console.log('\n【用户手改过的字段不得被静默覆盖】');
  {
    await page.evaluate(() => {
      document.getElementById('a2').value = '用户自己填的邮箱';
    });
    const n = await addr('id="a2"');
    const refused = await act({ op: 'fill', n, value: 'agent@example.com' });
    check('已有内容且非本会话写入 → 拒绝', refused.ok === false && refused.reason === 'user_modified', JSON.stringify(refused));
    check('拒绝时把现场值回给模型，便于它判断', refused.actual && refused.actual.value === '用户自己填的邮箱', JSON.stringify(refused.actual));
    const forced = await act({ op: 'fill', n, value: 'agent@example.com', force: true });
    check('带 force 可以覆盖', forced.ok === true && forced.actual.value === 'agent@example.com', JSON.stringify(forced));
    const again = await act({ op: 'fill', n, value: 'agent2@example.com' });
    check('自己写过的值再次改写不受保护限制', again.ok === true, JSON.stringify(again));
  }

  // ---------- 失效地址 ----------
  console.log('\n【地址失效（页面把元素换掉了）时要报错，不能默默填错地方】');
  {
    const n = await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'doomed';
      host.innerHTML = '<input id="tmp-field" type="text">';
      document.body.appendChild(host);
      const h = window.__PA.dom.snapshot().html;
      const nn = Number(h.split('\n').find((l) => l.includes('id="tmp-field"')).match(/data-pa-n="(\d+)"/)[1]);
      document.getElementById('tmp-field').remove();
      return nn;
    });
    const r = await act({ op: 'fill', n, value: 'x' });
    check('元素被移除后写入 → 报 stale_address', r.ok === false && r.reason === 'stale_address', JSON.stringify(r));
  }

  // ---------- 点击 ----------
  console.log('\n【点击：能驱动页面自己的 JS】');
  {
    const before = await page.evaluate(() => document.querySelectorAll('#dynhost input').length);
    const n = await addr('id="addfield"');
    const r = await act({ op: 'click', n });
    const after = await page.evaluate(() => document.querySelectorAll('#dynhost input').length);
    check('点击按钮触发了页面逻辑（动态插入生效）', r.ok && after === before + 1, `${before} → ${after}`);
  }

  // ---------- P1–P4：读侧活动项 / 元素自滚 / 点击自校验 / 差分收尾 ----------
  console.log('\n【读侧活动项：浮层控件回读当前高亮项】');
  {
    const r = await page.evaluate(() => {
      const host = document.createElement('div');
      host.innerHTML = '<div id="ac" role="combobox" aria-activedescendant="opt-sh">'
        + '<div role="option" id="opt-bj">北京</div>'
        + '<div role="option" id="opt-sh">上海</div></div>';
      document.body.appendChild(host);
      const h = window.__PA.dom.snapshot().html;
      const n = Number(h.split('\n').find((l) => l.includes('id="ac"')).match(/data-pa-n="(\d+)"/)[1]);
      const read = window.__PA.act.dispatch({ op: 'read', n });
      const ao = read.actual && read.actual.activeOption;
      return { text: ao && ao.text, hasN: !!(ao && ao.n) };
    });
    check('combobox 回读带出 aria-activedescendant 指向的活动项', r.text === '上海', JSON.stringify(r));
    check('活动项带可用地址 n', r.hasN, JSON.stringify(r));
  }

  console.log('\n【元素自滚：滚内部容器而非窗口】');
  {
    const r = await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'scroller';
      host.style.cssText = 'height:100px;overflow-y:auto';
      host.innerHTML = '<div style="height:2000px"><div id="scrtarget" style="margin-top:1000px">第15项</div></div>';
      document.body.appendChild(host);
      window.scrollTo(0, 0);
      const h = window.__PA.dom.snapshot().html;
      const n = Number(h.split('\n').find((l) => l.includes('id="scrtarget"')).match(/data-pa-n="(\d+)"/)[1]);
      const beforeWin = window.scrollY;
      const res = window.__PA.act.dispatch({ op: 'scroll', n, dy: 300 });
      return { ok: res.ok, scrollTop: res.scrollTop, boxTop: host.scrollTop, win: window.scrollY, beforeWin, h: res.scrollHeight, c: res.clientHeight };
    });
    check('滚动作用在元素自己的容器上（容器 scrollTop 前进）', r.ok && r.boxTop === 300 && r.scrollTop === 300, JSON.stringify(r));
    check('窗口没有被滚动', r.win === r.beforeWin, JSON.stringify(r));
    check('回读容器高度指标', r.h > r.c && r.c > 0, JSON.stringify(r));
  }

  console.log('\n【点击自校验：被遮挡时 hitsTarget 为 false】');
  {
    const r = await page.evaluate(() => {
      const host = document.createElement('div');
      host.style.cssText = 'position:relative;width:200px;height:40px';
      host.innerHTML = '<button id="covered" style="width:200px;height:40px">按钮</button>'
        + '<div style="position:absolute;inset:0;background:rgba(0,0,0,.1)"></div>';
      document.body.appendChild(host);
      const grab = (m) => {
        const h = window.__PA.dom.snapshot().html;
        return Number(h.split('\n').find((l) => l.includes(m) && l.includes('data-pa-n=')).match(/data-pa-n="(\d+)"/)[1]);
      };
      const covered = window.__PA.act.dispatch({ op: 'click', n: grab('id="covered"') });
      const open = window.__PA.act.dispatch({ op: 'click', n: grab('id="addfield"') });
      return { covered: covered.hitsTarget, open: open.hitsTarget };
    });
    check('被遮挡元素的点击 hitsTarget 为 false', r.covered === false, JSON.stringify(r));
    check('正常元素的点击 hitsTarget 为 true', r.open === true, JSON.stringify(r));
  }

  console.log('\n【差分：报 removed 与 noChange】');
  {
    await page.addScriptTag({ path: RECORD_JS });
    const r = await page.evaluate(async () => {
      const host = document.createElement('div');
      host.innerHTML = '<input id="keep" type="text"><input id="gone" type="text">';
      document.body.appendChild(host);
      window.__PA.dom.snapshot(); // 先分配地址，"gone" 被移除后才有旧地址可报
      window.__PA.record.arm();
      document.getElementById('gone').remove();
      const added = document.createElement('div');
      added.textContent = '新块';
      document.body.appendChild(added);
      const d1 = await window.__PA.record.collect({ settleMs: 30, maxWaitMs: 500 });
      window.__PA.record.arm();
      const d2 = await window.__PA.record.collect({ settleMs: 30, maxWaitMs: 300 });
      return {
        removedGone: d1.removed.some((x) => x.tag === 'input'),
        addedCount: d1.added.length,
        noChange1: d1.noChange,
        noChange2: d2.noChange,
        d2removed: d2.removed.length,
      };
    });
    check('移除已有地址的元素会被报成 removed、并标记有变化', r.removedGone && r.addedCount >= 1 && r.noChange1 === false, JSON.stringify(r));
    check('什么都没发生时报 noChange', r.noChange2 === true && r.d2removed === 0, JSON.stringify(r));
  }

  // ---------- iframe：另一个 document，另一份快照 ----------
  console.log('\n【iframe：独立 document，独立地址空间】');
  {
    const topHasIframeFields = html1.includes('id="i1"');
    check('顶层快照里不含 iframe 内的字段（它是另一个 document）', !topHasIframeFields, 'iframe 内容混进了顶层快照');
    check('顶层快照里保留了 iframe 元素本身', html1.includes('<iframe'), 'iframe 元素没了');

    const child = page.frames().find((f) => f.url() === 'about:srcdoc' || f.url().includes('srcdoc'));
    if (!child) {
      check('找到 srcdoc 子 frame', false, `现有 frames: ${page.frames().map((f) => f.url()).join(', ')}`);
    } else {
      await child.addScriptTag({ path: DOM_JS });
      await child.addScriptTag({ path: ACT_JS });
      const r = await child.evaluate(() => {
        const h = window.__PA.dom.snapshot().html;
        const line = h.split('\n').find((l) => l.includes('id="i1"'));
        const n = Number(line.match(/data-pa-n="(\d+)"/)[1]);
        const filled = window.__PA.act.dispatch({ op: 'fill', n, value: '李四' });
        return { has: !!line, filled: filled.ok && filled.actual.value === '李四' };
      });
      check('iframe 自己的快照里有它的字段', r.has, '没找到 id="i1"');
      check('iframe 里的字段能填并回读', r.filled, '填写失败');
    }
  }

  console.log('\n【运行时错误】');
  check('页面无 JS 报错', pageErrors.length === 0, pageErrors.join(' | '));

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
} finally {
  await browser.close();
}

process.exit(fail === 0 ? 0 : 1);
