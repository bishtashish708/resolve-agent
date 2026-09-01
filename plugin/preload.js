'use strict';
/**
 * contextBridge surface. (Doc 2 E2.1)
 *
 * NAMED ALLOWLIST ONLY. No generic invoke(channel, ...args) passthrough —
 * that would reintroduce everything context isolation prevents.
 *
 * Note the subpath: 'electron/renderer', not 'electron'. Required in a
 * sandboxed preload on Electron 19.0.2+.
 */

const { contextBridge, ipcRenderer } = require('electron/renderer');

contextBridge.exposeInMainWorld('agent', {
  connect: () => ipcRenderer.invoke('resolve:connect'),
  snapshot: () => ipcRenderer.invoke('resolve:snapshot'),
  probe: () => ipcRenderer.invoke('resolve:probe'),
  agentStatus: () => ipcRenderer.invoke('agent:status'),
  ask: (question) => ipcRenderer.invoke('agent:ask', question),
  onDelta: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('agent:delta', h);
    return () => ipcRenderer.removeListener('agent:delta', h);
  },

  // E6 — content indexing
  indexRun: (opts) => ipcRenderer.invoke('index:run', opts),
  indexCancel: () => ipcRenderer.invoke('index:cancel'),
  indexApply: (opts) => ipcRenderer.invoke('index:apply', opts),
  indexRevert: () => ipcRenderer.invoke('index:revert'),
  indexClean: () => ipcRenderer.invoke('index:clean'),
  onIndexProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('index:progress', h);
    return () => ipcRenderer.removeListener('index:progress', h);
  },
  prewarm: () => ipcRenderer.invoke('agent:prewarm'),
  resetSession: () => ipcRenderer.invoke('agent:resetSession'),
  sessionState: () => ipcRenderer.invoke('agent:sessionState'),
  callLog: () => ipcRenderer.invoke('diag:callLog'),
  env: () => ipcRenderer.invoke('diag:env'),
  openDevTools: () => ipcRenderer.invoke('diag:openDevTools'),
});
