'use strict';
/**
 * Thumbnail capture pass. (Epic E6.1)
 *
 * VERIFIED BEHAVIOUR this depends on (findings/2026-08-31-scripting-api.md):
 *  - Timeline:GetCurrentClipThumbnailImage() returns nil on the EDIT page.
 *    It works ONLY on the COLOR page. This is the whole reason for the page
 *    switching below.
 *  - SetCurrentTimecode() reliably drives which clip the Color page considers
 *    current: landed correctly 10/10 in testing.
 *  - A cold Color page returns a few nils before warming up (3/5 on first run,
 *    10/10 on second). Hence the retry.
 *  - ~500ms per clip end to end, so ~90s for 181 clips.
 *
 * This pass MUTATES UI STATE (current page, playhead) but NOT the project.
 * It restores both when done, including on cancel and on error.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { get, call } = require('../resolve/calls');
const client = require('../resolve/client');
const { framesToTC } = require('./timecode');
const png = require('./png');

// TIMING — learned the hard way, 1 Sep 2026.
// OpenPage() and SetCurrentTimecode() both return immediately, but Resolve
// needs real time to load the Color page and render the frame. A tight JS loop
// captured 0/10 at 113ms/clip; the Lua console version succeeded 10/10 at
// ~500ms/clip purely because console round-trip overhead happened to provide
// the delay. So we wait deliberately rather than by accident.
const PAGE_SETTLE_MS = 1500;   // after switching to the Color page
const SEEK_SETTLE_MS = 120;    // after moving the playhead, before first grab
const RETRY_SLEEP_MS = 90;     // between thumbnail attempts
const THUMB_RETRIES = 8;       // ~= 850ms worst case per clip

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Sample a frame a little way into the clip — the first frame is often a
// dissolve-in, a black frame, or camera still settling.
const SAMPLE_OFFSET_FRACTION = 0.35;
const MIN_SAMPLE_OFFSET = 12;

function outputDir() {
  const d = path.join(os.tmpdir(), 'resolve-agent-thumbs');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * @param {object} opts
 * @param {function} opts.onProgress  ({done, total, name, ok}) => void
 * @param {function} opts.isCancelled () => boolean
 * @param {number}   opts.limit       cap clips (for a quick trial run)
 */
