// CDP 能力层：只封装 content script 做不到的两件事 —— 出图和传文件。
// 其余一切（读 DOM、填值、回读）都走 content script，在页面上下文里做，比拼
// Runtime.evaluate 的字符串稳，也少一层转义。
//
// 注意 chrome.debugger 与 DevTools 互斥，且 attach 后浏览器会显示一条黄色提示条。
// 这是浏览器的硬约束，不是可以绕开的东西。

import { withTimeout } from './with-timeout.js';

const PROTOCOL = '1.3';

// 单张图的像素高度上限。captureBeyondViewport 抓到超高尺寸时会被浏览器静默截断成
// 空白，所以一次 clip 不该超过它。4000px 约等于 1.5 个视口，宽高比还在模型能看清
// 的范围内。超过这个高度的页面靠 look(y,h) 分窗看。
const MAX_IMAGE_H = 4000;
export { MAX_IMAGE_H };

// 裁剪图默认向四周扩这么多像素。标签通常在控件左边或上方，扩一圈才能把标签和控件
// 一起框进去 —— 只裁控件本身就只剩一个空框，读不出这是哪个字段。
const CROP_PAD = 150;

// CDP 命令一律带超时。实测：captureBeyondViewport 在**非激活标签页**上不会报错，
// 而是永不返回 —— 直接把 Agent 循环挂死。宁可超时报错，也不能让循环卡住。
const CMD_TIMEOUT_MS = 15000;

// 清理用的 detach 不该拖住队列：给一个更短的时限。
const DETACH_TIMEOUT_MS = 3000;

const attached = new Set();
chrome.debugger.onDetach.addListener(source => attached.delete(source.tabId));

/** 已经 attach 过就不再重复 attach —— 重复调用会抛 "Another debugger is already attached"。 */
export async function attach(tabId) {
  if (attached.has(tabId)) return;
  try {
    await withTimeout(chrome.debugger.attach({ tabId }, PROTOCOL), CMD_TIMEOUT_MS, 'chrome.debugger.attach');
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/already attached|Another debugger/i.test(msg)) {
      throw new Error('这个标签页已被 DevTools 或其他调试器占用。请先关闭 DevTools（F12）再试。');
    }
    throw new Error(`无法连接调试通道：${msg}`);
  }
  attached.add(tabId);
  try {
    await send(tabId, 'Page.enable');
  } catch {
    // Page 域不是每个页面都能开（比如 PDF 查看器），captureScreenshot 有时仍可用。
  }
}

export async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    await withTimeout(chrome.debugger.detach({ tabId }), DETACH_TIMEOUT_MS, 'chrome.debugger.detach');
  } catch {
    /* 标签页可能已经关掉了 */
  }
}

export function isAttached(tabId) {
  return attached.has(tabId);
}

function rawSend(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}

