import { send } from './connection.js';
const $ = id => document.getElementById(id);
$('version').textContent = `浏览器加载版本：${chrome.runtime.getManifest().version} · 扩展 ID：${chrome.runtime.id}`;
let busy = false;
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    $('site').textContent = tab ? `${tab.title || ''} — ${tab.url || ''}` : '暂无标签页';
    const result = await send({ type: 'PA_STATUS' });
    $('status').textContent = result.connected ? '已连接本地服务' : result.error || '未连接：请确认 DSH 已启动';
    if (document.activeElement !== $('url')) $('url').value = result.url;
    const tabs = result.tabs || [];
    $('tabs').replaceChildren(...(tabs.length === 0
      ? [Object.assign(document.createElement('li'), { className: 'hint', textContent: '暂无 HTTP(S) 标签页' })]
      : tabs.map(t => Object.assign(document.createElement('li'), { textContent: t.title || t.url }))));
  } catch (e) { $('status').textContent = e.message; }
  finally { busy = false; }
}
async function action(fn) {
  try { $('message').textContent = ''; await fn(); await refresh(); }
  catch (e) { $('message').textContent = e.message; }
}
$('connect').onclick = () => action(async () => {
  await send({ type: 'PA_CONFIG', url: $('url').value });
  $('message').textContent = '配置已保存';
});
refresh();
setInterval(refresh, 2000);
