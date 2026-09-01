# Findings — read-only spikes on `<project>`

**Date:** 31 Aug 2026
**Method:** Lua, DaVinci Resolve built-in Console (`Workspace ▸ Console`, Lua tab)
**Environment:** DaVinci Resolve Studio **21.0.3.7**, macOS
**Confidence:** `[OURS]` — directly observed unless noted
**Project state:** all test writes reverted; project returned to original state

> Note: Resolve's **Py3** console tab reported "python 3 not found" despite Python being installed.
> Resolve only detects framework builds (python.org installer), not Homebrew/pyenv/conda. **Lua was
> used instead and is the better choice anyway** — it's embedded, always present, zero setup. The
> shipping product uses JavaScript via `WorkflowIntegration.node`, so Python was only ever a
> testing convenience.

---

## The reference timeline (real numbers)

| | |
|---|---|
| Project / timeline | `<project>` / `Timeline 1` |
| Frame rate | **23.976** |
| Range | frames 86400 → 154003 (**67,603 frames ≈ 47 minutes**) |
| Tracks | **4 total** — V1, V2, A1, A2. All enabled, none locked |
| Clips | **362 total = 181 video + 181 audio** (perfectly paired) |
| Media | Uniform **3840×2160**, H.264 4:2:2 10-bit, 23.976. 179× L5.1 + 2× L5.2 |
| Audio | **100% of clips** — 2ch Linear PCM, 48 kHz, 16-bit |
| Markers | **0** |
| Clip colours | none set |
| Names | camera originals (`C1155.MP4`) |
| Media location | `/path/to/media/` |

**Scope correction:** the timeline is 362 clips / 47 minutes, not the ~200 originally estimated.

---

## F1 — Snapshot cost: ~50× cheaper than assumed ⭐

| Pass | Time | Detail |
|---|---|---|
| A — tracks only | **0 s** | 4 tracks, all metadata |
| B — full per-clip read | **1 s** | 362 clips × 10 getters ≈ **3,620 calls** |
| C — markers | **0 s** | |
| **Total snapshot** | **~1 s** | |

