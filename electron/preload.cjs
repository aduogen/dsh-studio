// Narrow bridge: no Node in the renderer, only these calls.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studio', {
  status: () => ipcRenderer.invoke('engine:status'),
  invoke: (endpoint, args) => ipcRenderer.invoke('engine:invoke', endpoint, args),
  loadLayout: () => ipcRenderer.invoke('layout:load'),
  savePosition: (sessionId, pos) =>
    ipcRenderer.invoke('layout:save', { [sessionId]: pos }),
  selectSession: (sessionId) => ipcRenderer.send('session:select', sessionId),
  onLog: (cb) => ipcRenderer.on('engine:log', (_e, line) => cb(line)),
});
