// scan.js 的自动化回归测试（配合 act.js 的 fill_many）。
// 用 puppeteer-core 驱动本机 Edge，把 tests/fixture.html 载入，注入 dom/scan/act 三个
// content script，对"枚举是否齐全、候选标签是否给对、地址是否与快照一致、批量写入是否回读得到"做断言。
//
// 运行： node tests/verify-scan.mjs
//
// 这里断言的性质：
//   - 枚举按可交互性收，且**不做筛选**：hidden / file / display:none / disabled 都保留并打 flag。
//   - 候选标签带 kind，多来源；本地只给候选，不替模型认定"哪个是键"。
//   - scan 分配的地址与快照一致。
//   - fill_many 复用 fill 的守卫：批量写回读得到、已填项跳过、不可写项带 reason 拒绝。

import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DOM_JS = path.join(ROOT, 'src', 'content', 'dom.js');
const SCAN_JS = path.join(ROOT, 'src', 'content', 'scan.js');
const ACT_JS = path.join(ROOT, 'src', 'content', 'act.js');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hasLabel = (ctrl, kind, text) =>
  ctrl && Array.isArray(ctrl.labels) && ctrl.labels.some((l) => l.kind === kind && l.text === text);
const hasAnyLabel = (ctrl, text) =>
  ctrl && Array.isArray(ctrl.labels) && ctrl.labels.some((l) => l.text === text);

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
  await sleep(400); // 等 srcdoc iframe 挂载
  await page.addScriptTag({ path: DOM_JS });
  await page.addScriptTag({ path: SCAN_JS });
  await page.addScriptTag({ path: ACT_JS });

  // 注入几个"本地不该排除"的控件，验证 disabled / submit 也被列出并打 flag。
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'injected';
    host.innerHTML = '<input id="dis1" type="text" disabled><input id="sub1" type="submit" value="提交">';
    document.getElementById('main').appendChild(host);
  });

  // scan 并在页面里把地址回解成元素，附上 id/name/type 方便断言。
  const scan = (opts = {}) => page.evaluate((o) => {
    const r = window.__PA.scan.scan(o);
    r.controls = r.controls.map((c) => {
      const el = window.__PA.dom.elementFor(c.n);
      return { ...c, _id: el && el.id, _name: el && el.name, _attrType: el && (el.getAttribute('type') || '') };
    });
    return r;
  }, opts);

  const all = await scan();
  const controls = all.controls;
  const byId = (id) => controls.find((c) => c._id === id);
  const byName = (name) => controls.filter((c) => c._name === name);
  const byName1 = (name) => byName(name)[0];

  // ---------- 枚举：齐全 + 不筛选 ----------
  console.log('\n【枚举：所有可填控件都在，且本地不做筛选】');
  check('标准文本框 a1 在列表里', !!byId('a1'));
  check('原生 select deg 在列表里', !!byId('deg'));
  check('radio 组 gender 两个都在列表里', byName('gender').length === 2, `找到 ${byName('gender').length} 个`);
  check('checkbox agree 在列表里', byName('agree').length === 1);
  check('视口外的 file input cv 在列表里', !!byId('cv'), 'file input 被本地排除了');
  check('type=hidden 的 csrfToken 在列表里', !!byName1('csrfToken'), 'hidden 被本地排除了');
  check('display:none 的 select nation 在列表里', !!byId('nation'), 'display:none 被本地排除了');
  check('联动三联 prov/city/dist 都在列表里', !!byId('prov') && !!byId('city') && !!byId('dist'));
  check('被 CSS 藏起来的原生 select nat 在列表里', !!byId('nat'));
  check('role=combobox 自定义控件在列表里', controls.some((c) => c.role === 'combobox'));
  check('disabled 控件在列表里且 flags.disabled 为真', !!(byId('dis1') && byId('dis1').flags.disabled), 'disabled 被排除或没打标');
  check('input[type=submit] 在列表里', !!byId('sub1'), 'submit 被本地排除了');
  check('hidden 控件 flags.visible 为假', !!(byName1('csrfToken') && byName1('csrfToken').flags.visible === false));
  check('display:none 控件 flags.visible 为假', !!(byId('nation') && byId('nation').flags.visible === false));

  // ---------- 候选标签：多来源 ----------
  console.log('\n【候选标签：按来源给候选，本地不裁决】');
  check('label[for] → 姓名', hasLabel(byId('a1'), 'label-for', '姓名'), JSON.stringify(byId('a1') && byId('a1').labels));
  check('包裹式 label → 手机号码', hasLabel(byName('mobile')[0], 'wrapping', '手机号码'));
  check('aria-label → 身份证号码', hasLabel(byName1('idNo'), 'aria', '身份证号码'), JSON.stringify(byName1('idNo') && byName1('idNo').labels));
  check('aria-labelledby → 紧急联系人姓名', hasLabel(byName1('ecName'), 'aria', '紧急联系人姓名'));
  check('表格单元 → 毕业院校', hasLabel(byName('school')[0], 'table-cell', '毕业院校'));
  check('表格单元 → 所学专业', hasLabel(byName('major')[0], 'table-cell', '所学专业'));
  check('fieldset legend → 实习经历', hasLabel(byId('w1'), 'legend', '实习经历'));
  check('label[for] → 公司名称', hasLabel(byId('w1'), 'label-for', '公司名称'));
  check('select → label[for] 最高学历', hasLabel(byId('deg'), 'label-for', '最高学历'));
  check('受控组件 → label[for] 自我评价', hasLabel(byId('ctl'), 'label-for', '自我评价'));
  check(
    '无任何命名属性的控件能靠邻近文本给出候选（期望薪资）',
    controls.some((c) => hasAnyLabel(c, '期望薪资')),
    '期望薪资没出现在任何控件的候选里'
  );
  check(
    '被 CSS 藏起来的 select nat 能靠邻近文本给出候选（国籍/地区）',
    hasAnyLabel(byId('nat'), '国籍/地区'),
    JSON.stringify(byId('nat') && byId('nat').labels)
  );
  check('select 的候选里带上选项清单', Array.isArray(byId('deg').options) && byId('deg').options.some((o) => o.label === '硕士'));

  // ---------- 地址：与快照一致 ----------
  console.log('\n【地址：scan 分配的 n 与快照一致】');
  {
    const r = await page.evaluate(() => {
      const h = window.__PA.dom.snapshot().html;
      const line = h.split('\n').find((l) => l.includes('id="a1"') && l.includes('data-pa-n='));
      const snapN = Number(line.match(/data-pa-n="(\d+)"/)[1]);
      const ctrl = window.__PA.scan.scan({}).controls.find((c) => c.id === 'a1');
      return { snapN, scanN: ctrl && ctrl.n };
    });
    check('a1 的 scan 地址 == 快照地址', r.snapN === r.scanN, `快照 ${r.snapN} vs scan ${r.scanN}`);
  }

  // ---------- 参数：kinds / limit / scope ----------
  console.log('\n【参数：让模型自己收窄】');
  {
    const only = await scan({ kinds: ['label-for'] });
    check('kinds=[label-for] 时只留 label-for 候选', only.controls.every((c) => c.labels.every((l) => l.kind === 'label-for')));
    const paged = await scan({ limit: 2 });
    check('limit=2 时只返回 2 条', paged.controls.length === 2 && paged.total > 2, `count=${paged.controls.length} total=${paged.total}`);
    const scoped = await scan({ scope: '#main' });
    check('scope=#main 时限定在子树内且无错误', !scoped.scopeError && scoped.count > 0);
    const bad = await scan({ scope: '#no-such-thing' });
    check('无效 scope 如实报错而非静默', typeof bad.scopeError === 'string' && bad.scopeError.length > 0);
  }

  // ---------- fill_many：批量写 ----------
  console.log('\n【fill_many：一次批量写，复用 fill 的守卫】');
  {
    const ids = await page.evaluate(() => {
      const pick = (pred) => window.__PA.scan.scan({}).controls.find(pred).n;
      return {
        a1: pick((c) => c.id === 'a1'),
        deg: pick((c) => c.id === 'deg'),
        agree: pick((c) => c.name === 'agree'),
        combo: pick((c) => c.role === 'combobox'),
        csrf: pick((c) => c.name === 'csrfToken'),
        dis: pick((c) => c.id === 'dis1'),
      };
    });
    const r = await page.evaluate((ids) => window.__PA.act.dispatch({
      op: 'fill_many',
      items: [
        { n: ids.a1, value: '张三' },
        { n: ids.deg, value: '本科' },
        { n: ids.agree, value: 'true' },
      ],
    }), ids);
    const after = await page.evaluate(() => ({
      a1: document.getElementById('a1').value,
      deg: document.getElementById('deg').value,
      agree: document.querySelector('input[name=agree]').checked,
    }));
    check('批量写入全部 ok', r.ok && r.results.length === 3 && r.results.every((x) => x.ok), JSON.stringify(r.results));
    check('批量写入回读正确', after.a1 === '张三' && after.deg === 'bachelor' && after.agree === true, JSON.stringify(after));

    const again = await page.evaluate((ids) => window.__PA.act.dispatch({
      op: 'fill_many', items: [{ n: ids.a1, value: '李四' }],
    }), ids);
    check('已填项被跳过（no override）', again.results[0].ok === false && again.results[0].reason === 'already_filled', JSON.stringify(again.results[0]));

    const bad = await page.evaluate((ids) => window.__PA.act.dispatch({
      op: 'fill_many',
      items: [{ n: ids.combo, value: '北京' }, { n: ids.csrf, value: 'x' }, { n: ids.dis, value: 'x' }],
    }), ids);
    check(
      '自定义控件 / hidden / disabled 均带 reason 被拒绝',
      bad.results.length === 3 && bad.results.every((x) => x.ok === false && x.reason === 'unsupported_or_disabled'),
      JSON.stringify(bad.results)
    );
  }

  // ---------- iframe：独立 document，独立 scan ----------
  console.log('\n【iframe：独立 document 自己扫描】');
  {
    await page.reload({ waitUntil: 'load' });
    await sleep(400);
    await page.addScriptTag({ path: DOM_JS });
    await page.addScriptTag({ path: SCAN_JS });
    await page.addScriptTag({ path: ACT_JS });
    const top = await scan();
    check('顶层 scan 不含 iframe 内的字段', !top.controls.some((c) => c._id === 'i1'), 'iframe 字段混进了顶层 scan');

    const child = page.frames().find((f) => f.url() === 'about:srcdoc' || f.url().includes('srcdoc'));
    if (!child) {
      check('找到 srcdoc 子 frame', false, `现有 frames: ${page.frames().map((f) => f.url()).join(', ')}`);
    } else {
      await child.addScriptTag({ path: DOM_JS });
      await child.addScriptTag({ path: SCAN_JS });
      await child.addScriptTag({ path: ACT_JS });
      const got = await child.evaluate(() => {
        const r = window.__PA.scan.scan({});
        const c = r.controls.find((x) => x.id === 'i1');
        return { has: !!c, label: c && c.labels.find((l) => l.kind === 'label-for') };
      });
      check('子 frame 的 scan 里有它自己的字段', got.has, '没找到 id="i1"');
      check('子 frame 字段的 label[for] 候选正确', !!(got.label && got.label.text === '推荐人姓名'), JSON.stringify(got.label));
    }
  }

  console.log('\n【运行时错误】');
  check('页面无 JS 报错', pageErrors.length === 0, pageErrors.join(' | '));

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
} finally {
  await browser.close();
}

process.exit(fail === 0 ? 0 : 1);
