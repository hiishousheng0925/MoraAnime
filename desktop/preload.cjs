// 主窗口的 preload：只暴露几个客户端专有的口子给页面（网站代码里按 window.mora 是否存在决定显示与否）。
//   mora.onUpdate(cb)  有新版本时回调版本号（页面晚于检查结果加载也能拿到）
//   mora.openUpdate()  重新打开更新弹窗
//   mora.pickFolder(p) 弹系统的文件夹选择框（设置页「截图保存位置」的「浏览…」），返回路径或 null
//   mora.relogin()     会话失效时让主进程重建会话并刷新主窗口，成功返回 true（内置账号密码随机，用户登不进登录框；
//                      网站桌面模式的 requireLogin() 调它 —— 2026-10-22 审查）
// sandbox 下的 preload 只能是 CommonJS、只能 require('electron') 的这几样
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mora', {
  onUpdate(cb) {
    const h = (_e, v) => cb(v);
    ipcRenderer.on('mora:update', h);
    ipcRenderer.invoke('mora:update-state').then((v) => { if (v) cb(v); }).catch(() => {});
    return () => ipcRenderer.off('mora:update', h);
  },
  openUpdate() { ipcRenderer.send('mora:open-update'); },
  pickFolder(defaultPath) { return ipcRenderer.invoke('mora:pick-folder', String(defaultPath || '')); },
  relogin() { return ipcRenderer.invoke('mora:relogin').then((v) => v === true).catch(() => false); }
});
