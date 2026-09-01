'use strict';
/**
 * Vision classification of captured thumbnails. (Epic E6.2)
 *
 * Approach: write PNGs to a temp dir (indexer.js), then hand the CLI their
 * paths and let it read them with its Read tool. Keeps us on the CLI backend —
 * no API key anywhere (decision, 31 Aug 2026).
 *
 * Labels are DERIVED AND APPROXIMATE. Doc 1 §A4.4 requires the agent to
 * distinguish a vision guess from a timecode; everything here is tagged so the
 * snapshot can carry that distinction through.
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const { findCLI } = require('./backend');

const BATCH_SIZE = 12;      // images per CLI call
const CALL_TIMEOUT_MS = 300000;

const CLASSIFY_PROMPT = `You are labelling frames from a single-camera outdoor hiking film so an
editor can search their footage. Each image is one frame sampled from one clip.

For EACH image return one object with these fields:
  "file"     the filename exactly as given
  "subject"  2-5 words, the main thing on screen (e.g. "granite ridgeline",
             "river over boulders", "hiker on trail", "pine forest canopy")
  "terrain"  one of: rock, forest, water, meadow, snow, sky, trail, camp, interior, other
  "shot"     one of: wide, medium, close, detail, pov
  "light"    one of: dawn, morning, midday, overcast, golden, dusk, night, unknown
  "motion"   one of: static, pan, tilt, handheld, walking, unknown
  "notes"    optional, <=10 words, only if something is genuinely distinctive
  "conf"     your confidence 0.0-1.0 that this labelling is right

Rules:
- Judge ONLY what is visible. Do not infer a location or a name.
- If a frame is black, blurred, or unreadable, set subject to "unclear" and conf below 0.3.
- Be consistent: the same kind of shot should get the same terrain and shot values.

Return ONLY a JSON array, no prose, no markdown fence.`;

function childEnv() {
  const HOME = os.homedir();
  const cliDir = path.dirname(findCLI() || '');
  return {
    ...process.env,
    HOME,
    PATH: [cliDir, `${HOME}/.local/bin`, '/usr/local/bin', '/opt/homebrew/bin',
           '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':'),
  };
}

function runCLI(prompt, cwd) {
  return new Promise((resolve) => {
    const cli = findCLI();
    if (!cli) return resolve({ ok: false, error: 'Claude CLI not found' });

    // Reading files needs BOTH the tool allowed and the directory granted.
    // `acceptEdits` covers writes, not reads of an untrusted dir — which is
    // why the first attempt returned zero labels. We pass the thumbnail dir
    // explicitly with --add-dir and bypass prompts, since this is a
    // non-interactive subprocess with nobody to answer them.
    const args = [
      '-p',
      '--output-format', 'json',
      '--allowedTools', 'Read,Glob',
      '--add-dir', cwd,
      '--permission-mode', 'bypassPermissions',
    ];

    const child = spawn(cli, args, { env: childEnv(), cwd, stdio: ['pipe', 'pipe', 'pipe'] });

    let out = '', err = '', done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish({ ok: false, error: 'vision call timed out' });
    }, CALL_TIMEOUT_MS);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (code !== 0) return finish({ ok: false, error: `CLI exited ${code}`, stderr: err.slice(0, 800) });
      try {
        const p = JSON.parse(out);
        finish({ ok: true, text: p.result ?? out });
      } catch (_) {
        finish({ ok: true, text: out });
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Pull a JSON array out of a model response that may be fenced or padded. */
function extractJSONArray(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const arr = JSON.parse(candidate.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {Array} captured  from indexer.capture() — each has {id, name, file}
 */
async function classify({ captured, dir, onProgress = () => {}, isCancelled = () => false }) {
  if (!captured || !captured.length) return { ok: false, error: 'nothing captured' };

  const byFile = new Map(captured.map((c) => [path.basename(c.file), c]));
  const labels = [];
  const problems = [];
  const t0 = Date.now();

  for (let i = 0; i < captured.length; i += BATCH_SIZE) {
    if (isCancelled()) break;
    const batch = captured.slice(i, i + BATCH_SIZE);
    // Absolute paths — cwd is not something we should rely on across a spawn
    // boundary, and the plugin's own cwd is inside the Resolve app bundle.
    const list = batch.map((c) => `- ${c.file}`).join('\n');

    const prompt =
      `${CLASSIFY_PROMPT}\n\nRead each of these image files and label it. ` +
      `Use the Read tool on each path. The "file" field in your output must be the ` +
      `BASENAME only (e.g. 0003_a1b2c3d4.png), not the full path.\n\n${list}\n`;

    const r = await runCLI(prompt, dir);
    if (!r.ok) {
      problems.push({ batch: i / BATCH_SIZE, error: r.error, stderr: r.stderr });
      onProgress({ done: Math.min(i + BATCH_SIZE, captured.length), total: captured.length, ok: false });
      continue;
    }

    const arr = extractJSONArray(r.text);
    if (!arr) {
      problems.push({ batch: i / BATCH_SIZE, error: 'could not parse JSON from response',
                      sample: String(r.text).slice(0, 300) });
      onProgress({ done: Math.min(i + BATCH_SIZE, captured.length), total: captured.length, ok: false });
      continue;
    }

    for (const row of arr) {
      const clip = byFile.get(row.file) || byFile.get(path.basename(String(row.file || '')));
      if (!clip) { problems.push({ error: 'label for unknown file', file: row.file }); continue; }
      labels.push({
        id: clip.id,
        name: clip.name,
        startTC: clip.startTC,
        subject: row.subject || null,
        terrain: row.terrain || null,
        shot: row.shot || null,
        light: row.light || null,
        motion: row.motion || null,
        notes: row.notes || null,
        conf: typeof row.conf === 'number' ? row.conf : null,
      });
    }
    onProgress({ done: Math.min(i + BATCH_SIZE, captured.length), total: captured.length, ok: true });
  }

  return {
    ok: true,
    labels,
    problems,
    labelled: labels.length,
    expected: captured.length,
    ms: Date.now() - t0,
  };
}

/** Render a label as the single line we write into the Comments field. */
function toComment(l) {
  const bits = [l.subject, l.terrain, l.shot, l.light].filter(Boolean);
  const conf = l.conf !== null && l.conf < 0.5 ? ' (low confidence)' : '';
  return `[agent] ${bits.join(' · ')}${l.notes ? ' — ' + l.notes : ''}${conf}`;
}

/** Coarse clip colour by terrain, so categories are visible on the timeline. */
const TERRAIN_COLOR = {
  rock: 'Brown', forest: 'Green', water: 'Blue', meadow: 'Lime',
  snow: 'Navy', sky: 'Teal', trail: 'Yellow', camp: 'Orange',
  interior: 'Violet', other: 'Pink',
};
function toClipColor(l) {
  return TERRAIN_COLOR[l.terrain] || null;
}

module.exports = { classify, toComment, toClipColor, extractJSONArray, BATCH_SIZE };
