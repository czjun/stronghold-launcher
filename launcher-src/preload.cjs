// preload.cjs — 渲染进程可用的最小桥（contextIsolation 开启）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sp', {
  servers: () => ipcRenderer.invoke('servers'),
  probe: (url) => ipcRenderer.invoke('probe', url),
  open: (url) => ipcRenderer.invoke('open', url),
  stats: () => ipcRenderer.invoke('stats'),
  assets: () => ipcRenderer.invoke('assets-status'),
  version: () => ipcRenderer.invoke('app-version'),
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  startUpdate: () => ipcRenderer.invoke('update-start'),
  onUpdate: (cb) => { ipcRenderer.on('update-available', (_e, d) => cb('available', d)); ipcRenderer.on('update-progress', (_e, d) => cb('progress', d)); },
  // 中转站地址（0.3.3 起旧中转大厅失效，改为手动输入 + 记忆 + 可修改）
  relayGet: () => ipcRenderer.invoke('relay-get'),
  relaySet: (url) => ipcRenderer.invoke('relay-set', url),
  // 与当前游戏服务器同步素材（以服务端清单为权威，只下差异）
  syncAssets: () => ipcRenderer.invoke('assets-sync'),
  onAssetsSync: (cb) => { ipcRenderer.on('assets-sync-progress', (_e, d) => cb(d)); },
});