async function capture({ onProgress = () => {}, isCancelled = () => false, limit = null } = {}) {
  const resolve = client.getResolve();
  if (!resolve) return { ok: false, error: 'not connected' };

  const pm = get(resolve, 'GetProjectManager', null);
  const proj = pm ? get(pm, 'GetCurrentProject', null) : null;
  const tl = proj ? get(proj, 'GetCurrentTimeline', null) : null;
  if (!tl) return { ok: false, error: 'no timeline open' };

  // ---- save UI state so we can put the user back exactly where they were
  const originalPage = get(resolve, 'GetCurrentPage', 'edit');
  const originalTC = get(tl, 'GetCurrentTimecode', null);

  const fpsRaw = get(tl, 'GetSetting', null, 'timelineFrameRate');
  const fps = fpsRaw ? parseFloat(fpsRaw) : 24;

  // ---- collect video clips
  const clips = [];
  const vCount = get(tl, 'GetTrackCount', 0, 'video');
  for (let i = 1; i <= vCount; i++) {
    const items = get(tl, 'GetItemListInTrack', null, 'video', i);
    if (!items) continue;
    for (const it of items) {
      clips.push({
        item: it,
        id: get(it, 'GetUniqueId', null),
        name: get(it, 'GetName', null),
        start: get(it, 'GetStart', null),
        duration: get(it, 'GetDuration', null),
        trackIndex: i,
      });
    }
  }
  const targets = limit ? clips.slice(0, limit) : clips;

  const dir = outputDir();
  const captured = [];
  const failures = [];
  const t0 = Date.now();
  let cancelled = false;

  try {
    const opened = call(resolve, 'OpenPage', 'color');
    if (!opened.ok) {
      return { ok: false, error: 'could not switch to the Color page; thumbnails are unavailable elsewhere' };
    }
    await sleep(PAGE_SETTLE_MS);

    let mismatches = 0;

    for (let n = 0; n < targets.length; n++) {
      if (isCancelled()) { cancelled = true; break; }

      const c = targets[n];
      const offset = Math.max(MIN_SAMPLE_OFFSET, Math.floor((c.duration || 0) * SAMPLE_OFFSET_FRACTION));
      const targetFrame = (c.start || 0) + offset;

      call(tl, 'SetCurrentTimecode', framesToTC(targetFrame, fps));
      await sleep(SEEK_SETTLE_MS);

      let thumb = null;
      let attempts = 0;
      while (!thumb && attempts < THUMB_RETRIES) {
        attempts++;
        thumb = get(tl, 'GetCurrentClipThumbnailImage', null);
        if (!thumb) await sleep(RETRY_SLEEP_MS);
      }

      // Which clip did the Color page actually land on? Recorded as a WARNING,
      // not a hard failure — an ID mismatch may just mean the Color page's
      // item wrapper reports a different id than the track item does, which we
      // have not verified. Discarding a good frame over an unverified
      // assumption was the previous bug.
      const cur = get(tl, 'GetCurrentVideoItem', null);
      const curId = cur ? get(cur, 'GetUniqueId', null) : null;
      const curName = cur ? get(cur, 'GetName', null) : null;
      const nameMatches = curName && c.name && curName === c.name;
      const idMatches = curId && c.id && curId === c.id;
      if (!nameMatches) mismatches++;

      if (!thumb) {
        failures.push({
          id: c.id, name: c.name, attempts,
          reason: 'no thumbnail after retries',
          landedOn: curName || '(nothing)',
        });
        onProgress({ done: n + 1, total: targets.length, name: c.name, ok: false });
        continue;
      }

      try {
        const file = path.join(dir, `${String(n).padStart(4, '0')}_${(c.id || '').slice(0, 8)}.png`);
        fs.writeFileSync(file, png.fromResolveThumbnail(thumb));
        captured.push({
          id: c.id,
          name: c.name,
          start: c.start,
          startTC: framesToTC(c.start, fps),
          duration: c.duration,
          trackIndex: c.trackIndex,
          file,
          attempts,
          idMatches,
          nameMatches,
          landedOn: curName || null,
        });
        onProgress({ done: n + 1, total: targets.length, name: c.name, ok: true });
      } catch (e) {
        failures.push({ id: c.id, name: c.name, reason: `encode failed: ${e.message}` });
        onProgress({ done: n + 1, total: targets.length, name: c.name, ok: false });
      }
    }

    // If the page never landed where we asked, the labels would be attached to
    // the wrong clips — worth surfacing loudly rather than shipping bad data.
    if (targets.length && mismatches === targets.length) {
      failures.push({ reason: 'EVERY clip mismatched by name — navigation is not working; labels would be wrong' });
    }
  } finally {
    // ---- ALWAYS restore, including on cancel or throw
    if (originalTC) call(tl, 'SetCurrentTimecode', originalTC);
    if (originalPage) call(resolve, 'OpenPage', originalPage);
  }

  return {
    ok: true,
    cancelled,
    dir,
    captured,
    failures,
    total: targets.length,
    ms: Date.now() - t0,
    msPerClip: targets.length ? Math.round((Date.now() - t0) / targets.length) : 0,
    restoredPage: originalPage,
    restoredTimecode: originalTC,
  };
}

/** Remove previously captured PNGs. */
function clean() {
  const dir = outputDir();
  let removed = 0;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.png')) { fs.unlinkSync(path.join(dir, f)); removed++; }
  }
  return { ok: true, removed, dir };
}

module.exports = { capture, clean, outputDir };