async function send(tabId, method, params = {}, timeoutMs = CMD_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      rawSend(tabId, method, params),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${method} 超过 ${timeoutMs}ms 没有响应（命令挂住了，不是页面慢）`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 截图前必须让标签页处于激活状态。
 * 实测：非激活标签页上 captureBeyondViewport 不会报错，而是永不返回；激活后同一
 * 请求 ~200ms 就回来了。非激活标签页不渲染，"抓视口外内容"这件事无从谈起。
 */
export async function ensureActive(tabId) {
  const tab = await withTimeout(chrome.tabs.get(tabId), CMD_TIMEOUT_MS, 'chrome.tabs.get');
  if (tab && tab.active) return false;
  await withTimeout(chrome.tabs.update(tabId, { active: true }), CMD_TIMEOUT_MS, 'chrome.tabs.update');
  return true; // 调用方可以据此告诉用户"我切了标签页"
}

/** 页面内容尺寸（文档坐标，CSS 像素）。 */
export async function contentSize(tabId) {
  const m = await send(tabId, 'Page.getLayoutMetrics');
  const s = m.cssContentSize || m.contentSize;
  if (!s) throw new Error('Page.getLayoutMetrics 没有返回内容尺寸');
  return { width: Math.ceil(s.width), height: Math.ceil(s.height) };
}

async function shootClip(tabId, clip) {
  const r = await send(tabId, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    // scale 固定为 1：让截图分辨率只由 CSS 像素决定，不随显示器 DPR 变化 ——
    // 否则同一页面在不同机器上出来的图不一样大，模型表现也跟着变。
    clip: { ...clip, scale: 1 },
  });
  return r && r.data ? r.data : null;
}

/**
 * 整页概览图：从页首起、最多 MAX_IMAGE_H 高的一张原分辨率 PNG。
 *
 * 用 clip 一次抓完，**不滚动页面** —— 滚动会重复 sticky 头部、触发懒加载、改变页面状态，
 * 而 clip 能直接抓到视口外的内容。自己去激活标签页：非激活标签页上
 * captureBeyondViewport 永不返回（见 ensureActive），switched 让调用方得以告诉用户。
 *
 * 超过 MAX_IMAGE_H 的页面只给前一段，并用 coversAll/covered 如实说明，让模型知道
 * 还有多少没看到、要不要 look 下面的部分。
 */
export async function overview(tabId, { maxH = MAX_IMAGE_H } = {}) {
  const switched = await ensureActive(tabId);
  const { width, height } = await contentSize(tabId);
  const h = Math.min(maxH, height);
  if (!width || h <= 0) throw new Error(`页面尺寸异常：${width}x${height}`);
  const clip = { x: 0, y: 0, width, height: h };
  const data = await shootClip(tabId, clip);
  if (!data) throw new Error('整页截图没有返回数据');
  return { data, clip, switched, pageHeight: height, covered: h, coversAll: h >= height };
}

/** 页面任意矩形窗口的原分辨率截图，坐标是文档坐标。超出页面的部分自动夹回来。 */
export async function region(tabId, { x, y, width, height }) {
  const switched = await ensureActive(tabId);
  const size = await contentSize(tabId);
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(size.width, Math.ceil(x + width));
  const bottom = Math.min(size.height, Math.ceil(y + height));
  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) throw new Error(`要裁的区域落在页面之外（x=${left} y=${top} ${w}x${h}，页面 ${size.width}x${size.height}）`);
  const clip = { x: left, y: top, width: w, height: h };
  const data = await shootClip(tabId, clip);
  if (!data) throw new Error('裁剪没有返回数据');
  return { data, clip, switched, pageHeight: size.height };
}

/**
 * 围绕一个元素裁图。这是实测唯一对全部字号（含 10.5px）100% 可靠的识别通道，
 * 也是每次填完让模型当场确认"填对没有"的手段，所以绕元素扩一圈。
 * box 必须是**顶层文档坐标**；iframe 内元素的坐标由调用方先用 viewportBox +
 * scrollOffset 换算好（见 bridge 的边路）。
 */
export async function cropAround(tabId, box, pad = CROP_PAD) {
  if (!box) throw new Error('缺少元素位置');
  return region(tabId, {
    x: box.x - pad,
    y: box.y - pad,
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  });
}

// ---- 真实输入：DOM 级操作被控件吞掉时的兜底通道 ----
//
// 国企网申里 jquery.autocomplete / 日期控件 / 富文本只认 isTrusted 的事件，
// el.dispatchEvent 派发的合成事件它们不理。这些接口用 CDP 造真事件。
// 坐标一律吃**顶层视口**坐标（视口左上是原点），不是文档坐标，也不是 frame 局部坐标。

const MOUSE_BUTTON = 'left';
const CLICK_COUNT = 1;

/**
 * 把一个 data-pa-mark 记号翻译成 CDP 的 nodeId。
 * 地址（data-pa-n）只活在内容脚本的 Map 里，CDP 不认识；内容脚本会先在目标元素上
 * 打一个 data-pa-mark=<token> 的真属性。DOM.performSearch 是 DevTools 那个搜索，
 * 会**顺着 frame 树往下搜**（同进程的 frame 都覆盖），所以子 frame 里的元素也找得到
 * —— 这正是它比顶层 Runtime.evaluate 强的地方。
 * @returns nodeId；找不到（元素已被重渲染，或它在跨站 OOPIF 里、主会话看不到）时为 0。
 */
export async function findMarkedNode(tabId, token) {
  await send(tabId, 'DOM.enable').catch(() => {});
  // 必须先要一次 getDocument（只要根节点，depth:0）把 DOM 代理的节点表初始化 ——
  // 否则 performSearch 返回的 nodeId 是悬空的，后面 setFileInputFiles/getContentQuads
  // 一律报 "Could not find node with given id"（实测）。
  await send(tabId, 'DOM.getDocument', { depth: 0 });
  const { searchId, resultCount } = await send(tabId, 'DOM.performSearch', {
    query: `[data-pa-mark="${token}"]`,
  });
  try {
    if (!resultCount) return 0;
    const { nodeIds } = await send(tabId, 'DOM.getSearchResults', {
      searchId, fromIndex: 0, toIndex: resultCount,
    });
    return nodeIds && nodeIds.length ? nodeIds[0] : 0;
  } finally {
    await send(tabId, 'DOM.discardSearchResults', { searchId }).catch(() => {});
  }
}

/** 把节点滚入视野。本来就在视野内、或不在可滚动容器里时静默返回。 */
export async function scrollIntoView(tabId, nodeId) {
  await send(tabId, 'DOM.scrollIntoViewIfNeeded', { nodeId }).catch(() => {});
}

/**
 * 节点在**顶层视口**里的外接矩形（CSS 像素）。
 * DOM.getContentQuads 由浏览器自己算出节点在顶层视口的位置 —— 各级 iframe 的偏移与
 * 滚动都已算进去，所以我们不碰坐标数学。inline 元素可能返回多个 quad，取面积最大的
 * 那个。@returns 矩形；节点没有可交互尺寸（未渲染等）时为 null。
 */
export async function viewportBox(tabId, nodeId) {
  const { quads } = await send(tabId, 'DOM.getContentQuads', { nodeId });
  if (!quads || !quads.length) return null;
  let best = null;
  for (const q of quads) {
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const box = { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    if (!best || box.width * box.height > best.width * best.height) best = box;
  }
  return best;
}

/** 顶层文档的滚动偏移。getContentQuads 吃视口坐标，captureScreenshot 的 clip 吃文档坐标，差这一档。 */
export async function scrollOffset(tabId) {
  const m = await send(tabId, 'Page.getLayoutMetrics');
  const v = m.cssLayoutViewport || m.layoutViewport;
  return { x: v ? v.pageX : 0, y: v ? v.pageY : 0 };
}

/** 矩形中心（顶层视口坐标），四舍五入到整数像素。 */
export function centerOf(box) {
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/** 把指针移到顶层视口里的一个点（真实 mouseMoved）。用于 hover 菜单/提示。 */
export async function moveToPoint(tabId, point) {
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: point.x, y: point.y, buttons: 0,
  });
  return { ok: true, dispatched: true, point };
}

/**
 * 在顶层视口里的一个点上做真实鼠标点击：移到该点后按下再抬起。
 * iframe 内元素的坐标已由 viewportBox 换算成顶层视口坐标 —— 浏览器按坐标路由输入，
 * 跨 iframe 也能落到正确的元素上。调用方要先保证元素已滚入视野。
 */
export async function realClickAt(tabId, point) {
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: point.x, y: point.y, buttons: 0,
  });
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: MOUSE_BUTTON, buttons: 1, clickCount: CLICK_COUNT,
  });
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: MOUSE_BUTTON, buttons: 0, clickCount: CLICK_COUNT,
  });
  return { ok: true, dispatched: true, point };
}

/** 往当前焦点里插入文本（真实输入，会触发 input 事件）。 */
export async function typeText(tabId, text) {
  await send(tabId, 'Input.insertText', { text });
  return { ok: true, dispatched: true, inserted: text.length };
}

// 特殊键的 CDP 参数。只能给这几个——多一个都会引出"模型乱按键盘"的风险。
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
};

export const SUPPORTED_KEYS = Object.keys(KEYS);

/** 按下并抬起一个特殊键。Enter 带 text，联想框才会真的选中。 */
export async function pressKey(tabId, name) {
  const spec = KEYS[name];
  if (!spec) throw new Error(`不支持的按键 ${name}；可用：${SUPPORTED_KEYS.join('、')}`);
  const base = {
    key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode,
  };
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(spec.text ? { text: spec.text } : {}) });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  return { ok: true, dispatched: true, key: name };
}

/**
 * 给一个 file input 挂上本地文件。调用方先用 findMarkedNode 把记号换成 nodeId
 * （那一步会 DOM.enable），这里只管把文件挂上去。nodeId 不分 frame ——
 * 子 frame 里的 file input 一样能挂。
 */
export async function setFiles(tabId, nodeId, path) {
  await send(tabId, 'DOM.setFileInputFiles', { files: [path], nodeId });
  return { ok: true, files: [path] };
}
