'use strict';
/**
 * Connection to Resolve via WorkflowIntegration.node.
 *
 * Doc 2 E0 #1 — this module is loaded in the Electron MAIN process only.
 * The native module does not work in a sandboxed renderer.
 */

const path = require('path');
const { call, get } = require('./calls');

const PLUGIN_ID = 'com.resolveagent.plugin';
const API_TIMEOUT_SECS = 20;

let WI = null;
let resolve = null;
let capabilities = null;

function loadNativeModule() {
  if (WI) return WI;
  // macOS only for v1 (decided 31 Aug 2026). BMD ships this binary at:
  //   /Library/Application Support/Blackmagic Design/DaVinci Resolve/
  //     Developer/Workflow Integrations/WorkflowIntegration.node
  // install.sh copies it next to this plugin.
  WI = require(path.join(__dirname, '..', 'WorkflowIntegration.node'));
  return WI;
}

function connect() {
  try {
    loadNativeModule();
  } catch (e) {
    return { ok: false, stage: 'load', error: `Could not load WorkflowIntegration.node: ${e.message}` };
  }

  const info = get(WI, 'GetInfo', null);

  const init = call(WI, 'Initialize', PLUGIN_ID);
  if (!init.ok) {
    return { ok: false, stage: 'initialize', error: 'Initialize() failed', moduleInfo: info };
  }

  // Doc 2 E0 #3 — without this, a hung call never returns.
  // BMD documents only "by default, apis dont timeout". The modal-dialog
  // explanation for *why* is community inference (Doc 1 Q3).
  call(WI, 'SetAPITimeout', API_TIMEOUT_SECS);

  const r = call(WI, 'GetResolve');
  if (!r.ok) {
    return { ok: false, stage: 'getResolve', error: 'GetResolve() returned falsy', moduleInfo: info };
  }
  resolve = r.value;

  const version = get(resolve, 'GetVersionString', 'unknown');
  const product = get(resolve, 'GetProductName', 'unknown');

  return {
    ok: true,
    moduleInfo: info,
    resolveVersion: version,
    productName: product,
    pluginId: PLUGIN_ID,
    apiTimeoutSecs: API_TIMEOUT_SECS,
  };
}

/**
 * Doc 2 E3.5 — capability probe. Never compare version numbers, never bare try.
 * Doc 1 §B3.8 — our first attempt at a hardcoded "21.0-only" list was wrong in
 * both directions. Probe is the source of truth.
 *
 * F4 — Object.keys() returns nothing useful on native objects. Use
 * getOwnPropertyNames(getPrototypeOf(...)). Verified in Lua; re-verify here.
 */
function probe() {
  if (!resolve) return { ok: false, error: 'not connected' };

  const pm = get(resolve, 'GetProjectManager', null);
  const proj = pm ? get(pm, 'GetCurrentProject', null) : null;
  const tl = proj ? get(proj, 'GetCurrentTimeline', null) : null;

  const surface = (obj, label) => {
    if (!obj) return { label, present: false, methods: [] };
    let methods = [];
    try {
      const proto = Object.getPrototypeOf(obj);
      methods = proto ? Object.getOwnPropertyNames(proto) : [];
      if (methods.length === 0) methods = Object.getOwnPropertyNames(obj);
    } catch (e) {
      methods = [`<introspection failed: ${e.message}>`];
    }
    return { label, present: true, methodCount: methods.length, methods: methods.sort() };
  };

  capabilities = {
    resolve: surface(resolve, 'Resolve'),
    projectManager: surface(pm, 'ProjectManager'),
    project: surface(proj, 'Project'),
    timeline: surface(tl, 'Timeline'),
    workflowIntegration: {
      label: 'WorkflowIntegration',
      present: !!WI,
      methods: WI ? Object.getOwnPropertyNames(WI).sort() : [],
    },
  };
  return { ok: true, capabilities };
}

function getResolve() {
  return resolve;
}

function isConnected() {
  return !!resolve;
}

module.exports = { connect, probe, getResolve, isConnected, PLUGIN_ID };
