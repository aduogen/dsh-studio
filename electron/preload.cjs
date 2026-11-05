// Narrow bridge: no Node in the renderer, only these calls.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studio', {
  status: () => ipcRenderer.invoke('engine:status'),
  invoke: (endpoint, args) => ipcRenderer.invoke('engine:invoke', endpoint, args),
  board: () => ipcRenderer.invoke('board:get'),
  detail: (sessionId) => ipcRenderer.invoke('session:detail', sessionId),
  workspaces: () => ipcRenderer.invoke('workspaces:get'),
  spawn: (opts) => ipcRenderer.invoke('spawn:run', opts),
  search: (q) => ipcRenderer.invoke('search:run', q),
  digest: (sessionId) => ipcRenderer.invoke('digest:get', sessionId),
  loadEdges: () => ipcRenderer.invoke('edges:load'),
  saveEdges: (edges) => ipcRenderer.invoke('edges:save', edges),
  running: (ids) => ipcRenderer.invoke('board:running', ids),
  action: (name, sessionId, extra) => ipcRenderer.invoke('action:run', name, sessionId, extra),
  loadLayout: () => ipcRenderer.invoke('layout:load'),
  savePosition: (sessionId, pos) =>
    ipcRenderer.invoke('layout:save', { [sessionId]: pos }),
  selectSession: (sessionId) => ipcRenderer.send('session:select', sessionId),
  onLog: (cb) => ipcRenderer.on('engine:log', (_e, line) => cb(line)),
});
