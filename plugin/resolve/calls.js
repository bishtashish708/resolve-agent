'use strict';
/**
 * Wrapped Resolve API calls. (Doc 2 E3.1)
 *
 * EVERY Resolve call in this codebase goes through here. Nothing else touches
 * the object graph. This is where logging, timing, and the falsy check live.
 */

// BUG FIX 31 Aug 2026: MAX_LOG was 2000 and a 362-clip snapshot makes ~4000
// calls, so the reported call count silently saturated at exactly 2000 — a
// diagnostic that lies. Counters are now kept separately from the ring buffer,
// so totals are always exact regardless of retention.
const MAX_LOG = 4000;
const log = [];

let totalCalls = 0;
let totalFailures = 0;
let totalMs = 0;
const allFailures = []; // failures are rare and worth keeping in full
const MAX_FAILURES = 500;

/**
 * Doc 2 E3.4c — success is NOT `true`.
 * AppendToTimeline returns a TABLE of TimelineItems on success. GetName returns
 * a string. Many getters return objects. A `=== true` check reports success as
 * failure. Treat anything not explicitly falsy as success.
 *
 * Doc 2 E3.2 — the bridge may return false, null, OR undefined.
 * Verified 31 Aug 2026: Lua-side calls can return *zero values*, which surface
 * here as undefined.
 */
function isOk(v) {
  return !(v === false || v === null || v === undefined);
}

/**
 * Doc 1 §B3.1 / F4 — never inline a Resolve call as an argument to another call.
 * Always capture the result first. This wrapper enforces that by construction.
 *
 * @param {object} obj    the Resolve object (Timeline, Project, MediaPool, ...)
 * @param {string} method method name
 * @param {...any} args
 * @returns {{ok: boolean, value: any, ms: number, error: string|null}}
 */
function call(obj, method, ...args) {
  const t0 = Date.now();

  if (obj === null || obj === undefined) {
    return record(method, Date.now() - t0, false, undefined, 'receiver is null/undefined');
  }
  if (typeof obj[method] !== 'function') {
    // Doc 2 E3.5 — method locations in community docs are unreliable.
    // Verified: mp.DuplicateTimeline does not exist; tl.DuplicateTimeline does.
    return record(method, Date.now() - t0, false, undefined, 'method not present on object');
  }

  let value;
  try {
    value = obj[method](...args);
  } catch (e) {
    return record(method, Date.now() - t0, false, undefined, String(e && e.message ? e.message : e));
  }

  const ms = Date.now() - t0;
  return record(method, ms, isOk(value), value, null);
}

function record(method, ms, ok, value, error) {
  totalCalls++;
  totalMs += ms;
  if (!ok) totalFailures++;

  // Doc 2 E8.7 — diagnostic level logs shape, not content. No clip names,
  // no media paths. Verbose level is opt-in and not implemented in v0.
  const entry = { t: Date.now(), method, ms, ok, error, type: typeofShape(value) };

  if (log.length >= MAX_LOG) log.shift();
  log.push(entry);

  // Keep failures separately — they must never be evicted by a big read.
  if (!ok && allFailures.length < MAX_FAILURES) allFailures.push(entry);

  return { ok, value, ms, error };
}

function typeofShape(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `array[${v.length}]`;
  return typeof v;
}

/** Convenience: call and return the raw value, or `fallback` if the call failed. */
function get(obj, method, fallback, ...args) {
  const r = call(obj, method, ...args);
  return r.ok ? r.value : fallback;
}

/** Exact totals — independent of ring-buffer retention. */
function stats() {
  return {
    count: totalCalls,
    totalMs,
    avgMs: totalCalls ? +(totalMs / totalCalls).toFixed(3) : 0,
    failures: totalFailures,
    retained: log.length,
    truncated: totalCalls > log.length,
  };
}

function recent(n = 50) {
  return log.slice(-n);
}

/** Every failure since the last clear(), never evicted. */
function failures() {
  return allFailures.slice();
}

function clear() {
  log.length = 0;
  allFailures.length = 0;
  totalCalls = 0;
  totalFailures = 0;
  totalMs = 0;
}

module.exports = { call, get, isOk, stats, recent, failures, clear };
