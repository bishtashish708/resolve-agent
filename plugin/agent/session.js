'use strict';
/**
 * Long-lived Claude CLI session.
 *
 * WHY THIS EXISTS — measured 1 Sep 2026:
 *
 *   prompt size   ttft     wall
 *   tiny          1.6 s    2.5 s
 *   23k chars     6.7 s    7.8 s
 *
 * Spawning a fresh CLI per question means a fresh SESSION, so the whole
 * timeline context is written to cache every time and never read back
 * (`cache_creation_input_tokens: 26773`, `cache_read` covering only Claude
 * Code's own system prompt). That is ~5s of time-to-first-token and real cost,
 * paid on every question, for context that usually has not changed.
 *
 * So: one process, kept alive. Full context on the first turn. After that,
 * send ONLY the question whenever the snapshot is unchanged — the context
 * becomes a cache read instead of a cache write.
 *
 * The snapshot version/uniqueId is the drift guard: if the timeline moved, we
 * re-send context rather than letting the model reason from a stale picture.
 * Correctness beats latency (Doc 1 §A4.2).
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const { findCLI } = require('./backend');

const HOME = os.homedir();
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;   // recycle an unused session
const TURN_TIMEOUT_MS = 180000;
const MAX_TURNS_PER_SESSION = 40;         // guard against unbounded growth

let proc = null;
let ready = false;
let busy = false;
let turns = 0;
let idleTimer = null;

// What the live session has been told about the project.
let sessionKey = null;     // timeline uniqueId + name
let contextSent = false;

let pending = null;        // { resolve, onDelta, text, firstTokenMs, t0, meta }
let buf = '';
let stderrBuf = '';

function childEnv() {
  const cliDir = path.dirname(findCLI() || '');
  return {
    ...process.env,
    HOME,
    PATH: [cliDir, `${HOME}/.local/bin`, '/usr/local/bin', '/opt/homebrew/bin',
           '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':'),
  };
}

function stop(reason = 'stopped') {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (proc) {
    try { proc.kill('SIGKILL'); } catch (_) {}
  }
  proc = null;
  ready = false;
  busy = false;
  turns = 0;
  contextSent = false;
  sessionKey = null;
  buf = '';
  if (pending) {
    const p = pending;
    pending = null;
    p.resolve({ ok: false, error: `session ${reason}`, text: p.text || '' });
  }
}

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => stop('idle-recycled'), IDLE_TIMEOUT_MS);
}

function start(system) {
  const cli = findCLI();
  if (!cli) return { ok: false, error: 'Claude CLI not found' };

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    // NO TOOLS. This session answers questions about a data document we supply;
    // it has no reason to read files, run commands, or touch the network.
    // Without this it inherits Claude Code's full toolset and WILL use it — it
    // ran `echo "scanning"` via Bash on 1 Sep 2026 before this was locked down.
    '--allowedTools', '',
    '--disallowedTools', 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit',
    '--append-system-prompt', system,
  ];

  try {
    proc = spawn(cli, args, { env: childEnv(), cwd: HOME, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    proc = null;
    return { ok: false, error: `spawn failed: ${e.message}` };
  }

  ready = true;
  turns = 0;
  contextSent = false;
  buf = '';
  stderrBuf = '';

  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { handleEvent(JSON.parse(line)); } catch (_) { /* partial or noise */ }
    }
  });

  proc.stderr.on('data', (d) => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-4000);
  });

  proc.on('error', () => stop('process-error'));
  proc.on('close', () => stop('process-closed'));

  touchIdle();
  return { ok: true };
}

