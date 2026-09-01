'use strict';
/**
 * LLM backend — Claude Code CLI as a subprocess. (Decision, 31 Aug 2026)
 *
 * No API key exists anywhere in this codebase. Auth is the user's existing
 * `claude` login (Pro/Max subscription).
 *
 * ---------------------------------------------------------------------------
 * CRITICAL, VERIFIED 31 Aug 2026 (findings/2026-08-31-plugin-shell.md):
 *   The plugin's PATH is  /usr/bin:/bin:/usr/sbin:/sbin
 *   NOT the user's shell PATH. ~/.local/bin is NOT on it.
 *   `claude` will NOT be found by name. We must resolve an absolute path and
 *   pass an explicit env to spawn. (Doc 2 E7.6)
 * ---------------------------------------------------------------------------
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();

// Ordered by likelihood. The ~/.local/bin entry is a SYMLINK that survives
// version updates — prefer it over the versioned target underneath.
const CANDIDATES = [
  path.join(HOME, '.local/bin/claude'),
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
  path.join(HOME, '.npm-global/bin/claude'),
  path.join(HOME, 'bin/claude'),
];

let cachedPath = null;

function findCLI() {
  if (cachedPath && fs.existsSync(cachedPath)) return cachedPath;
  for (const p of CANDIDATES) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      cachedPath = p;
      return p;
    } catch (_) {
      /* keep looking */
    }
  }
  return null;
}

function status() {
  const p = findCLI();
  if (!p) {
    return {
      ok: false,
      error: 'Claude CLI not found',
      searched: CANDIDATES,
      hint: 'Install with: curl -fsSL https://claude.ai/install.sh | bash',
    };
  }
  return { ok: true, path: p, pluginPath: process.env.PATH || '(empty)' };
}

/**
 * Build the env for the child. We do NOT inherit blindly — the inherited PATH
 * is useless, and the CLI needs HOME to find its credentials.
 */
function childEnv() {
  const cliDir = path.dirname(findCLI() || '');
  return {
    ...process.env,
    HOME,
    PATH: [cliDir, `${HOME}/.local/bin`, '/usr/local/bin', '/opt/homebrew/bin',
           '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':'),
  };
}

/**
 * One-shot ask. Non-streaming for v0 — correctness before UX.
 * Returns { ok, text, ms, raw?, error? }
 */
function ask({ system, context, question, timeoutMs = 120000 }) {
  return new Promise((resolve) => {
    const cli = findCLI();
    if (!cli) return resolve({ ok: false, error: 'Claude CLI not found', ...status() });

    const t0 = Date.now();
    const prompt = `${context}\n\n---\n\nUSER QUESTION: ${question}`;

    const args = [
      '-p',
      '--output-format', 'json',
      '--append-system-prompt', system,
    ];

    let child;
    try {
      child = spawn(cli, args, {
        env: childEnv(),
        cwd: HOME, // NOT the Resolve app bundle, which is where cwd defaults to
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ ok: false, error: `spawn failed: ${e.message}` });
    }

    let out = '';
    let err = '';
    let done = false;

    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...r, ms: Date.now() - t0 });
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish({ ok: false, error: `timed out after ${timeoutMs}ms`, partial: out.slice(0, 500) });
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });

    child.on('error', (e) => finish({ ok: false, error: `process error: ${e.message}` }));

    child.on('close', (code) => {
      if (code !== 0) {
        return finish({
          ok: false,
          error: `CLI exited ${code}`,
          stderr: err.slice(0, 1500),
          stdout: out.slice(0, 500),
          hint: /auth|login|credential/i.test(err)
            ? 'Looks like an auth problem — run `claude` once in Terminal to log in.'
            : undefined,
        });
      }
      // --output-format json returns a single JSON object with a `result` field.
      try {
        const parsed = JSON.parse(out);
        const text = parsed.result ?? parsed.text ?? parsed.content ?? null;
        if (typeof text === 'string') {
          return finish({ ok: true, text, meta: {
            is_error: parsed.is_error,
            duration_ms: parsed.duration_ms,
            num_turns: parsed.num_turns,
            total_cost_usd: parsed.total_cost_usd,
          }});
        }
        return finish({ ok: true, text: out.trim(), raw: true });
      } catch (_) {
        // Not JSON — fall back to raw stdout rather than failing.
        return finish({ ok: true, text: out.trim(), raw: true });
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

module.exports = { ask, status, findCLI };
