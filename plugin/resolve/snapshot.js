'use strict';
/**
 * The timeline snapshot. (Doc 1 §B1)
 *
 * ONE structured read, taken as a unit, version-stamped. The agent never
 * reasons from ad-hoc getter calls.
 *
 * Measured 31 Aug 2026 on a 362-clip / 47-min timeline: ~1 second, ~0.3ms per
 * API call. The community's ~15ms figure is wrong by ~50x. Because a full read
 * is this cheap, we do NOT implement elaborate tiering (Doc 1 §B2.2) — we just
 * re-read.
 */

const { call, get, stats, clear } = require('./calls');
const client = require('./client');

let version = 0;

const TRACK_TYPES = ['video', 'audio', 'subtitle'];

function take({ includeMarkers = true } = {}) {
  const t0 = Date.now();
  clear();

  const resolve = client.getResolve();
  if (!resolve) return { ok: false, error: 'not connected' };

  const pm = get(resolve, 'GetProjectManager', null);
  if (!pm) return { ok: false, error: 'no ProjectManager' };

  const proj = get(pm, 'GetCurrentProject', null);
  if (!proj) return { ok: false, error: 'no project open' };

  const tl = get(proj, 'GetCurrentTimeline', null);
  if (!tl) return { ok: false, error: 'no timeline open' };

  // ---- project / timeline header
  const page = get(resolve, 'GetCurrentPage', null);
  const fpsRaw = get(tl, 'GetSetting', null, 'timelineFrameRate');
  const fps = fpsRaw ? parseFloat(fpsRaw) : null;

  const snap = {
    ok: true,
    version: ++version,
    takenAt: new Date().toISOString(),
    project: {
      name: get(proj, 'GetName', null),
      page,
      timelineCount: get(proj, 'GetTimelineCount', null),
    },
    timeline: {
      name: get(tl, 'GetName', null),
      uniqueId: get(tl, 'GetUniqueId', null),
      startFrame: get(tl, 'GetStartFrame', null),
      endFrame: get(tl, 'GetEndFrame', null),
      startTimecode: get(tl, 'GetStartTimecode', null),
      // F4 — playhead calls are PAGE-STATE DEPENDENT. On a non-Edit page these
      // return nil. Never assume they are present.
      currentTimecode: get(tl, 'GetCurrentTimecode', null),
      fps,
    },
    tracks: [],
    clips: [],
    markers: [],
    derived: {},
    // Doc 1 §B1.5 — the agent must distinguish "absent from the timeline" from
    // "invisible to the API".
    unavailable: [
      'transitions (no API — cannot read or create)',
      'per-clip audio level / pan / fades',
      'effect instances on clips',
      'keyframe data on clip properties',
      'retime curves and speed',
      'title text and styling',
      'timeline selection (neither readable nor writable)',
    ],
    timings: {},
  };

  // ---- tracks
  const tTracks = Date.now();
  for (const tt of TRACK_TYPES) {
    const n = get(tl, 'GetTrackCount', 0, tt);
    for (let i = 1; i <= n; i++) {
      snap.tracks.push({
        type: tt,
        index: i,
        name: get(tl, 'GetTrackName', null, tt, i),
        subType: get(tl, 'GetTrackSubType', null, tt, i),
        enabled: get(tl, 'GetIsTrackEnabled', null, tt, i),
        locked: get(tl, 'GetIsTrackLocked', null, tt, i),
      });
    }
  }
  snap.timings.tracksMs = Date.now() - tTracks;

  // ---- clips
  const tClips = Date.now();
  for (const tt of ['video', 'audio']) {
    const n = get(tl, 'GetTrackCount', 0, tt);
    for (let i = 1; i <= n; i++) {
      const items = get(tl, 'GetItemListInTrack', null, tt, i);
      if (!items || !items.length) continue;
      for (const it of items) {
        // Doc 1 §B1.3 — GetUniqueId is identity. Names are NOT unique
        // (verified: camera originals repeat, and `Usage` showed a clip used
        // twice). Names and timecodes are for display and instruction only.
        snap.clips.push({
          id: get(it, 'GetUniqueId', null),
          name: get(it, 'GetName', null),
          trackType: tt,
          trackIndex: i,
          start: get(it, 'GetStart', null),
          end: get(it, 'GetEnd', null),
          duration: get(it, 'GetDuration', null),
          leftOffset: get(it, 'GetLeftOffset', null),   // available handle, READ ONLY
          rightOffset: get(it, 'GetRightOffset', null), // available handle, READ ONLY
          sourceStart: get(it, 'GetSourceStartFrame', null),
          sourceEnd: get(it, 'GetSourceEndFrame', null),
          enabled: get(it, 'GetClipEnabled', null),
          color: get(it, 'GetClipColor', null),
        });
      }
    }
  }
  snap.timings.clipsMs = Date.now() - tClips;

  // ---- markers
  if (includeMarkers) {
    const tM = Date.now();
    const mk = get(tl, 'GetMarkers', null);
    if (mk && typeof mk === 'object') {
      for (const frame of Object.keys(mk)) {
        const m = mk[frame];
        snap.markers.push({
          frame: Number(frame),
          color: m.color,
          name: m.name,
          note: m.note,
          duration: m.duration,
        });
      }
    }
    snap.timings.markersMs = Date.now() - tM;
  }

  // ---- content labels (E6) — derived and APPROXIMATE, unlike everything else
  // in this snapshot. Kept in a separate field so the agent can hedge on them
  // while staying precise about timecodes (Doc 1 §A4.4).
  try {
    const labels = require('../agent/labels').read();
    snap.contentLabels = labels;
    snap.contentLabelCount = Object.keys(labels).length;
  } catch (e) {
    snap.contentLabels = {};
    snap.contentLabelCount = 0;
  }

  // ---- derived (Doc 1 §B1.4 — computed in code, NEVER inferred by the model)
  snap.derived = computeDerived(snap);

  snap.timings.totalMs = Date.now() - t0;
  snap.timings.calls = stats();
  return snap;
}

