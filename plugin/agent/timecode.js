'use strict';
/**
 * Frames <-> timecode. (Doc 1 §B1.6 — frames are the unit; timecode is a
 * rendering produced at the display boundary only.)
 *
 * The reference project is 23.976 non-drop, which uses a 24-frame TC base.
 * Verified against the real timeline: frame 86400 renders as 01:00:00:00.
 */

/** Whole-number TC base for a given fps. 23.976 -> 24, 29.97 -> 30, etc. */
function tcBase(fps) {
  if (!fps || !isFinite(fps)) return 24;
  return Math.round(fps);
}

/**
 * Is this a drop-frame rate? 29.97 and 59.94 are, by convention, when the
 * timeline is set to drop-frame. 23.976 is NOT drop-frame.
 * We do not currently read the timeline's drop-frame flag, so we render
 * non-drop always and flag it here so the limitation is visible.
 */
function isDropFrameRate(fps) {
  return Math.abs(fps - 29.97) < 0.01 || Math.abs(fps - 59.94) < 0.01;
}

function framesToTC(frames, fps) {
  if (frames === null || frames === undefined || !isFinite(frames)) return '--:--:--:--';
  const base = tcBase(fps);
  const f = Math.max(0, Math.floor(frames));
  const ff = f % base;
  const total = Math.floor(f / base);
  const ss = total % 60;
  const mm = Math.floor(total / 60) % 60;
  const hh = Math.floor(total / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

function tcToFrames(tc, fps) {
  const m = /^(\d+):(\d+):(\d+)[:;](\d+)$/.exec(String(tc || '').trim());
  if (!m) return null;
  const base = tcBase(fps);
  return (+m[1]) * 3600 * base + (+m[2]) * 60 * base + (+m[3]) * base + (+m[4]);
}

/** Human duration, e.g. "13s" or "2m 04s" — for prose, never for instructions. */
function framesToHuman(frames, fps) {
  if (!frames || !fps) return '?';
  const s = frames / fps;
  if (s < 60) return `${s.toFixed(1)}s`;
  // BUG FIX 31 Aug 2026: Math.round(s % 60) can yield 60, producing "46m 60s".
  // Round the total first, then decompose.
  const total = Math.round(s);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  if (mm >= 60) {
    return `${Math.floor(mm / 60)}h ${String(mm % 60).padStart(2, '0')}m ${String(ss).padStart(2, '0')}s`;
  }
  return `${mm}m ${String(ss).padStart(2, '0')}s`;
}

module.exports = { framesToTC, tcToFrames, framesToHuman, tcBase, isDropFrameRate };
