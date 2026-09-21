// 采集器的自动化回归测试。
// 用 puppeteer-core 驱动本机已安装的 Edge（不下载浏览器），
// 把 test/fixture.html 载入，注入采集器，对输出的描述符做断言。
//
// 运行： npm test        或   node test/verify-collector.mjs --dump

import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COLLECTOR = path.join(ROOT, 'src', 'content', 'collector.js');
const FIXTURE = 'file:///' + path.join(ROOT, 'test', 'fixture.html').replace(/\\/g, '/');

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const DUMP = process.argv.includes('--dump');

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

function findEdge() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Edge，请手动修改 EDGE_CANDIDATES');
}

// 采集器输出的"最佳标签"，与 collector.js 的 bestLabel 保持同序
function labelOf(f) {
  return (
    (f.ariaLabelledbyText && f.ariaLabelledbyText[0]) ||
    f.ariaLabel ||
    f.labelForText ||
    f.labelWrapText ||
    f.legendText ||
    (f.nearbyText || []).find((n) => n.pos === 'left' || n.pos === 'above')?.text ||
    f.placeholder ||
    ''
  );
}

const nearTexts = (f) => (f.nearbyText || []).map((n) => n.text);

const browser = await puppeteer.launch({
  executablePath: findEdge(),
  headless: true,
  defaultViewport: { width: 900, height: 1400 },
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
  await new Promise((r) => setTimeout(r, 300)); // 等 srcdoc iframe 挂载

  // 主 frame
  await page.addScriptTag({ path: COLLECTOR });
  const main = await page.evaluate(() => window.__PA.collector.collect());

  // 子 frame（真实扩展里由 all_frames 各注入一份，这里手动模拟）
  const child = page.frames().find((f) => f !== page.mainFrame());
  let childFields = [];
  if (child) {
    await child.addScriptTag({ path: COLLECTOR });
    childFields = await child.evaluate(() => window.__PA.collector.collect());
  }

  if (DUMP) {
    console.log('\n--- 主 frame 描述符 ---');
    console.log(JSON.stringify(main, null, 2));
    console.log('\n--- 子 frame 描述符 ---');
    console.log(JSON.stringify(childFields, null, 2));
  }

  console.log(`\n主 frame 采集到 ${main.length} 个字段，子 frame ${childFields.length} 个\n`);

  const byLabel = (s) => main.find((f) => labelOf(f).includes(s));
  const byNear = (s) => main.find((f) => nearTexts(f).some((t) => t.includes(s)));

  console.log('【语义标签】');
  check('label[for] → 姓名', !!byLabel('姓名'), '未找到');
  check('label[for] → 电子邮箱', !!byLabel('电子邮箱'), '未找到');
  check('包裹式 label → 手机号码', !!main.find((f) => (f.labelWrapText || '').includes('手机号码')), 'labelWrapText 未命中');
  check('aria-label → 身份证号码', !!main.find((f) => f.ariaLabel === '身份证号码'), 'ariaLabel 未命中');
  check(
    'aria-labelledby → 紧急联系人姓名',
    !!main.find((f) => (f.ariaLabelledbyText || []).some((t) => t.includes('紧急联系人姓名'))),
    'ariaLabelledbyText 未命中'
  );

  console.log('\n【几何邻域（不读 class / 不读 DOM 结构）】');
  check('表格布局 → 毕业院校（靠 th 的几何位置）', !!byNear('毕业院校'), '邻域里没有"毕业院校"');
  check('表格布局 → 所学专业', !!byNear('所学专业'), '邻域里没有"所学专业"');
  const geoOnly = main.find(
    (f) =>
      !f.labelForText &&
      !f.labelWrapText &&
      !f.ariaLabel &&
      !(f.ariaLabelledbyText || []).length &&
      nearTexts(f).includes('期望薪资')
  );
  check('纯几何 → 期望薪资（无 label/aria/name/id）', !!geoOnly, '未通过几何找到');
  check(
    '几何条目带位置与距离',
    !!geoOnly && geoOnly.nearbyText.every((n) => typeof n.pos === 'string' && typeof n.dx === 'number'),
    geoOnly ? JSON.stringify(geoOnly.nearbyText[0]) : 'n/a'
  );

  console.log('\n【区块上下文】');
  const company = main.find((f) => f.labelForText === '公司名称');
  check('fieldset > legend → 实习经历', !!company && company.legendText === '实习经历', company ? `legendText=${company.legendText}` : '未找到公司名称');
  const school = byNear('毕业院校');
  check('sectionTitle 命中前置标题', !!school && !!school.sectionTitle, school ? `sectionTitle=${school.sectionTitle}` : 'n/a');

  console.log('\n【控件与选项】');
  const degree = main.find((f) => f.name === 'degree');
  check('原生 select 被采集', !!degree, '未找到 name=degree');
  check(
    'select 拿到真实 option value',
    !!degree && degree.options?.some((o) => o.value === 'bachelor' && o.label === '本科') &&
      degree.options?.some((o) => o.value === 'phd'),
    degree ? JSON.stringify(degree.options) : 'n/a'
  );
  const radios = main.filter((f) => f.name === 'gender');
  check('radio group 两个都被采集', radios.length === 2, `实际 ${radios.length} 个`);
  check(
    'radio 的选项带 value 与 label',
    radios.length === 2 && radios.every((r) => r.options?.some((o) => o.value === 'male' || o.value === 'female')),
    radios[0] ? JSON.stringify(radios[0].options) : 'n/a'
  );
  check('checkbox 被采集', !!main.find((f) => f.name === 'agree'), '未找到 name=agree');

  console.log('\n【自定义控件与可见性过滤】');
  const combo = main.find((f) => f.role === 'combobox');
  check('role=combobox 被采集（不只是原生控件）', !!combo, '未找到 role=combobox');
  check('假下拉框的标签靠 aria-labelledby 命中', !!combo && combo.ariaLabelledbyText.includes('期望工作城市'), combo ? JSON.stringify(combo.ariaLabelledbyText) : 'n/a');
  check('type=hidden 被过滤（csrfToken 不在结果里）', !main.some((f) => f.name === 'csrfToken'), 'csrfToken 泄漏进了结果');
  const fileInput = main.find((f) => f.type === 'file');
  check('视口外的 file input 被保留', !!fileInput, '被误杀');
  check('视口外的 file input 被标记为 visuallyHidden', !!fileInput && fileInput.visuallyHidden === true, fileInput ? `visuallyHidden=${fileInput.visuallyHidden}` : 'n/a');

  console.log('\n【幂等 ID：动态插入不漂移】');
  const before = main.find((f) => f.labelForText === '原有字段');
  check('插入前存在「原有字段」', !!before, '未找到');
  if (before) {
    await page.click('#addfield');
    await page.click('#addfield');
    await new Promise((r) => setTimeout(r, 100));
    const after = await page.evaluate(() => window.__PA.collector.collect());
    const same = after.find((f) => f.labelForText === '原有字段');
    check('插入两个新字段后，原字段 id 不变', !!same && same.id === before.id, `before=${before.id} after=${same && same.id}`);
    check('新插入的字段被采集到', after.some((f) => f.labelForText === '动态字段1') && after.some((f) => f.labelForText === '动态字段2'), '未采集到动态字段');
    check('采集数量随插入增加', after.length >= main.length + 2, `${main.length} → ${after.length}`);
  }

  console.log('\n【多 frame 汇总】');
  check('iframe 被找到', !!child, '没有子 frame');
  check('iframe 内采集到 2 个字段', childFields.length === 2, `实际 ${childFields.length}`);
  check('iframe 内 label[for] 正常工作', childFields.some((f) => f.labelForText === '推荐人姓名') && childFields.some((f) => f.labelForText === '推荐人电话'), childFields.map((f) => f.labelForText).join(','));

  console.log('\n【不依赖 class / DOM 结构】');
  const classLeak = main.some((f) => JSON.stringify(f).includes('z10') || JSON.stringify(f).includes('z4'));
  check('描述符里没有出现任何 class 名', !classLeak, '有 class 名泄漏');
  check('描述符里没有出现 CSS 选择器路径', !main.some((f) => 'selector' in f || 'path' in f), '出现了选择器字段');

  console.log('\n【改版鲁棒性：换掉所有 class + 加深 DOM 层级，结果应完全不变】');
  {
    const baseLabels = (await page.evaluate(() => window.__PA.collector.collect())).map(labelOf).sort();

    await page.evaluate(() => {
      // 1) 改版重命名 class：把所有 class 换成随机值
      for (const el of document.querySelectorAll('*')) {
        if (typeof el.className === 'string' && el.className) {
          el.className = 'x' + Math.random().toString(36).slice(2, 8);
        }
      }
      // 2) DOM 结构变化：给每个控件套一层 div。
      //    用 display:contents 让新层级不产生盒子，从而把"树结构变了"与"视觉布局变了"隔离开。
      for (const el of document.querySelectorAll('#main input, #main select, #main textarea, iframe')) {
        if (!el.parentNode) continue;
        const w = document.createElement('div');
        w.style.display = 'contents';
        el.parentNode.insertBefore(w, el);
        w.appendChild(el);
      }
    });

    const afterReshape = await page.evaluate(() => window.__PA.collector.collect());
    const reshapedLabels = afterReshape.map(labelOf).sort();

    check(
      '换掉全部 class 名 + 加深一层 DOM 后，字段集合完全一致',
      JSON.stringify(reshapedLabels) === JSON.stringify(baseLabels),
      `\n      之前: ${baseLabels.join(' / ')}\n      之后: ${reshapedLabels.join(' / ')}`
    );
    check(
      '改版后字段数量不变',
      afterReshape.length === baseLabels.length,
      `${baseLabels.length} → ${afterReshape.length}`
    );
    check(
      '纯几何字段（期望薪资）在改版后依然能找到',
      reshapedLabels.some((l) => l === '期望薪资'),
      '丢了'
    );
  }

  console.log('\n【运行时错误】');
  check('页面无 JS 报错', pageErrors.length === 0, pageErrors.join(' | '));

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
} finally {
  await browser.close();
}

process.exit(fail === 0 ? 0 : 1);