/**
 * Doc 1 §B1.4 — gaps, adjacency, cut points, "what's under the playhead".
 * The model must never be asked to do frame arithmetic it can get wrong.
 */
function computeDerived(snap) {
  const byTrack = {};
  for (const c of snap.clips) {
    const k = `${c.trackType}${c.trackIndex}`;
    (byTrack[k] = byTrack[k] || []).push(c);
  }

  const gaps = [];
  const cutPoints = [];
  for (const k of Object.keys(byTrack)) {
    const list = byTrack[k].slice().sort((a, b) => a.start - b.start);
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i];
      const b = list[i + 1];
      if (b.start > a.end) {
        gaps.push({ track: k, from: a.end, to: b.start, frames: b.start - a.end });
      } else if (b.start === a.end) {
        cutPoints.push({ track: k, frame: a.end, outgoing: a.id, incoming: b.id });
      }
    }
  }

  const durations = snap.clips.map((c) => c.duration).filter((d) => typeof d === 'number');
  durations.sort((a, b) => a - b);

  return {
    clipCount: snap.clips.length,
    videoClipCount: snap.clips.filter((c) => c.trackType === 'video').length,
    audioClipCount: snap.clips.filter((c) => c.trackType === 'audio').length,
    trackCount: snap.tracks.length,
    timelineFrames:
      snap.timeline.endFrame != null && snap.timeline.startFrame != null
        ? snap.timeline.endFrame - snap.timeline.startFrame
        : null,
    gaps,
    gapCount: gaps.length,
    cutPoints,
    cutPointCount: cutPoints.length,
    medianClipFrames: durations.length ? durations[Math.floor(durations.length / 2)] : null,
    shortestClipFrames: durations.length ? durations[0] : null,
    longestClipFrames: durations.length ? durations[durations.length - 1] : null,
    lockedTracks: snap.tracks.filter((t) => t.locked === true).map((t) => `${t.type}${t.index}`),
    disabledTracks: snap.tracks.filter((t) => t.enabled === false).map((t) => `${t.type}${t.index}`),
  };
}

/**
 * Structural fingerprint of a snapshot. (Doc 1 §B1.7)
 *
 * Used to decide whether a live model session still has an accurate picture of
 * the timeline. If this is unchanged, the session can be reused and the context
 * becomes a cache read instead of a cache write (~5s and real cost per question).
 *
 * DELIBERATELY EXCLUDES the playhead: moving the playhead does not change the
 * timeline, and treating it as drift would defeat the whole optimisation.
 * INCLUDES content labels, because a label written between questions genuinely
 * changes what the model can answer.
 */
function fingerprint(snap) {
  if (!snap || !snap.ok) return 'invalid';

  const parts = [
    snap.project.name,
    snap.timeline.uniqueId,
    snap.timeline.name,
    snap.timeline.startFrame,
    snap.timeline.endFrame,
    snap.tracks.length,
    snap.clips.length,
    snap.markers.length,
    snap.contentLabelCount || 0,
  ];

  // Clip identity + position. Cheap rolling hash — we need change detection,
  // not cryptographic strength.
  let h = 5381;
  const mix = (s) => {
    const str = String(s);
    for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  };
  for (const c of snap.clips) { mix(c.id); mix(c.start); mix(c.end); mix(c.trackIndex); }
  for (const t of snap.tracks) { mix(t.type); mix(t.index); mix(t.locked); mix(t.enabled); }
  for (const m of snap.markers) { mix(m.frame); mix(m.name); }

  return `${parts.join('|')}#${h.toString(36)}`;
}

module.exports = { take, fingerprint };
