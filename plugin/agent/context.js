'use strict';
/**
 * Snapshot -> context document for the model. (Doc 1 §B1.8, Doc 2 E4.2)
 *
 * The model receives a shaped document, NOT the raw snapshot and NOT a set of
 * getters to walk. Compact text beats JSON here: ~50 chars per clip line vs
 * ~250 for pretty JSON, and it reads more like something to reason over.
 *
 * Doc 2 E4.3 — all arithmetic (durations, gaps, adjacency, TC conversion) is
 * done HERE, in code. The model is never asked to compute a timecode.
 */

const { framesToTC, framesToHuman } = require('./timecode');

const MAX_CLIP_LINES = 400; // full 362-clip timeline fits; beyond that we scope

function build(snap, { focusFrame = null, windowFrames = null } = {}) {
  if (!snap || !snap.ok) return { ok: false, error: (snap && snap.error) || 'no snapshot' };

  const fps = snap.timeline.fps || 24;
  const L = [];

  L.push('# CURRENT RESOLVE STATE');
  L.push(`snapshot v${snap.version} taken ${snap.takenAt}`);
  L.push('');
  L.push(`project:   ${snap.project.name}`);
  L.push(`timeline:  ${snap.timeline.name}`);
  L.push(`page:      ${snap.project.page}`);
  L.push(`fps:       ${fps}`);
  L.push(
    `range:     ${framesToTC(snap.timeline.startFrame, fps)} -> ` +
      `${framesToTC(snap.timeline.endFrame, fps)}  ` +
      `(${snap.derived.timelineFrames} frames, ${framesToHuman(snap.derived.timelineFrames, fps)})`
  );
  L.push(
    `playhead:  ${snap.timeline.currentTimecode || '(unavailable - not on Edit page)'}`
  );
  L.push('');

  // ---- tracks
  L.push('## TRACKS');
  for (const t of snap.tracks) {
    const flags = [];
    if (t.locked === true) flags.push('LOCKED');
    if (t.enabled === false) flags.push('DISABLED');
    const n = snap.clips.filter((c) => c.trackType === t.type && c.trackIndex === t.index).length;
    L.push(
      `${t.type}${t.index}  "${t.name}"  ${n} clips${flags.length ? '  [' + flags.join(' ') + ']' : ''}`
    );
  }
  L.push('');

  // ---- summary
  const d = snap.derived;
  L.push('## SUMMARY');
  L.push(`clips:       ${d.clipCount} (video ${d.videoClipCount}, audio ${d.audioClipCount})`);
  L.push(`cut points:  ${d.cutPointCount}`);
  L.push(`gaps:        ${d.gapCount}`);
  L.push(`markers:     ${snap.markers.length}`);
  L.push(
    `clip length: median ${d.medianClipFrames}f (${framesToHuman(d.medianClipFrames, fps)}), ` +
      `min ${d.shortestClipFrames}f, max ${d.longestClipFrames}f`
  );
  L.push('');

  // ---- gaps (usually the interesting anomaly)
  if (d.gaps.length) {
    L.push('## GAPS');
    for (const g of d.gaps.slice(0, 40)) {
      L.push(
        `${g.track}  ${framesToTC(g.from, fps)} -> ${framesToTC(g.to, fps)}  (${g.frames}f)`
      );
    }
    if (d.gaps.length > 40) L.push(`... and ${d.gaps.length - 40} more`);
    L.push('');
  }

  // ---- markers
  if (snap.markers.length) {
    L.push('## MARKERS');
    for (const m of snap.markers.slice(0, 60)) {
      const abs = snap.timeline.startFrame + m.frame;
      L.push(`${framesToTC(abs, fps)}  ${m.color}  "${m.name}"${m.note ? '  - ' + m.note : ''}`);
    }
    L.push('');
  }

  // ---- clips
  let clips = snap.clips.slice();
  let scoped = false;
  if (focusFrame !== null && windowFrames) {
    const lo = focusFrame - windowFrames;
    const hi = focusFrame + windowFrames;
    const inWindow = clips.filter((c) => c.end >= lo && c.start <= hi);
    if (inWindow.length) {
      clips = inWindow;
      scoped = true;
    }
  }
  if (clips.length > MAX_CLIP_LINES) {
    clips = clips.slice(0, MAX_CLIP_LINES);
    scoped = true;
  }

  clips.sort((a, b) =>
    a.trackType === b.trackType
      ? a.trackIndex === b.trackIndex
        ? a.start - b.start
        : a.trackIndex - b.trackIndex
      : a.trackType < b.trackType
        ? -1
        : 1
  );

  const labels = snap.contentLabels || {};
  const haveLabels = Object.keys(labels).length > 0;

  L.push('## CLIPS');
  L.push(
    '# track | start TC | end TC | frames | name | handle L/R | id' +
      (haveLabels ? ' | content (APPROXIMATE)' : '')
  );
  for (const c of clips) {
    const row = [
      `${c.trackType[0].toUpperCase()}${c.trackIndex}`,
      framesToTC(c.start, fps),
      framesToTC(c.end, fps),
      `${c.duration}f`,
      c.name,
      `${c.leftOffset ?? '?'}/${c.rightOffset ?? '?'}`,
      (c.id || '').slice(0, 8),
    ];
    if (haveLabels) row.push(labels[c.id] || '—');
    L.push(row.join(' | '));
  }
  if (scoped) {
    L.push('');
    L.push(`NOTE: clip list was scoped — showing ${clips.length} of ${snap.clips.length}.`);
  }
  L.push('');

  // ---- how to treat content labels
  if (haveLabels) {
    L.push('## ABOUT THE CONTENT COLUMN');
    L.push(`${Object.keys(labels).length} of ${snap.clips.length} clips have a content label.`);
    L.push('These come from a vision model looking at ONE sampled frame per clip.');
    L.push('They are APPROXIMATE and are a different kind of fact from timecodes:');
    L.push('- Treat them as a searchable index, not as ground truth.');
    L.push('- Say "labelled as" or "looks like", not "is".');
    L.push('- A label marked "(low confidence)" should be offered with a caveat.');
    L.push('- One frame cannot represent a whole clip; content may change within it.');
    L.push('- Clips marked "—" were not labelled. Never assume they lack that content.');
    L.push('');
  }

  // ---- what the API cannot see (Doc 1 §A4.4)
  L.push('## NOT VISIBLE TO THE API');
  L.push('These are invisible, NOT absent. Never say the timeline "has none" of these:');
  for (const u of snap.unavailable) L.push(`- ${u}`);

  const text = L.join('\n');
  return {
    ok: true,
    text,
    chars: text.length,
    clipsIncluded: clips.length,
    clipsTotal: snap.clips.length,
    scoped,
    snapshotVersion: snap.version,
  };
}

module.exports = { build };
