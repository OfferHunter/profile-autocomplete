// iframe 能力回归：钉死「上传文件 / 真实鼠标事件 / 定向裁剪」在 iframe 里走的那条 CDP 路。
// 跑法：node tests/iframe-probe.mjs   （需要本机有 Edge；不进 npm test，要真浏览器）
//
// 扩展的实现依赖三个 CDP 事实，这里逐条断言（同源、跨源同站、跨站三种 frame）：
//  1. DOM.performSearch 能顺着 frame 树找到子 frame 里的 data-pa-mark 节点；
//  2. 用这个 nodeId 调 DOM.setFileInputFiles 能真的把文件挂到 iframe 内的 file input；
//  3. DOM.getContentQuads 给的是**顶层视口**坐标，按它派发真实点击能命中 iframe 内元素；
//  4. 跨站(OOPIF) frame 是独立渲染进程，主调试会话的 performSearch 找不到（预期边界）。

import puppeteer from 'puppeteer-core';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
function findEdge() {
  const p = EDGE_CANDIDATES.find((x) => fs.existsSync(x));
  if (!p) throw new Error('找不到 Edge');
  return p;
}

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? `  → ${detail}` : ''}`); }
}

const INNER = (mark) => `<!doctype html><meta charset="utf-8"><body style="margin:0">
<div style="margin:60px 40px">
  <input type="file" id="f1" data-mark="${mark}" style="width:200px;height:30px">
  <button id="b1" data-mark="${mark}-btn" style="margin-top:20px">按钮</button>
</div>
</body>`;

// 同源 = 同端口；跨源同站 = 同主机不同端口（无 OOPIF）；跨站 = localhost vs 127.0.0.1（OOPIF）。
function makeServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/inner.html') { res.end(INNER(url.searchParams.get('mark') || 'M')); return; }
    const p1 = server.address().port;
    const p2 = crossSiteServer.address().port;
    res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0">
<iframe id="same"  src="/inner.html?mark=M1"                       style="width:500px;height:260px;border:3px solid red"></iframe>
<iframe id="xorig" src="http://127.0.0.1:${p2}/inner.html?mark=M2" style="width:500px;height:260px;border:3px solid green"></iframe>
<iframe id="xsite" src="http://localhost:${p2}/inner.html?mark=M3" style="width:500px;height:260px;border:3px solid blue"></iframe>
</body>`);
  });
}
const server = makeServer();
const crossSiteServer = makeServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
await new Promise((r) => crossSiteServer.listen(0, '127.0.0.1', r));
const TOP_URL = `http://127.0.0.1:${server.address().port}/top.html`;

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-iframe-'));

const browser = await puppeteer.launch({
  executablePath: findEdge(),
  headless: true,
  userDataDir,
  args: ['--no-sandbox', '--no-first-run'],
});

try {
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send('DOM.enable');
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  await page.goto(TOP_URL, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 1500));

  const search = async (mark) => {
    // 和 findMarkedNode 一致：先 getDocument(depth:0) 初始化节点表，否则搜索出来的
    // nodeId 是悬空的（下面 setFileInputFiles 会报 Could not find node with given id）。
    await cdp.send('DOM.getDocument', { depth: 0 });
    const { searchId, resultCount } = await cdp.send('DOM.performSearch', { query: `[data-mark="${mark}"]` });
    let nodeIds = [];
    if (resultCount > 0) {
      ({ nodeIds } = await cdp.send('DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: resultCount }));
    }
    await cdp.send('DOM.discardSearchResults', { searchId });
    return { resultCount, nodeIds };
  };

  console.log('\n【1】performSearch 顺 frame 树查节点');
  const same = await search('M1');
  const xorig = await search('M2');
  const xsite = await search('M3');
  check('同源 iframe 内节点可被找到', same.resultCount === 1 && same.nodeIds.length === 1, `resultCount=${same.resultCount}`);
  check('跨源同站 iframe 内节点可被找到', xorig.resultCount === 1, `resultCount=${xorig.resultCount}`);
  check('跨站(OOPIF) iframe 内节点找不到（预期边界）', xsite.resultCount === 0, `resultCount=${xsite.resultCount}`);

  console.log('\n【2】performSearch → setFileInputFiles（iframe 内 file input）');
  const tmp = path.join(os.tmpdir(), `pa-iframe-${Date.now()}.txt`);
  fs.writeFileSync(tmp, 'via performSearch');
  // nodeId 只在下一次 getDocument/搜索之前有效：上面 section 1 又搜了 M2/M3，会作废 M1 的
  // nodeId。像 findMarkedNode 那样「搜索后立刻用」，所以这里重新搜一次 M1。
  const fresh = await search('M1');
  await cdp.send('DOM.setFileInputFiles', { files: [tmp], nodeId: fresh.nodeIds[0] });
  const fileCount = await page.evaluate(() => {
    try { return document.getElementById('same').contentDocument.getElementById('f1').files.length; }
    catch (e) { return `ERR ${e.message}`; }
  });
  check('文件挂到了同源 iframe 的 file input', fileCount === 1, `files.length=${fileCount}`);

  console.log('\n【3】getContentQuads 是顶层视口坐标，按它点击能命中');
  const btn = await search('M1-btn');
  const { quads } = await cdp.send('DOM.getContentQuads', { nodeId: btn.nodeIds[0] });
  const q = quads[0];
  const cx = (q[0] + q[2] + q[4] + q[6]) / 4;
  const cy = (q[1] + q[3] + q[5] + q[7]) / 4;
  const expected = await page.evaluate(() => {
    const f = document.getElementById('same');
    const b = f.contentDocument.getElementById('b1').getBoundingClientRect();
    const fr = f.getBoundingClientRect();
    return { cx: fr.left + f.clientLeft + b.left + b.width / 2, cy: fr.top + f.clientTop + b.top + b.height / 2 };
  });
  check('quads 中心 == 顶层视口推导中心', Math.abs(cx - expected.cx) < 1.5 && Math.abs(cy - expected.cy) < 1.5,
    `quads=(${cx.toFixed(1)},${cy.toFixed(1)}) 期望=(${expected.cx.toFixed(1)},${expected.cy.toFixed(1)})`);

  await page.evaluate(() => {
    window.__hit = 0;
    document.getElementById('same').contentDocument.getElementById('b1')
      .addEventListener('click', () => { window.__hit = (window.__hit || 0) + 1; });
  });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 200));
  const hit = await page.evaluate(() => window.__hit || 0);
  check('真实点击命中了 iframe 内按钮', hit === 1, `click 次数=${hit}`);
} finally {
  await browser.close();
  server.close();
  crossSiteServer.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
