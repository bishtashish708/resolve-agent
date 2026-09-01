'use strict';
/**
 * Label persistence. (Epic E6.3)
 *
 * THIS IS THE FIRST CODE IN THE PROJECT THAT WRITES TO THE USER'S PROJECT.
 * It is deliberately conservative:
 *
 *   - It writes to exactly two places, both verified reversible on 31 Aug 2026:
 *       MediaPoolItem:SetMetadata("Comments", ...)   -> true
 *       MediaPoolItem:SetClipColor(name)             -> true
 *     It NEVER touches timeline structure, grades, or media.
 *   - `SetMetadata("Keyword", ...)` returns false — reserved. Do not try it.
 *   - `SetClipProperty("Keyword", ...)` also fails; SetClipProperty only
 *     accepts a small settable subset. Use SetMetadata.
 *   - Every write is prefixed [agent] so it is greppable and removable, and so
 *     a human's own Comments are never silently clobbered.
 *   - preserveExisting defaults to TRUE: a clip that already has a non-agent
 *     comment is SKIPPED, not overwritten. (Doc 1 §A2.3 — do not destroy the
 *     user's own work without asking.)
 *   - dryRun returns exactly what WOULD be written, changing nothing.
 */

const { call, get } = require('../resolve/calls');
const client = require('../resolve/client');
const vision = require('./vision');

const TAG = '[agent]';

function currentTimeline() {
  const resolve = client.getResolve();
  if (!resolve) return null;
  const pm = get(resolve, 'GetProjectManager', null);
  const proj = pm ? get(pm, 'GetCurrentProject', null) : null;
  return proj ? get(proj, 'GetCurrentTimeline', null) : null;
}

/** Map GetUniqueId -> MediaPoolItem for the current timeline's video clips. */
function mediaPoolItemsById() {
  const tl = currentTimeline();
  const map = new Map();
  if (!tl) return map;
  const n = get(tl, 'GetTrackCount', 0, 'video');
  for (let i = 1; i <= n; i++) {
    const items = get(tl, 'GetItemListInTrack', null, 'video', i);
    if (!items) continue;
    for (const it of items) {
      const id = get(it, 'GetUniqueId', null);
      const mpi = get(it, 'GetMediaPoolItem', null);
      if (id && mpi) map.set(id, mpi);
    }
  }
  return map;
}

/**
 * @param {Array}   labels           from vision.classify()
 * @param {boolean} opts.dryRun      compute the plan, write nothing
 * @param {boolean} opts.writeColor  also set clip colour
 * @param {boolean} opts.preserveExisting  skip clips with a non-agent comment
 */
function apply(labels, { dryRun = true, writeColor = true, preserveExisting = true } = {}) {
  if (!labels || !labels.length) return { ok: false, error: 'no labels to apply' };

  const byId = mediaPoolItemsById();
  const plan = [];
  const skipped = [];
  const failed = [];
  const t0 = Date.now();

  for (const l of labels) {
    const mpi = byId.get(l.id);
    if (!mpi) { skipped.push({ id: l.id, name: l.name, reason: 'clip not on current timeline' }); continue; }

    const existing = get(mpi, 'GetMetadata', '', 'Comments') || '';
    const isOurs = String(existing).startsWith(TAG);

    if (existing && !isOurs && preserveExisting) {
      skipped.push({ id: l.id, name: l.name, reason: 'has its own comment', existing: String(existing).slice(0, 60) });
      continue;
    }

    plan.push({
      id: l.id,
      name: l.name,
      startTC: l.startTC,
      comment: vision.toComment(l),
      color: writeColor ? vision.toClipColor(l) : null,
      previous: String(existing).slice(0, 60),
      overwritingOwn: isOurs,
      conf: l.conf,
    });
  }

  if (dryRun) {
    return { ok: true, dryRun: true, plan, skipped, failed, wouldWrite: plan.length, ms: Date.now() - t0 };
  }

  let written = 0;
  for (const p of plan) {
    const mpi = byId.get(p.id);
    const c = call(mpi, 'SetMetadata', 'Comments', p.comment);
    if (!c.ok) { failed.push({ id: p.id, name: p.name, step: 'SetMetadata', error: c.error }); continue; }
    if (p.color) {
      const col = call(mpi, 'SetClipColor', p.color);
      if (!col.ok) failed.push({ id: p.id, name: p.name, step: 'SetClipColor', error: col.error });
    }
    written++;
  }

  return { ok: true, dryRun: false, written, plan, skipped, failed, ms: Date.now() - t0 };
}

/**
 * Remove everything we wrote. Only clears comments that start with our tag —
 * a human's own comments are never touched.
 */
function revert({ clearColor = true } = {}) {
  const byId = mediaPoolItemsById();
  let cleared = 0, colours = 0;
  const failed = [];

  for (const [id, mpi] of byId) {
    const existing = String(get(mpi, 'GetMetadata', '', 'Comments') || '');
    if (!existing.startsWith(TAG)) continue;
    const c = call(mpi, 'SetMetadata', 'Comments', '');
    if (c.ok) cleared++; else failed.push({ id, step: 'SetMetadata', error: c.error });
    if (clearColor) {
      const col = call(mpi, 'ClearClipColor');
      if (col.ok) colours++;
    }
  }
  return { ok: true, cleared, colours, failed };
}

/** Read agent labels back off the current timeline, for the snapshot. */
function read() {
  const byId = mediaPoolItemsById();
  const out = {};
  for (const [id, mpi] of byId) {
    const c = String(get(mpi, 'GetMetadata', '', 'Comments') || '');
    if (c.startsWith(TAG)) out[id] = c.slice(TAG.length).trim();
  }
  return out;
}

module.exports = { apply, revert, read, TAG };
