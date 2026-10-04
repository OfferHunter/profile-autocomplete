// 端到端验证：把扩展真正加载进 Edge，走完整的
//   侧边栏 -> service worker -> content script(各 frame) -> 汇总
// 消息链路。这是唯一能验证"扩展是否真的可用"的方式。
//
// 运行: node tests/verify-extension.mjs

import puppeteer from 'puppeteer-core';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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
  if (ok) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? `  → ${detail}` : ''}`);
  }
}

// ---- 起一个本地 http 服务，避开 file:// 的注入限制和"允许访问文件网址"开关 ----
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'fixture.html';
  const p = path.join(ROOT, 'test', rel);
  try {
    res.setHeader('Content-Type', rel.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain');
    res.end(fs.readFileSync(p));
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const FIXTURE_URL = `http://127.0.0.1:${PORT}/fixture.html`;

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-profile-'));

const browser = await puppeteer.launch({
  executablePath: findEdge(),
  headless: true,
  userDataDir,
  // 不要用 puppeteer 的视口仿真（defaultViewport），改成真实窗口尺寸。
  // 实测：仿真走 Emulation.setDeviceMetricsOverride，而 captureBeyondViewport 会动这套覆盖值 ——
  // 截一次全页图之后，页面的 innerWidth 会从 1000 永久变成 750，元素跟着重排。
  // 那是仿真层与截图互相干扰的产物，真实 Edge 窗口里不会发生（实测 innerWidth 970 全程不变）。
  // 用仿真会让这组测试量到一个不存在的失效模式，所以这里必须用真窗口。
  defaultViewport: null,
  args: [
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    '--no-sandbox',
    '--no-first-run',
    '--window-size=1000,1400',
  ],
});

