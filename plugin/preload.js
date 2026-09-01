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
  callLog: () => ipcRenderer.invoke('diag:callLog'),
  env: () => ipcRenderer.invoke('diag:env'),
  openDevTools: () => ipcRenderer.invoke('diag:openDevTools'),
});
