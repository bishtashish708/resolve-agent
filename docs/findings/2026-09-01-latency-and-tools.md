# Findings — CLI latency, session caching, and the model's tool surface

**Date:** 1 Sep 2026
**Environment:** Claude Code CLI 2.1.252, macOS, spawned from an Electron Workflow Integration Plugin
**Confidence:** `[OURS]` — measured directly

---

## F14 — Spawning a CLI per question re-pays the whole context every time ⭐

Controlled test, identical trivial output ("OK") both times:

| Prompt | ttft | wall |
|---|---|---|
| Tiny | **1.6 s** | 2.5 s |
| 23k chars | **6.7 s** | 7.8 s |

The tell is in the usage block: `cache_creation_input_tokens: 26773` with `cache_read` covering
only Claude Code's own system prompt. **Every spawn is a new session, so the timeline context is
written to cache and never read back.** ~5 s of time-to-first-token, plus real cost, on every
question — for a document that usually has not changed.

### An earlier conclusion here was wrong

We first compared a 39k-char context against a 23k one and saw model time go 17.9 s → 20.1 s,
and concluded "latency is generation-bound, context size doesn't matter." That comparison was
**confounded** — two different questions producing different answers of different lengths. The
controlled test above holds output constant and shows the opposite.

Lesson: do not draw performance conclusions from two runs that differ in more than one variable.

## F15 — A long-lived session fixes it, gated on a snapshot fingerprint

One CLI process, kept alive. Full context on the first turn; afterwards, send **only the question**
whenever the timeline is unchanged, so the context becomes a cache *read*.

Measured, same session:

| | first token | total | cache write | cache read |
|---|---|---|---|---|
| Turn 1 (context sent) | 17.9 s | 20.4 s | 15,709 | 23,665 |
| Turn 2 (context reused) | **1.7 s** | **3.6 s** | 2,685 | 39,374 |

Drift detection is a structural fingerprint over clip ids, positions, tracks, markers and label
count. It **deliberately excludes the playhead** — moving the playhead does not change the timeline,
and treating it as drift would defeat the optimisation entirely. It **includes label count**,
because a label written between questions genuinely changes what can be answered.

## F16 — The remaining latency is real reasoning, not overhead

After caching, the same complex question still took 12.8 s to first token (down from 17.9 s).
A simple one — "how many clips on V1" — took 1.7 s in the same warm session.

So the profile is **~3 s for simple questions, ~20 s for complex retrieval**, and the difference is
the model scanning 181 labelled clips. Streaming cannot hide it, because the reasoning happens
before any text exists to stream.

## F17 — The CLI inherits its full toolset unless you stop it ⭐⭐

**The most important finding here.**

The Q&A session was spawned without tool restrictions, so it inherited Claude Code's **full default
toolset** — Bash, Read, Write, WebFetch. The panel was described to the user as *"read-only, nothing
here can modify your project"* while the model had a working shell the entire time.

It used it. This appeared mid-answer:

```
{"command": "echo \"scanning\""}At least 20 clips are labelled with water content…
```

Two separate defects:

1. **Unrestricted tools.** Fixed with an empty allowlist *and* an explicit denylist:
   ```
   --allowedTools ''
   --disallowedTools 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit'
   ```
2. **Tool arguments rendered as prose.** The delta handler took
   `delta.text || delta.partial_json`, but `partial_json` is the streaming argument payload of a
   *tool call*. Filter strictly on `delta.type === 'text_delta'`.

The second defect is what made the first one visible. Without the leak, an agent advertised as
read-only would have kept shell access indefinitely and nobody would have known.

**Generalisable lesson:** when a product claims a capability boundary, that claim has to cover the
*model's* tools, not just the application's code paths. "Read-only" described our call sites while
the reachable model could do considerably more. Declare tools explicitly on every invocation;
never inherit defaults.

## F18 — Prompt corrections have to be balanced

Tightening the address rule ("never compress a list into bare names") made the model stop producing
lists at all — it started replying *"Want the full list with timecodes?"* instead. Adding "GIVE the
list — do not offer it. Only ask before changing the project, never before producing information"
restored the intended behaviour.

A constraint stated without its counterweight gets satisfied the lazy way.

---

## Open

- Cold start is ~15 s; mitigated by priming the session on plugin open, not eliminated
- Sessions recycle after 40 turns or 15 minutes idle — both figures are guesses, not measured
- Whether disabling extended thinking would cut the ~12 s reasoning cost, and at what quality price