**≈ 0.3 ms per API call** (worst case ~0.55 ms allowing for `os.time()`'s 1-second granularity).

**Community's widely-cited ~15 ms figure is wrong by roughly 50×.**

**Consequences:**
- Doc 1 §B2.1 corrected — the 15 ms figure is removed
- Doc 1 §B2.3 freshness budget (≤2 s) is trivially met; could be tightened to sub-second
- **Doc 1 §B2.2 tiered polling is largely unnecessary.** A full structural re-read costs ~1 s. Simplify toward "just re-read it" and keep tiering only if profiling later demands it. This removes real complexity from E3.
- Doc 1 Appendix Q2 → **answered**

---

## F2 — Thumbnails work, but only on the Color page ⭐

`Timeline:GetCurrentClipThumbnailImage()`:

- **Returns nil on the Edit page**, even with a clip under the playhead
- **Works on the Color page**: `{width=576, height=324, format="RGB 8 bit", data=<base64>}`
- `data` length 746,496 = base64 of 576×324×3 raw RGB. Confirms format.
- Tracks the **Color page's** current clip, which is independent of the Edit playhead

**Navigation works.** `SetCurrentTimecode(<clip start + 12>)` landed on the intended clip **5/5** and **10/10**.

**Cold-start race, then reliable.** First run: 3/5 thumbnails. Second run with a retry loop: **10/10, all on the first try, zero retries used.** The initial nils were Color-page warmup, not a persistent race — but keep the retry as insurance.

**Throughput:** 10 clips in 5 s ≈ **500 ms/clip** → **181 clips ≈ 90 s**. Acceptable as a one-time indexing pass.

**Cost:** UI churn — Resolve visibly steps through clips on the Color page while indexing. Must be user-initiated and cancellable, never a background surprise.

Doc 1 Appendix Q4 (E0.4) → **answered. E6 path A is viable.**

---

## F3 — Metadata is partially writable ⭐

| Call | Result |
|---|---|
| `SetClipProperty("Keyword", ...)` | **false** — wrong method; only a small settable subset |
| `SetMetadata("Keyword", ...)` | **false** — reserved, presumably owned by IntelliSearch |
| `SetMetadata("Comments", ...)` | **true**, value persisted and read back |
| `SetClipColor("Orange")` | **true** |
| `ClearClipColor()` | **true** |

**`Comments` is the persistence channel for E6 content labels.** Labels can live inside the project
rather than an external cache: they survive sessions, move with the project, are visible and
correctable in the Media Pool, and are searchable in Resolve itself. `SetClipColor` gives a coarse
visual category the user can see on the timeline.

**Untested:** `Description`, `Scene`, `Shot`, `Take` — likely also writable via `SetMetadata`.

---

## F4 — API quirks for the access layer

**Some calls return *zero values*, not `nil`.** `tostring(tl:GetCurrentTimecode())` raised
`bad argument #1 to 'tostring' (value expected)`. In Lua a no-return breaks naive wrapping.
**Rule: never inline a Resolve call as an argument — assign to a local first.** In JS this surfaces
as `undefined`; the access layer's falsy check must cover it (Doc 2 §E3.2).

**Playhead calls are page-state dependent.** On a non-Edit page, `GetCurrentVideoItem()` and
`GetCurrentTimecode()` both returned nil. The snapshot cannot assume these are present, and any
feature relying on them must assert or set the page first.

**Page switching is scriptable and fast.** `OpenPage("edit"|"color")` and `GetCurrentPage()` both work.

---

## F5 — Content signals available without any vision model

The clip property dump revealed usable metadata beyond filenames:

| Field | Example | Use |
|---|---|---|
| `Date Created` | `Mon Jun 29 2026 12:23:55` | **Shot chronology and time of day** — dawn/midday/golden hour, and true hike order |
| `Start TC` | `05:34:07:16` | Camera TC — free-run vs time-of-day **not yet determined** |
| `File Path` | full path to source | Keeps the ffmpeg route open (E6 path C) |
| `Duration`, `Frames` | `00:00:31:12`, 756 | |
| `Usage` | `2` | How many times the clip appears in the timeline |

Several hundred other metadata fields exist and are **empty** — `Scene`, `Shot`, `Take`,
`Description`, `Keyword`, `Transcription`, `People`, `Location`, `Day / Night`. Greenfield.

**`Date Created` is a free content signal** requiring no analysis at all, and it is genuinely useful
for a hiking film.

---

## F6 — Resolve's Edit ▸ Undo DOES reverse scripted mutations ⭐⭐ (Q6 — ANSWERED)

**The single most consequential finding.** Tested on `<scratch-project>`, on a
duplicated throwaway timeline:

```
timeline: BACKUP_Timeline 1
V1 before: 79
append returned type: table
V1 after:  80
   [user pressed Cmd+Z in the Edit page]
V1 now:    79
```

**`MediaPool:AppendToTimeline()` landed on Resolve's native undo stack and was reversed by a single
Cmd+Z.**

### What this does and does not establish

**Established:** a scripted `AppendToTimeline` is undoable by the user through normal Resolve undo.

**NOT established — do not over-generalise:**
- Only **one operation type** was tested. `DeleteClips`, grade application, `SetMetadata`,
  `SetClipColor`, track add/delete may behave differently. Metadata writes in particular are a
  different subsystem and quite likely are *not* undoable.
- **Undo granularity is unknown.** Does one Cmd+Z reverse one API call, or one batch? A compound
  mutation of 40 clips might need 40 presses, or one — untested.
- **The undo stack is project-wide, not timeline-scoped.** Pressing undo past our changes reaches
  the user's own earlier manual actions.
- Tested on 21.0.3.7 only.

### Consequences for the design

- The agent **still has no undo capability of its own** — Doc 1 §A1 row 8 stands unchanged.
- But the agent may now **truthfully tell the user that Cmd+Z should reverse an append**, which is
  materially more reassuring than the previous hedge. Doc 1 §A1.3 rewritten.
- Confirmation gates for the **destructive set** (§A2.3) stay exactly as written — we have no
  evidence `DeleteClips` is undoable, and that is the operation that matters most.
- Non-destructive mutations (append, track add, grade, colour) can proceed with a plan but no
  confirmation click, with more confidence than before.
- **New open question Q9:** which operations are undoable, and at what granularity? Worth a
  systematic sweep — it is the difference between "confirm everything" and "confirm deletes."

---

## F7 — Two API traps found while running the undo test

**`AppendToTimeline` operates on the CURRENT timeline, not on the Timeline object you hold.**
Holding a `Timeline` reference and calling `mp:AppendToTimeline(...)` appends to whatever
`GetCurrentTimeline()` returns at that moment. The first attempt silently appended to the wrong
timeline and read counts from the right one, producing a false "154 → 154, append failed" reading.
**Always `SetCurrentTimeline()` explicitly before any mutation, and re-fetch the timeline after.**

**`DuplicateTimeline` is on `Timeline`, not `MediaPool`** — `mp:DuplicateTimeline(...)` is nil;
`tl:DuplicateTimeline(name)` works. It also **silently changes the current timeline** to the new
duplicate, which is what caused the trap above.

**`AppendToTimeline` returns a table** (the created TimelineItems), not a boolean. The access
layer's falsy check must treat a table as success — a naive `== true` comparison fails.

---

## Status of E0 spikes

| # | Spike | Status |
|---|---|---|
| 0.4 | Thumbnail access | ✅ **Works** — Color page only, ~500 ms/clip, 90 s for the timeline |
| 0.5 | Snapshot cost | ✅ **~1 s** for 362 clips. 50× cheaper than assumed |
| 0.10 | Audio survey | ✅ **100% coverage**, 2ch 48 kHz. E6 path D fully viable |
| — | Metadata writability | ✅ `Comments` + clip colour writable; `Keyword` reserved |
| 0.1 | Plugin shell loads | ⬜ Needs the shell built |
| 0.2 | Hot-reload dev loop | ⬜ Needs 0.1 |
| 0.3 | **Does Edit ▸ Undo reverse scripted mutations?** | ⬜ **Highest priority.** Needs a throwaway project |
| 0.6 | `DeleteClips` + re-append losses | ⬜ Needs a throwaway project |
| 0.7 | `CleanUp()` behaviour | ⬜ Needs 0.1 |
| 0.8 | BMD sample plugin source | ⬜ Needs folder access |
| 0.9 | IntelliSearch usability | ⬜ Not yet run |

---

## Net effect on the plan

**E3 gets simpler.** Snapshot is ~1 s. Drop most of the tiered-polling complexity.

**E6 gets much better odds.** Three independent content signals now confirmed available:
thumbnails (vision), source audio (100% coverage), and capture timestamps (free). Combined with
`Comments` for persistence, the content-blindness problem looks solvable rather than existential.
E6's risk drops from **High** to **Medium**.

**The E6 design that follows from this:** user-initiated indexing pass → step the Color page,
grab 576×324 thumbnails (~90 s) → classify with a vision model → optionally layer audio
classification → write labels to `Comments` → surface clip colour as a visible category. Re-runnable,
correctable by hand, entirely inside the project.
