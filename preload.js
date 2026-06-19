const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('messengerApp', {
  onNotificationClick: () => ipcRenderer.send('notification-click'),
  toggleDarkMode: () => ipcRenderer.send('toggle-dark-mode'),
  toggleAlwaysOnTop: () => ipcRenderer.send('toggle-always-on-top'),
  reloadPage: () => ipcRenderer.send('reload-page'),
  zoomIn: () => ipcRenderer.send('zoom-in'),
  zoomOut: () => ipcRenderer.send('zoom-out'),
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  getSettings: () => ipcRenderer.sendSync('get-settings'),
  reportUnreadSignal: (data) => ipcRenderer.send('messenger-unread-signal', data),
  reportWebNotification: (data) => ipcRenderer.send('messenger-web-notification', data),
});
