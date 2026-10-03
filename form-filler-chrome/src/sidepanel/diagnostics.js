// Check the browser's loaded manifest, not the manifest.json currently on disk.
// An old unpacked extension can load new HTML/JS while retaining its old worker type.
export function configurationError(manifest) {
  const missing = [];
  if (manifest.background?.type !== 'module') missing.push('后台尚未按 module 加载');
  if (!manifest.permissions?.includes('alarms')) missing.push('缺少 alarms 权限');
  if (!manifest.host_permissions?.some(host => host === 'http://127.0.0.1/*' || host === '<all_urls>')) {
    missing.push('缺少本地服务访问权限');
  }
  if (!missing.length) return null;
  return `浏览器仍使用旧扩展清单 v${manifest.version || '未知'}：${missing.join('；')}。` +
    '请在扩展管理页找到 Profile Autocomplete，点击该扩展卡片上的“重新加载”按钮（不是刷新网页），再关闭并重新打开侧边栏。';
}