function handleEvent(ev) {
  if (!pending) return;
  const inner = ev.event || ev;

  if (inner.type === 'content_block_delta' && inner.delta) {
    // ONLY text_delta. `partial_json` is the streaming argument payload of a
    // TOOL CALL — concatenating it dumped `{"command":"echo \"scanning\""}`
    // into the middle of an answer. Tools are disabled now, but never render
    // non-text deltas regardless.
    const piece = inner.delta.type === 'text_delta' ? (inner.delta.text || '') : '';
    if (piece) {
      if (pending.firstTokenMs === null) pending.firstTokenMs = Date.now() - pending.t0;
      pending.text += piece;
      pending.onDelta(piece);
    }
    return;
  }

  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const b of ev.message.content) {
      if (b.type === 'text' && b.text && !pending.text) {
        if (pending.firstTokenMs === null) pending.firstTokenMs = Date.now() - pending.t0;
        pending.text += b.text;
        pending.onDelta(b.text);
      }
    }
    return;
  }

  if (ev.type === 'result') {
    const p = pending;
    pending = null;
    busy = false;
    turns++;
    touchIdle();

    if (!p.text && typeof ev.result === 'string') {
      p.text = ev.result;
      p.onDelta(ev.result);
    }
    clearTimeout(p.timer);
    p.resolve({
      ok: true,
      text: p.text,
      ms: Date.now() - p.t0,
      firstTokenMs: p.firstTokenMs,
      meta: {
        is_error: ev.is_error,
        duration_ms: ev.duration_ms,
        total_cost_usd: ev.total_cost_usd,
        // The number that tells us whether caching is actually working:
        // cache_read high + cache_creation low means the context was reused.
        cacheCreation: ev.usage && ev.usage.cache_creation_input_tokens,
        cacheRead: ev.usage && ev.usage.cache_read_input_tokens,
      },
    });
  }
}

function sendUserMessage(text) {
  const msg = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
  proc.stdin.write(JSON.stringify(msg) + '\n');
}

/**
 * Ask a question, reusing the live session when the timeline has not changed.
 *
 * @param {string} opts.system      system prompt (only used when starting)
 * @param {string} opts.context     full timeline context document
 * @param {string} opts.contextKey  identity of the current timeline state
 * @param {boolean} opts.contextChanged  true if the snapshot differs meaningfully
 */
function ask({ system, context, contextKey, contextChanged, question, onDelta = () => {} }) {
  return new Promise((resolve) => {
    if (busy) return resolve({ ok: false, error: 'a question is already in flight' });

    // (Re)start if needed.
    if (!proc || !ready) {
      const s = start(system);
      if (!s.ok) return resolve(s);
    }

    // Re-send context when the project/timeline identity changed, when the
    // snapshot drifted, or when this session has never been given one.
    const identityChanged = sessionKey !== contextKey;
    const needContext = !contextSent || identityChanged || contextChanged;

    let payload;
    if (needContext) {
      payload = `${context}\n\n---\n\nUSER QUESTION: ${question}`;
      contextSent = true;
      sessionKey = contextKey;
    } else {
      payload =
        `The timeline is unchanged since the state document I gave you earlier ` +
        `(snapshot key ${contextKey}). Answer from that.\n\n` +
        `USER QUESTION: ${question}`;
    }

    const t0 = Date.now();
    pending = {
      resolve,
      onDelta,
      text: '',
      firstTokenMs: null,
      t0,
      sentContext: needContext,
      timer: setTimeout(() => {
        const p = pending;
        pending = null;
        busy = false;
        stop('turn-timeout');
        if (p) p.resolve({ ok: false, error: `turn timed out after ${TURN_TIMEOUT_MS}ms`, text: p.text });
      }, TURN_TIMEOUT_MS),
    };
    busy = true;

    try {
      sendUserMessage(payload);
    } catch (e) {
      clearTimeout(pending.timer);
      pending = null;
      busy = false;
      stop('write-failed');
      return resolve({ ok: false, error: `could not write to session: ${e.message}` });
    }

    // Recycle long sessions so context does not grow without bound.
    if (turns >= MAX_TURNS_PER_SESSION) {
      setTimeout(() => { if (!busy) stop('turn-limit'); }, 0);
    }
  });
}

function state() {
  return {
    running: !!proc && ready,
    busy,
    turns,
    contextSent,
    sessionKey,
    stderr: stderrBuf.slice(-600),
  };
}

module.exports = { ask, stop, state };