try {
  console.log('\n【service worker】');
  let swTarget = null;
  try {
    swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().includes('service-worker.js'),
      { timeout: 15000 }
    );
  } catch {
    /* 下面统一报错 */
  }

  check('service worker 被激活（manifest 加载成功）', !!swTarget, '等待 15s 未见 SW，多半是 manifest 报错');

  if (!swTarget) {
    console.log('\n  扩展没能加载，后续测试跳过。请到 edge://extensions 看具体报错。');
  } else {
    const EXT_ID = new URL(swTarget.url()).host;
    console.log(`  扩展 ID: ${EXT_ID}`);

    const fixturePage = await browser.newPage();
    const consoleErrors = [];
    fixturePage.on('console', (m) => {
      if (m.type() !== 'error') return;
      // "Failed to load resource: 404" 这类消息本身不带 URL，得从 location 补上，
      // 否则无法区分"favicon 缺失"和"页面脚本真的挂了"。
      const url = (m.location() && m.location().url) || '';
      consoleErrors.push(url ? `${m.text()} @ ${url}` : m.text());
    });
    await fixturePage.goto(FIXTURE_URL, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 1500)); // 等 content script 注入 + srcdoc iframe

    // ---- 从扩展页面走真实的运行时消息链路 ----
    // 用侧边栏页面本身，和用户点按钮时执行的是同一条路径。
    const panelPage = await browser.newPage();
    await panelPage.goto(`chrome-extension://${EXT_ID}/src/sidepanel/sidepanel.html`);
    await new Promise((r) => setTimeout(r, 300));

    console.log('\n【消息链路：content script 是否注入】');
    const tunnel = await panelPage.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
      if (!tab) return { error: '找不到 fixture 标签页' };

      let ping;
      try {
        ping = await chrome.tabs.sendMessage(tab.id, { type: 'PA_PING' });
      } catch (e) {
        ping = { error: String(e && e.message) };
      }

      const snap = await chrome.runtime.sendMessage({ type: 'PA_SNAPSHOT_TAB', tabId: tab.id });
      return { tabId: tab.id, ping, snap };
    });

    // 后面 CDP 那一段要用真实元素的位置来裁图，地址在这里读出来后留到块外用。
    const addrs = {};

    if (tunnel.error) {
      check('能定位到 fixture 标签页', false, tunnel.error);
    } else {
      check('侧边栏 -> SW -> content script 链路打通', !tunnel.ping.error, JSON.stringify(tunnel.ping));

      const r = tunnel.snap;
      check('快照请求成功返回', !!r && r.ok && Array.isArray(r.frames) && r.frames.length > 0, r ? `ok=${r.ok} frames=${r.frames ? r.frames.length : 0}` : '无响应');

      if (r && r.ok) {
        const frames = r.frames;
        console.log(`\n  收到 ${frames.length} 个 frame 的快照`);

        check('多 frame 都被汇总（顶层 + iframe）', frames.length >= 2, `只有 ${frames.length} 个`);
        check('顶层文档是 frame 0', frames.some((f) => f.frameId === 0), `frameId: ${frames.map((f) => f.frameId).join(',')}`);
        check('frame 之间 frameId 不重复', new Set(frames.map((f) => f.frameId)).size === frames.length, '有重复');

        const top = frames.find((f) => f.frameId === 0);
        check('顶层快照非空', !!top && top.html.length > 200, top ? `${top.html.length} 字符` : '没有顶层 frame');
        check(
          '顶层快照里带上了地址（data-pa-n）',
          !!top && top.html.includes('data-pa-n='),
          '快照里一个地址都没有'
        );
        check(
          '快照里保留了隐藏控件（本地不做筛选）',
          !!top && top.html.includes('csrfToken') && top.html.includes('id="cv"'),
          '隐藏字段或 file input 被筛掉了'
        );
        check(
          '快照里省略了脚本正文（否则文件被内联 JS 淹没）',
          !!top && top.html.includes('<script') && !top.html.includes('dynSeq'),
          '脚本正文进了快照'
        );
        check(
          'iframe 的快照是独立的另一份',
          frames.filter((f) => f.frameId !== 0).every((f) => !f.html.includes('id="a1"')),
          '子 frame 的快照里混进了顶层内容'
        );
        const child = frames.find((f) => f.frameId !== 0 && (f.html || '').includes('id="i1"'));
        check('iframe 自己的字段在它自己的快照里', !!child, '没找到 id="i1"');

        // ---- 动作链路：把值真的填进页面，并回读 ----
        console.log('\n【动作链路：写入 + 回读】');
        const addrOf = (html, marker) => {
          const line = html.split('\n').find((l) => l.includes(marker) && l.includes('data-pa-n='));
          if (!line) return null;
          const m = line.match(/data-pa-n="(\d+)"/);
          return m ? Number(m[1]) : null;
        };

        const a1 = addrOf(top.html, 'id="a1"');
        const deg = addrOf(top.html, 'id="deg"');
        addrs.a1 = a1;
        addrs.deg = deg;
        check('能从快照里读出目标元素的地址', a1 !== null && deg !== null, `a1=${a1} deg=${deg}`);

        const actResult = await panelPage.evaluate(
          async ({ tabId, calls }) => {
            const out = [];
            for (const call of calls) {
              out.push(await chrome.runtime.sendMessage({ type: 'PA_ACT_TAB', tabId, frameId: 0, call }));
            }
            return out;
          },
          {
            tabId: tunnel.tabId,
            calls: [
              { op: 'fill', n: a1, value: '张三' },
              { op: 'fill', n: deg, value: '硕士' },
            ],
          }
        );

        check('文本框经由扩展链路写入并回读成功', actResult[0] && actResult[0].response && actResult[0].response.result.ok === true, JSON.stringify(actResult[0]));
        check('下拉经由扩展链路写入并回读成功', actResult[1] && actResult[1].response && actResult[1].response.result.ok === true, JSON.stringify(actResult[1]));

        // 到页面里直接看，确认不是只在消息里"说成功了"
        const actual = await fixturePage.evaluate(() => ({
          a1: document.getElementById('a1').value,
          deg: document.getElementById('deg').value,
        }));
        check('页面上真的被写进去了', actual.a1 === '张三' && actual.deg === 'master', JSON.stringify(actual));

        // 动作必须打到指定 frame，而不是随便哪个 frame
        const childFrames = frames.filter((f) => f.frameId !== 0);
        if (childFrames.length) {
          const cf = childFrames[0];
          const i1 = addrOf(cf.html, 'id="i1"');
          const r2 = await panelPage.evaluate(
            async ({ tabId, frameId, n }) =>
              chrome.runtime.sendMessage({ type: 'PA_ACT_TAB', tabId, frameId, call: { op: 'fill', n, value: '李四' } }),
            { tabId: tunnel.tabId, frameId: cf.frameId, n: i1 }
          );
          check('动作能精确定位到子 frame', r2 && r2.response && r2.response.result.ok === true, JSON.stringify(r2));
          const childFrame = fixturePage.frames().find((f) => f !== fixturePage.mainFrame());
          const childVal = childFrame ? await childFrame.evaluate(() => document.getElementById('i1').value) : null;
          check('子 frame 里的值真的写进去了', childVal === '李四', `读到「${childVal}」`);
        }

        // 地址失效：重建一份快照，确认编号体系对页面是幂等的
        console.log('\n【地址稳定性】');
        const again = await panelPage.evaluate(
          async (tabId) => chrome.runtime.sendMessage({ type: 'PA_SNAPSHOT_TAB', tabId }),
          tunnel.tabId
        );
        const top2 = again.frames.find((f) => f.frameId === 0);
        const a1b = addrOf(top2.html, 'id="a1"');
        const degB = addrOf(top2.html, 'id="deg"');
        check('重复出快照不改变已有元素的地址', a1b === a1 && degB === deg, `${a1}/${deg} → ${a1b}/${degB}`);
        check('重复快照能反映刚才写进去的值（地址体系与实时状态是同一份真相）', top2.html.includes('value="张三"'), '写入的值没出现在新快照里');
      }
    }

    // ---- CDP 出图 ----
    // 出图是 content script 做不到的事，只能走 chrome.debugger。这一段验证：
    // 真扩展里能出图、后台标签页会被自动激活、裁剪会夹到页面范围内、
    // 元素坐标换算正确、iframe 字段被如实拒绝、重复 attach 不炸。
    console.log('\n【CDP 出图】');
    {
      // 先把 fixture 切到后台：出图必须自己把它激活，否则会挂死。
      // 这条断言就是冲着实测到的那个失效模式来的 —— 非激活标签页上
      // captureBeyondViewport 不报错、也不返回。
      const backgrounded = await browser.newPage();
      await backgrounded.goto('about:blank');
      await backgrounded.bringToFront();

      // 先问一个真实元素的文档坐标，裁图用的是它。
      const boxRes = await panelPage.evaluate(
        async ({ tabId, n }) => chrome.runtime.sendMessage({ type: 'PA_ACT_TAB', tabId, frameId: 0, call: { op: 'box', n } }),
        { tabId: tunnel.tabId, n: addrs.a1 }
      );
      const box = boxRes && boxRes.response && boxRes.response.result && boxRes.response.result.box;
      check('能取到元素的文档坐标（供裁剪使用）', !!box && box.width > 0, JSON.stringify(boxRes));

      const r = await panelPage.evaluate(
        async ({ tabId, box }) => {
          const cdp = await import(chrome.runtime.getURL('src/sidepanel/cdp.js'));
          const out = { steps: [] };
          try {
            await cdp.attach(tabId);
            // 重复 attach 必须是幂等的：第二次调用不能抛。
            await cdp.attach(tabId);
            out.steps.push('attached-twice-ok');

            out.wasActive = (await chrome.tabs.get(tabId)).active;
            out.size = await cdp.contentSize(tabId);

            // 截图不能改变页面布局 —— 这条断言是冲着上面那个仿真层干扰的失效模式来的：
            // 截完图后页宽/元素位置必须原样不动，否则裁剪坐标会全部失准。
            const before = await cdp.contentSize(tabId);
            const ov = await cdp.overview(tabId);
            const after = await cdp.contentSize(tabId);
            out.layoutStable = before.width === after.width && before.height === after.height;
            out.layoutSizes = `${before.width}x${before.height} → ${after.width}x${after.height}`;
            out.overview = {
              clip: ov.clip,
              switched: ov.switched,
              pageHeight: ov.pageHeight,
              coversAll: ov.coversAll,
              prefix: ov.data.slice(0, 12),
              len: ov.data.length,
            };

            // 请求一个横跨右下角、超出页面边界的窗口，看它会不会夹回来
            const far = await cdp.region(tabId, { x: out.size.width - 40, y: out.size.height - 40, width: 5000, height: 5000 });
            out.clamped = far.clip;
            out.clampedPrefix = far.data.slice(0, 12);

            // 完全落在页面外的窗口必须报错，而不是裁出一张空图
            try {
              await cdp.region(tabId, { x: out.size.width + 500, y: out.size.height + 500, width: 100, height: 100 });
              out.outside = 'no-error';
            } catch (e) {
              out.outside = String((e && e.message) || e);
            }

            // 元素裁剪：绕元素扩一圈，且必须夹在页面内
            const crop = await cdp.cropAround(tabId, box);
            out.crop = { clip: crop.clip, prefix: crop.data.slice(0, 12), len: crop.data.length };

            // iframe 里的元素没有可用的顶层坐标，必须明确拒绝而不是猜着裁
            try {
              await cdp.cropAround(tabId, { ...box, top: false });
              out.iframeRefusal = 'no-error';
            } catch (e) {
              out.iframeRefusal = String((e && e.message) || e);
            }

            // 整页概览的高度上限：maxH 调小后 covered 应跟着变小，并报出页面真实高度
            const small = await cdp.overview(tabId, { maxH: 600 });
            out.small = { clip: small.clip, covered: small.covered, pageHeight: small.pageHeight, coversAll: small.coversAll };
          } catch (e) {
            out.error = String((e && e.message) || e);
          } finally {
            await cdp.detach(tabId).catch(() => {});
            out.attachedAfterDetach = cdp.isAttached(tabId);
          }
          return out;
        },
        { tabId: tunnel.tabId, box }
      );

      await backgrounded.close();

      if (r.error) {
        check('CDP 出图可用', false, r.error);
      } else {
        check('CDP attach 幂等（重复 attach 不抛）', r.steps.includes('attached-twice-ok'), JSON.stringify(r.steps));
        check('目标标签页本来是后台的（这条断言才有意义）', r.wasActive === false, `active=${r.wasActive}`);
        check('后台标签页出图前被自动激活', r.overview.switched === true, `switched=${r.overview.switched}`);
        check('截图不改变页面布局（否则裁剪坐标会失准）', r.layoutStable === true, r.layoutSizes);
        check('能读到页面内容尺寸', r.size && r.size.width > 0 && r.size.height > 0, JSON.stringify(r.size));
        check('整页概览返回了内容', r.overview.len > 500, `len=${r.overview.len}`);
        check('返回的是 PNG（base64 头 iVBORw0KGgo）', r.overview.prefix.startsWith('iVBORw0KGgo'), r.overview.prefix);
        check(
          '概览高度不超过单图上限（4000px）',
          r.overview.clip.height === Math.min(4000, r.size.height),
          `clip.height=${r.overview.clip.height} pageH=${r.size.height}`
        );
        check('页面在单图上限内时概览覆盖全页', r.overview.coversAll === (r.size.height <= 4000), `coversAll=${r.overview.coversAll}`);

        check(
          '超界的裁剪窗口被夹回页面内',
          r.clamped.x + r.clamped.width <= r.size.width && r.clamped.y + r.clamped.height <= r.size.height,
          JSON.stringify(r.clamped)
        );
        check('夹回后仍返回了内容', r.clampedPrefix.startsWith('iVBORw0KGgo'), r.clampedPrefix);
        check('完全在页面外的窗口报错而不是返回空图', r.outside !== 'no-error', r.outside);

        check('元素裁剪返回了内容', r.crop.len > 500 && r.crop.prefix.startsWith('iVBORw0KGgo'), JSON.stringify({ len: r.crop.len, prefix: r.crop.prefix }));
        check(
          '元素裁剪把元素框住了（扩图后包含元素原位）',
          r.crop.clip.x <= box.x && r.crop.clip.y <= box.y &&
            r.crop.clip.x + r.crop.clip.width >= box.x + box.width &&
            r.crop.clip.y + r.crop.clip.height >= box.y + box.height,
          `clip=${JSON.stringify(r.crop.clip)} box=${JSON.stringify(box)}`
        );
        check(
          '元素裁剪夹在页面范围内',
          r.crop.clip.x >= 0 && r.crop.clip.y >= 0 &&
            r.crop.clip.x + r.crop.clip.width <= r.size.width &&
            r.crop.clip.y + r.crop.clip.height <= r.size.height,
          JSON.stringify(r.crop.clip)
        );
        check('iframe 内字段的裁剪被明确拒绝（不猜坐标）', /iframe/.test(r.iframeRefusal), r.iframeRefusal);

        check('maxH 调小后概览只覆盖前一段，并报出真实页高', r.small.covered === 600 && r.small.pageHeight === r.size.height && r.small.coversAll === false, JSON.stringify(r.small));
        check('detach 之后不再认为处于连接状态', r.attachedAfterDetach === false, 'detach 没生效');
      }
    }

    console.log('\n【service worker 无异常】');
    const swErrors = await swTarget
      .worker()
      .then((w) => w.evaluate(() => (self.__paErrors || []).slice(0, 5)))
      .catch(() => []);
    check('SW 没有抛错', swErrors.length === 0, swErrors.join(' | '));

    console.log('\n【页面无异常】');
    const realErrors = consoleErrors.filter((e) => !/favicon/i.test(e));
    check('fixture 页面无 JS 报错', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));
  }

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
} finally {
  await browser.close();
  server.close();
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响结果 */
  }
}

process.exit(fail === 0 ? 0 : 1);
