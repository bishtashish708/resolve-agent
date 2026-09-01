# Findings — content indexing (E6)

**Date:** 1 Sep 2026
**Environment:** DaVinci Resolve Studio 21.0.3.7, macOS, Electron 36.3.2 / Node 22.15.1
**Confidence:** `[OURS]` — observed in a running Workflow Integration Plugin

Goal: give the agent some idea of what the footage actually *shows*. Camera-original filenames
(`C1163.MP4`) carry no content information, and a film without dialogue has no transcript to fall
back on.

---

## Result: it works

Trial run over 10 clips: **10/10 frames captured, 10/10 labelled.**

Sample output, written to each clip's `Comments` field:

```
C1163.MP4  01:00:00:00  [agent] hikers on forest trail · forest · wide · midday
C1172.MP4  01:00:13:05  [agent] hiker on wildflower trail · trail · medium · midday
                                — burned tree trunks in background
C1174.MP4  01:00:20:05  [agent] backpacker on granite slab · rock · medium · overcast
                                — trekking pole, storm clouds
```

Detail like "burned tree trunks" and "trekking pole" is specific enough to search on.

---

## F8 — Page/seek settling: the API returns before Resolve is ready ⭐

**The single most important finding here.**

`OpenPage()` and `SetCurrentTimecode()` both return immediately, but Resolve needs real wall-clock
time to load the Color page and render the frame. Calling `GetCurrentClipThumbnailImage()` straight
afterwards returns nil.

This was masked during earlier console testing: the Lua version succeeded 10/10 **only because
console round-trip overhead happened to provide the delay**. Ported to a tight JS loop, the same
logic captured **0/10 at 113 ms/clip**.

| Version | ms/clip | Captured |
|---|---|---|
| Tight loop, no waits | 113 | **0/10** |
| `PAGE_SETTLE 1500ms`, `SEEK_SETTLE 120ms`, retry sleep 90ms | 517–677 | **10/10** |

**Lesson:** a Resolve call returning does not mean Resolve has finished. Anything that depends on
rendered UI state needs a deliberate delay, and "it worked in the console" is not evidence that it
works in code.

## F9 — `os.tmpdir()` is not `/tmp` on macOS

It returns a per-user private path under `<tmpdir><...>/T/`. Files were being written
correctly the whole time; a debugging session was lost looking in `/tmp`. **Surface the actual
output directory in the UI rather than assuming it.**

## F10 — Claude CLI needs the directory granted, not just the tool allowed

Reading image files from a subprocess required **both**:

```
--allowedTools "Read,Glob"
--add-dir <absolute dir>
--permission-mode bypassPermissions
```

`--permission-mode acceptEdits` was **not** sufficient — it governs writes, not reads of an
untrusted directory. Without `--add-dir` the call succeeded (exit 0, `permission_denials: []`) but
produced zero labels, which is a quiet failure worth knowing about.

Also pass **absolute** paths. The plugin's `cwd` is inside the Resolve app bundle, so relative
paths are meaningless across the spawn boundary.

## F11 — Thumbnails are good enough for real classification

576×324 RGB, encoded to PNG (~400–520 KB each). One unprompted description:

> *"A hiker with a backpack walks along a trail through a burned/charred forest with green grass,
> yellow wildflowers, and granite boulders in the foreground."*

Resolution is not the limiting factor.

## F12 — Metadata write path confirmed at scale

`SetMetadata("Comments", …)` and `SetClipColor()` both work per-clip and persist. Labels are
visible and editable in the Media Pool, survive sessions, and travel with the project — a better
store than an external cache keyed by `GetUniqueId`.

Guards that proved worth having:
- every write prefixed `[agent]`, so a revert can clear ours and never touch the user's own comments
- clips with a pre-existing non-agent comment are **skipped, not overwritten**
- the pass always dry-runs first; writing is a separate explicit action

## F13 — Performance

| Phase | Cost |
|---|---|
| Capture | ~517 ms/clip → **~1.5 min for 181 clips** |
| Labelling | 12 images per CLI call; **~8–15 min for 181 clips** (estimated, not yet measured at full scale) |
| Snapshot with labels | 348 ms / 2009 calls (157-clip timeline) |

Labelling dominates. Capture is cheap.

---

## Calibration: the agent handles label uncertainty correctly

Asked *"which shots show burned forest?"* with only 12 of 157 clips labelled:

> "**At least 1** clip is explicitly **labelled** 'burned forest': C1181.MP4 on V1 starting
> 01:00:58:22… Also worth a look: C1172.MP4 … notes 'burned tree trunks in background' … Only 12 of
> 157 clips have labels at all — the other 145 are unlabelled, **which is not evidence they lack
> burned-forest content**."

Four things right: hedged the count, said *labelled* rather than *is*, surfaced a partial match
from a notes field, and refused to treat absence of a label as absence of content. Labels and
timecodes are being treated as different kinds of fact — which is what keeps the timecodes
trustworthy.

---

## Open

- Full 181-clip pass not yet run; labelling time is an estimate
- Audio classification (E6 path D) not built — every clip has 2ch 48 kHz, and for a film with no
  dialogue the ambience may identify shots better than a single frame
- `Date Created` chronology not yet surfaced to the model
- One clip (`C1163.MP4`, duplicated on the test timeline) failed capture after 8 retries despite
  correct navigation — cause unknown
- Label quality on ambiguous frames (black, motion-blurred, transitional) not systematically checked
