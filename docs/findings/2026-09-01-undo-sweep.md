# Findings — what Resolve's undo stack actually covers

**Date:** 1 Sep 2026
**Environment:** DaVinci Resolve Studio 21.0.3.7, macOS
**Method:** scripted mutation → user presses Cmd+Z → scripted verification, on a throwaway project
**Confidence:** `[OURS]`

The single most consequential question for anything that writes to a user's project: **if the tool
does something wrong, can it be taken back?**

---

## Results

| Operation | Undoable via Cmd+Z | Granularity |
|---|---|---|
| `DeleteClips` | **yes** | per call |
| `AppendToTimeline` | **yes** | **per clip** |
| `SetMetadata("Comments")` | **yes** | per call |
| `SetClipColor` | **yes** | per call |
| `AddMarker` | **yes** | per call |
| `AddTrack` | **yes** | per call |
| `SetName` | **yes** | per call |
| `AddFlag` | **yes** | per call |
| `SetCDL` (actual grade values) | **yes** | per call |
| `AddVersion` (grade version) | **no** | — |

## F19 — Almost everything is recoverable ⭐

Including `DeleteClips`, which was the one we most expected to be permanent, and `SetCDL`, which
changes actual grade values (verified visually: the image blew out white, one Cmd+Z restored it).

This overturned a design assumption. The safety standards had been written for a world where
nothing was recoverable, which would have meant a confirmation prompt on every action — a tool
that is exhausting to use for no reason.

## F20 — Batches are per-item, and that is the real constraint ⭐

One `AppendToTimeline` call containing **3** clipInfos produced **3** separate undo entries.
Verified: 79 → 82 clips, one Cmd+Z → 81.

So a 40-clip operation creates ~40 undo steps. Technically reversible; practically not — nobody
presses Cmd+Z forty times, and stopping at thirty-eight leaves the project in a state worse than
either endpoint.

**Bulk operations are therefore effectively irreversible even though every step is reversible.**
The honest thing to tell a user is not "you can undo this" but "this is 40 undo steps."

## F21 — Grade VALUES are undoable; grade STRUCTURE is not

`SetCDL` reverses. `AddVersion` does not — a created grade version survives Cmd+Z entirely.

Do not reason about the colour page as one subsystem. This is the clearest reason to test rather
than extrapolate: timeline structure, clip properties and metadata all behaved identically, which
made it tempting to assume the pattern held.

## F22 — "Not undoable" is not the same as "irreversible"

`AddVersion` cannot be undone by the user, but **can** be reversed through the API:

```lua
it:LoadVersionByName("Version 1", 0)      -- must switch away first
it:DeleteVersionByName("Q10_VERSION", 0)  -- returns FALSE while that version is loaded
```

The initial `false` return made it look permanent. It was not — the version was simply the active
one.

The general lesson: an operation being outside the host's undo stack does not make it
irreversible. It makes reversal *the tool's* responsibility rather than the user's — which is
exactly what a recorded reversal note is for.

---

## What this means for a tool that writes to a project

1. **Single operations can be applied with a plan, not a gate.** They are recoverable.
2. **Bulk operations need a gate that states the undo-step count**, not a generic warning.
3. **Every mutation still records how to reverse it**, because some things the user cannot undo
   themselves.
4. **Never extrapolate across subsystems.** Grades and grade versions live on the same page and
   behave differently.

## Untested

`CopyGrades`, `SetLUT`, LUT application, colour groups, `ResetAllGrades`, Fusion comp creation,
`DeleteTrack`, compound clips. `ResetAllGrades` in particular is the most destructive call in this
API surface and has not been checked.
