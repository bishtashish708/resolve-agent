'use strict';
/**
 * Electron main. WIRING ONLY — no business logic. (Doc 2 E1.1)
 *
 * Doc 2 E0 #4 — we do NOT set nodeIntegration / contextIsolation / sandbox.
 * Electron 36 defaults are correct: sandbox on, isolation on, node off.
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

const client = require('./resolve/client');
const snapshot = require('./resolve/snapshot');
const calls = require('./resolve/calls');
const backend = require('./agent/backend');
const context = require('./agent/context');
const prompt = require('./agent/prompt');
const indexer = require('./agent/indexer');
const vision = require('./agent/vision');
const labels = require('./agent/labels');
const session = require('./agent/session');

let win = null;
let askCounter = 0;
let lastFingerprint = null;

/** Push an event to the renderer. No-op if the window is gone. */
const emit = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

function createWindow() {
  win = new BrowserWindow({
    width: 520,
    height: 760,
    useContentSize: true,
    title: 'Resolve Agent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));

  // Doc 1 Q7 — is the window genuinely always-on-top, or just a separate
  // top-level window? NOT set here on purpose: v0 leaves it alone so we can
  // observe the default behaviour and answer the question.
}

app.whenReady().then(createWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  // Kill the long-lived CLI child, or it outlives the plugin window.
  try { session.stop('app-quit'); } catch (_) {}

  // ------------------------------------------------------------------
  // Doc 2 E0 #2 — DO NOT call WorkflowIntegration.CleanUp().
  // BMD's README says to call it on quit. One project reports it blocks the
  // main thread indefinitely on Resolve 21 and leaks the process holding a
  // file lock on the native module.
  // This overrides vendor docs on a single community report, so it is
  // PROVISIONAL — spike 0.7 verifies it on 21.0.3.7. If CleanUp turns out to
  // be fine, put it back here.
  // ------------------------------------------------------------------
  app.exit(0);
});

// ---------------------------------------------------------------- IPC
// Doc 2 E2.4 — handlers contain no business logic. Validate, delegate, shape.

ipcMain.handle('resolve:connect', async () => {
  try {
    return client.connect();
  } catch (e) {
    return { ok: false, stage: 'exception', error: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('resolve:snapshot', async () => {
  try {
    return snapshot.take();
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('resolve:probe', async () => {
  try {
    return client.probe();
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('diag:callLog', async () => ({
  stats: calls.stats(),
  // Failures are tracked in a dedicated list so a large read can never evict
  // them from the ring buffer.
  recent: calls.failures(),
}));

ipcMain.handle('diag:env', async () => ({
  electron: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
  modules: process.versions.modules, // ABI — expected 135 on Electron 36
  platform: process.platform,
  arch: process.arch,
  // Doc 2 E7.6 — the plugin inherits Resolve's PATH, not the user's shell.
  // Recording it now because the Claude CLI subprocess will need this later.
  path: process.env.PATH || '(none)',
  cwd: process.cwd(),
  execPath: process.execPath,
}));

// ---------------------------------------------------------------- agent

ipcMain.handle('agent:status', async () => backend.status());

ipcMain.handle('agent:ask', async (_e, question) => {
  if (typeof question !== 'string' || !question.trim()) {
    return { ok: false, error: 'empty question' };
  }

  // Doc 1 §B2.3 / §A4.2 — always answer from a FRESH snapshot. A full read is
  // ~350ms measured, so there is no performance reason to reason from stale data.
  const tSnap = Date.now();
  const snap = snapshot.take();
  const snapMs = Date.now() - tSnap;
  if (!snap.ok) {
    return { ok: false, error: `Could not read the timeline: ${snap.error}`, layer: 'resolve' };
  }

  const ctx = context.build(snap);
  if (!ctx.ok) return { ok: false, error: ctx.error, layer: 'plugin' };

  // Reuse the live session when the timeline hasn't moved. Measured: sending
  // 23k of context costs ~5s of time-to-first-token and a full cache WRITE
  // every time, because each spawn is a new session. Same context in an
  // existing session is a cache READ.
  const fp = snapshot.fingerprint(snap);
  const contextChanged = fp !== lastFingerprint;
  lastFingerprint = fp;

  const askId = ++askCounter;
  emit('agent:delta', { askId, phase: 'start' });

  const r = await session.ask({
    system: prompt.build(),
    context: ctx.text,
    contextKey: fp,
    contextChanged,
    question,
    onDelta: (piece) => emit('agent:delta', { askId, text: piece }),
  });

  // A dead or wedged session shouldn't cost the user their question — fall
  // back to a one-shot spawn, which is slower but independent.
  if (!r.ok && /session|write|spawn/i.test(r.error || '')) {
    const fb = await backend.askStream({
      system: prompt.build(),
      context: ctx.text,
      question,
      onDelta: (piece) => emit('agent:delta', { askId, text: piece }),
    });
    return decorate(fb, { fellBack: true, sentContext: true });
  }

  return decorate(r, { fellBack: false, sentContext: contextChanged });

  function decorate(res, extra) {
    return {
      ...res,
      askId,
      layer: res.ok ? undefined : 'model',
      diag: {
        snapshotMs: snapMs,
        snapshotVersion: snap.version,
        contextChars: ctx.chars,
        clipsIncluded: ctx.clipsIncluded,
        clipsTotal: ctx.clipsTotal,
        scoped: ctx.scoped,
        promptVersion: prompt.PROMPT_VERSION,
        apiCalls: snap.timings.calls.count,
        firstTokenMs: res.firstTokenMs,
        sentContext: extra.sentContext,
        fellBack: extra.fellBack,
        sessionTurns: session.state().turns,
        cacheCreation: res.meta && res.meta.cacheCreation,
        cacheRead: res.meta && res.meta.cacheRead,
      },
    };
  }
});

/**
 * Prime the session before the user asks anything.
 *
 * Measured: the first question pays ~18s of time-to-first-token because the
 * context is a cold cache write; the second costs ~1.7s. Nothing about that is
 * specific to the user's question, so we can pay it up front while they are
 * still reading the panel.
 *
 * Deliberately asks a trivial question — the answer is discarded, the point is
 * the warm cache.
 */
ipcMain.handle('agent:prewarm', async () => {
  if (session.state().busy) return { ok: false, error: 'busy' };
  const t0 = Date.now();

  const snap = snapshot.take();
  if (!snap.ok) return { ok: false, error: snap.error };

  const ctx = context.build(snap);
  if (!ctx.ok) return { ok: false, error: ctx.error };

  const fp = snapshot.fingerprint(snap);
  lastFingerprint = fp;

  const r = await session.ask({
    system: prompt.build(),
    context: ctx.text,
    contextKey: fp,
    contextChanged: true,
    question:
      'Reply with exactly: READY. Do not describe the timeline, do not list anything.',
    onDelta: () => {},
  });

  return {
    ok: r.ok,
    error: r.error,
    ms: Date.now() - t0,
    firstTokenMs: r.firstTokenMs,
    contextChars: ctx.chars,
    clips: ctx.clipsTotal,
    labelled: snap.contentLabelCount || 0,
  };
});

ipcMain.handle('agent:resetSession', async () => {
  session.stop('user-reset');
  lastFingerprint = null;
  return { ok: true };
});

ipcMain.handle('agent:sessionState', async () => session.state());

// ---------------------------------------------------------------- E6 index
// Content understanding. The capture pass mutates UI state (page + playhead)
// and restores it; label writing mutates the PROJECT and is gated behind an
// explicit dry-run -> review -> apply flow.

let indexState = { running: false, cancel: false, last: null };

ipcMain.handle('index:cancel', async () => {
  indexState.cancel = true;
  return { ok: true };
});

ipcMain.handle('index:run', async (_e, opts = {}) => {
  if (indexState.running) return { ok: false, error: 'an index pass is already running' };
  indexState = { running: true, cancel: false, last: null };

  try {
    const cap = await indexer.capture({
      limit: opts.limit || null,
      isCancelled: () => indexState.cancel,
      onProgress: (p) => emit('index:progress', { phase: 'capture', ...p }),
    });
    if (!cap.ok) return { ok: false, phase: 'capture', error: cap.error };

    emit('index:progress', { phase: 'capture-done', ...cap, captured: cap.captured.length });

    if (indexState.cancel || !cap.captured.length) {
      return { ok: true, cancelled: indexState.cancel, capture: summarise(cap), labels: [] };
    }

    const vis = await vision.classify({
      captured: cap.captured,
      dir: cap.dir,
      isCancelled: () => indexState.cancel,
      onProgress: (p) => emit('index:progress', { phase: 'classify', ...p }),
    });
    if (!vis.ok) return { ok: false, phase: 'classify', error: vis.error, capture: summarise(cap) };

    // ALWAYS dry-run first. Nothing is written until the user says so.
    const plan = labels.apply(vis.labels, { dryRun: true });

    indexState.last = { labels: vis.labels, capture: summarise(cap), vision: vis };
    return {
      ok: true,
      cancelled: indexState.cancel,
      capture: summarise(cap),
      vision: { labelled: vis.labelled, expected: vis.expected, ms: vis.ms, problems: vis.problems },
      plan,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    indexState.running = false;
  }
});

ipcMain.handle('index:apply', async (_e, opts = {}) => {
  if (!indexState.last || !indexState.last.labels) {
    return { ok: false, error: 'no labels pending — run an index pass first' };
  }
  return labels.apply(indexState.last.labels, {
    dryRun: false,
    writeColor: opts.writeColor !== false,
    preserveExisting: opts.preserveExisting !== false,
  });
});

ipcMain.handle('index:revert', async () => labels.revert({ clearColor: true }));

ipcMain.handle('index:clean', async () => indexer.clean());

function summarise(cap) {
  return {
    total: cap.total,
    captured: cap.captured.length,
    failures: cap.failures,
    mismatches: cap.captured.filter((c) => c.nameMatches === false).length,
    ms: cap.ms,
    msPerClip: cap.msPerClip,
    dir: cap.dir,
    restoredPage: cap.restoredPage,
    restoredTimecode: cap.restoredTimecode,
  };
}

ipcMain.handle('diag:openDevTools', async () => {
  if (win) win.webContents.openDevTools({ mode: 'detach' });
  return true;
});
