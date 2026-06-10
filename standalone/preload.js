// Bridges main process and renderer with a minimal, allow-listed API.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onStateUpdate: (cb) => {
    ipcRenderer.on('state-update', (_event, data) => cb(data));
  },
  closeWindow: () => {
    ipcRenderer.send('close-window');
  },
  togglePin: () => ipcRenderer.invoke('toggle-pin'),
  getPinState: () => ipcRenderer.invoke('get-pin-state'),
});
