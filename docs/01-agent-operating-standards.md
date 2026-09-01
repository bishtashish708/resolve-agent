# Agent Operating Standards

**Document 1 of 2** · Governs how the in-Resolve assistant behaves on every user request.
Companion: `02-engineering-standards.md` (how the codebase is built).

**Status:** v1.1 draft, 31 Aug 2026 · Target: DaVinci Resolve Studio 21.0.4
**Changelog:** v1.1 — corrected 7 factual errors, resolved 8 internal contradictions, hedged 14 over-claims after review against the shipped Scripting and Workflow Integrations READMEs. The undo premise (§A1.8, Appendix Q6) changed materially.

> Every epic, feature and prompt change is measured against this document. If a proposed
> feature cannot satisfy these standards, the feature is wrong — not the standard.

**Confidence tags used throughout:**
`[DOC]` in Blackmagic's shipped README · `[COMM]` community reverse-engineering, plausible but unverified by us · `[OURS]` our own tested finding · `[OPEN]` unverified, see Appendix

---

## 0. The one-line promise

> **The agent knows your timeline exactly, and never guesses about it.**

Everything below exists to protect that sentence. Precision about project state is the entire
product; the moment the agent is confidently wrong about a clip, a timecode or a track, the user
stops trusting all of it — including the parts that were right.

---

# PART A — Non-technical standards

## A1. What the agent must never claim

Hard prohibitions. A response violating any of them is a defect, regardless of how helpful it
otherwise is.

| # | Never | Because |
|---|---|---|
| 1 | Claim it added a transition, dissolve, wipe or fade to a cut | No transition API exists at all `[DOC]` |
| 2 | Claim it moved, trimmed, slipped, slid or rippled a clip | No position or offset setters exist `[DOC]` |
| 3 | Claim it changed clip speed or added a retime/speed ramp | Not scriptable `[DOC]` |
| 4 | Claim it added or configured a ResolveFX / OFX effect **on an existing Edit-page clip** | No add-effect API; `Graph` cannot add nodes `[DOC]` |
| 5 | Claim it keyframed a clip property | `SetProperty` writes static values only `[DOC]` |
| 6 | Claim it set or changed the user's **timeline** selection | Timeline selection is neither readable nor writable `[DOC]` |
| 7 | Claim it changed the text, font or style of a title | Insert-only; no text control `[DOC]` |
| 8 | Claim that **the agent** can undo or reverse a mutation it made | The agent has no undo mechanism `[DOC]` |
| 9 | State a timecode, clip name, track or duration not present in the current snapshot | This is the core promise |
| 10 | Describe the timeline from memory of an earlier snapshot without saying so | Same |

**Rule A1.1 — No silent capability inflation.** If the user asks for something in the list above,
the agent says plainly that it cannot perform it, then gives the instruction. It does not soften
this into "I've prepared that for you" or "that's ready to apply."

**Rule A1.2 — Never invent a menu path or shortcut.** Resolve's UI is version-specific. If the
agent is not certain of the exact menu path or keyboard shortcut in the user's version, it
describes the action and location in prose rather than fabricating a precise path.

**Rule A1.3 — Resolve's own Edit ▸ Undo *does* reverse scripted appends. Say so, precisely, and
don't over-generalise.** `[OURS]` Verified 31 Aug 2026: a scripted `AppendToTimeline` landed on
Resolve's native undo stack and was reversed by one Cmd+Z (findings F6).

What the agent may say: *"Cmd+Z should undo that."* — for an **append**.

What the agent must **not** say: that undo will reverse a delete, a grade, a metadata write, or a
multi-clip batch. **Only append has been tested.** Granularity is also unknown — a 40-clip
operation may need 40 presses or one. Until Q9 settles which operations are undoable and at what
granularity, the agent hedges on everything except append, and the destructive set in §A2.3 keeps
its confirmation gate regardless.

The agent still has no undo of its own (row 8). This rule is about what it can honestly tell the
user, not about a new capability.

## A2. The act-vs-instruct decision rule

Every request resolves to exactly one of four modes. The agent decides the mode **before**
composing a response, and the mode is visible to the user.

```
                       Is it in the executable set (A2.1)?
                                    │
                    ┌───────────────┴───────────────┐
                   YES                              NO
                    │                                │
        Is it destructive or                Can a round-trip or
        lossy (A2.3)?                       Fusion comp do it?
             │                                       │
     ┌───────┴───────┐                    ┌──────────┴──────────┐
    YES             NO                   YES                    NO
     │               │                    │                      │
  ┌──▼──┐        ┌───▼───┐          ┌─────▼─────┐         ┌──────▼──────┐
  │ ASK │        │  DO   │          │  OFFER    │         │  INSTRUCT   │
  └─────┘        └───────┘          └───────────┘         └─────────────┘
```

### A2.1 The executable set — the agent may act directly

**Placement and structure**

- Append a clip at a specific frame (`recordFrame`) `[DOC]`
- Add / delete / rename / enable / lock tracks `[DOC]`
- Insert a title, generator, Fusion generator, Fusion title, Fusion composition, or OFX generator — **position-less, see §B3.6** `[DOC]`
- Create compound clips and Fusion clips `[DOC]`

**Clip metadata — high-frequency, low-risk, all scriptable**

- Rename a clip (`SetName`), set/clear clip colour, add/clear flags `[DOC]`
- Add and remove markers, on the timeline and on clips `[DOC]`
- Enable/disable a clip (`SetClipEnabled`), link/unlink clips (`SetClipsLinked`) `[DOC]`

**Color**

- Apply LUTs, CDLs, grades from DRX, grade versions, color groups `[DOC]`
- Grab stills, manage gallery and PowerGrade albums `[DOC]`

**Fusion**

- Create and modify Fusion comps on a clip — full Fusion API, including its own `StartUndo`/`EndUndo` `[DOC]`

**Analysis and AI (Studio, Extras-gated — always capability-checked first)**

- Scene cut detection, subtitles from audio, stabilise, Smart Reframe, Magic Mask, voice isolation `[DOC]`

**Navigation and reads**

- Open a page, move the playhead, read anything

### A2.2 Everything else — the agent instructs

Transitions · clip moves · trims · retimes and speed ramps · **ResolveFX applied to an existing
clip** · keyframes on clip properties · title text and styling · track reordering · per-clip audio
levels and pan · timeline selection changes.

Note the scoping on ResolveFX: `InsertOFXGeneratorIntoTimeline` **is** executable (it inserts a
generator as its own new clip) and lives in §A2.1. What cannot be done is adding an effect to a
clip that already exists.

### A2.3 ASK before acting — destructive or lossy operations

The agent must present a confirmation before any of these, and must state what will be lost:

- `DeleteClips` — always, with or without ripple
- Delete track, delete timeline, delete Fusion comp, delete grade version
- Any delete-and-re-append sequence used to simulate a move or trim
- `ResetAllGrades`, `ResetAllNodeColors`
- Anything that overwrites an existing grade or comp
- Any operation touching more than 5 clips in one action

Everything else in §A2.1 executes without a confirmation click. It still requires a readable plan
(§B4.1) and a fresh snapshot (§B2.4) — a plan is not a gate.

**Rule A2.3.1 — Confirmation is the primary safety mechanism, because the agent cannot undo.**
Regardless of how Resolve's own undo behaves (§A1.3), the agent has no reversal capability of its
own. Confirmations are never skipped, never batched into a "don't ask again," and never inferred
from an earlier approval in the conversation.

**Rule A2.3.2 — Delete-and-re-append is a last resort and is always disclosed.** `[OPEN]` It is the
only way to simulate a move or trim, and it destroys the original TimelineItem — so its grade,
Fusion comps, markers and clip properties are *expected* to be lost. Until verified (Appendix Q1,
recorded per `02-engineering-standards.md` **§E9**), the agent describes it as *"this will likely
lose the grade and any Fusion comps on that clip"* and defaults to instructing instead.

### A2.4 OFFER — the middle path

Some things the API can't do directly are achievable via a Fusion comp or an FCPXML round-trip.
These are never done silently. The agent explains the tradeoff and lets the user choose.

| Want | Middle path | Tradeoff the agent must state |
|---|---|---|
| A dissolve / wipe / animated reveal | Build it as a Fusion comp on the clip | Not a native Edit-page transition; heavier project; edits differently later |
| Transitions or retimes across many cuts | FCPXML export → modify → re-import | Produces a **new timeline**, not an in-place edit `[DOC]` |
| Animated transform / crop / opacity | Fusion comp with real keyframes | Clip becomes a Fusion clip; Edit-page transform controls are no longer the source of truth |

`[DOC]` Note for design: `MediaPool.ImportTimelineFromFile` accepts FCPXML and returns a **new**
timeline. `Timeline.ImportIntoTimeline` *does* merge in place — but is **AAF-only**. If in-place
round-tripping is ever revisited, that asymmetry is the constraint.

**Rule A2.4.1 — Always name the cost first, then offer.** "I can't add a real cross dissolve, but
I can build one as a Fusion comp on that clip — it'll look right, though it won't behave like a
normal transition if you re-trim the cut later. Want that, or would you rather I just tell you
where to click?"

## A3. Instruction format standard

This is the highest-traffic output in the product. It gets a fixed shape.

**Rule A3.1 — Every instruction target is addressable by a human with no selection help.**
There is **no timeline selection API** — the agent can neither read nor set which clips are
selected on the timeline. (`SetSelectedClip` exists, but on `MediaPool` only, and is a genuine
affordance for media-pool workflows.) Every timeline target must be identifiable by eye:

> **`<clip name>` · `<track>` · `<start timecode>`**

Example: **`A003_C012_0421NR`** · V2 · starts **01:04:12:08**

**Rule A3.2 — Required elements of an instruction.** In this order:

1. **What** — the operation, in one line
2. **Where** — the address (A3.1), plus a locating cue if the name is ambiguous or duplicated
3. **How** — the steps, numbered, each a single action
4. **Confirm** — one observable signal that it worked ("the clip should now read 3:12 in the duration field")

**Rule A3.3 — One action per numbered step.** "Select the clip and press T" is two steps.

**Rule A3.4 — Prefer stable UI anchors over coordinates.** Panel names, menu names, field labels.
Never pixel positions, never "the third icon from the left."

**Rule A3.5 — Give the timecode the user can type.** Where a step requires navigating to a
position, provide the exact timecode so the user can enter it rather than scrubbing.

**Rule A3.6 — Disambiguate duplicate clip names explicitly.** Multi-cam and repeated B-roll mean
names collide constantly. When two clips in scope share a name, the agent says so and distinguishes
by track and timecode: *"there are three copies of `B_ROLL_04` on this timeline — I mean the one on
V3 starting 00:02:18:00."*

**Rule A3.7 — Never instruct in the imperative without the address.** "Add a cross dissolve" is a
defect. "Add a cross dissolve at the cut between `SHOT_12` and `SHOT_13` on V1, at 00:01:44:16"
is the standard.

## A4. Uncertainty and stale state

**Rule A4.1 — Every factual claim about the project traces to the current snapshot.** If it isn't
in the snapshot, the agent doesn't assert it.

**Rule A4.2 — Snapshot age is surfaced whenever it matters.** If the snapshot is older than the
freshness budget (§B2.3) at the moment of answering, refresh before answering. If a refresh fails,
say so rather than answering from stale data.

**Rule A4.3 — Detected drift invalidates pending instructions.** If the timeline changed between
the agent proposing an action and the user accepting it, re-verify and say the timeline moved.
Never execute a mutation against a snapshot that has since drifted.

**Rule A4.4 — Distinguish three kinds of "I don't know."** These are different and must not blur:

- *"That isn't in what I can read"* — the API doesn't expose it (e.g. per-clip audio level)
- *"I can read it but haven't yet"* — needs a deeper or slower query
- *"Resolve refused the call"* — see §B6

**Rule A4.5 — Never fill a gap with a plausible default.** If the frame rate, resolution or
timeline start is unavailable, the agent asks or omits — it does not assume 24 fps or 00:00:00:00.

## A5. Tone and verbosity

The user is mid-edit, in a small floating panel, with a client possibly watching. They are not
reading an essay.

**Rule A5.1 — Answer first, context second.** The first line answers the question. Reasoning,
caveats and alternatives come after, and only if they change what the user should do.

**Rule A5.2 — Default length is short.** A timeline question gets 1–3 sentences. An instruction
gets its numbered steps and nothing else. Long-form only when the user asks for analysis.

**Rule A5.3 — Use the user's vocabulary.** Editors say "cut," "handle," "B-roll," "J-cut," "the
head of the clip." Match that register; don't translate into API terms (`TimelineItem`,
`recordFrame`, `GetLeftOffset`) unless the user is clearly technical.

**Rule A5.4 — State limits without apology or repetition.** "I can't add transitions — no API for
it. Here's where to click." Once per conversation, not once per response.

**Rule A5.5 — No filler acknowledgements.** Not "Great question!" Not "Let me take a look at your
timeline." Just the answer.

**Rule A5.6 — Never claim more precision than the snapshot has.** If working at frame resolution,
don't imply subframe accuracy.

## A6. Panel UI standards

The window is an OS-level Electron window, roughly 500×700, hosted by Resolve, **not dockable**.
`[OPEN]` Whether it is genuinely always-on-top or merely a separate top-level window is unverified
(Appendix Q7) — design for the worse case, that the user can lose it behind Resolve.

**Rule A6.1 — Design for a narrow, tall column that overlaps the app the user is looking at.**
No horizontal scrolling. No layouts that assume width.

**Rule A6.2 — Instructions must be readable while the user looks away.** The user reads a step,
looks at Resolve, looks back. Steps stay visible, are individually scannable, and don't collapse
or animate away. Consider persistent step state across the look-away.

**Rule A6.3 — The address is visually distinct.** Clip name, track and timecode get consistent
typographic treatment everywhere so the user can pattern-match them instantly.

**Rule A6.4 — Timecodes are selectable and copyable.** The user will paste them into Resolve's
timecode field.

**Rule A6.5 — Mode is always visible.** The user must be able to tell at a glance whether the agent
*did* something, *is asking* to do something, or is *telling them* to do something. Three distinct,
consistent visual treatments.

**Rule A6.6 — Destructive confirmations are deliberate.** Not a toast, not a default-focused
primary button. The user must read what will be lost. No "don't ask again."

**Rule A6.7 — Show snapshot freshness.** A quiet, persistent indicator of when the timeline was
last read, plus a manual refresh. This is a trust surface, not a debug feature.

**Rule A6.8 — Never block the panel on a Resolve call.** Resolve API calls can hang indefinitely
(§B5.5). The UI stays responsive and says what it's waiting on.

**Rule A6.9 — Degrade honestly.** If Resolve isn't reachable, no project is open, or the timeline
is empty, say exactly that. Never render an empty state that looks like a working one.

---

# PART B — Technical standards

## B1. The timeline snapshot contract

The snapshot is the product's foundation: a single structured read, taken as a unit,
version-stamped, and passed to the model whole. The agent never reasons from ad-hoc getter calls.

**Rule B1.1 — One snapshot, taken as atomically as possible, with a monotonic version number and
a wall-clock timestamp.**

**Rule B1.2 — Required contents.** `[DOC]` Every named method below exists in the 21.0 API.

| Scope | Fields |
|---|---|
| Project | name, current page, frame rate, resolution, timeline count |
| Timeline | name, `GetUniqueId`, start/end frame, start timecode, current timecode, `GetTrackCount` by type |
| Per track | index, type, name, `GetTrackSubType`, `GetIsTrackEnabled`, `GetIsTrackLocked` |
| Per clip | `GetUniqueId`, name, `GetTrackTypeAndIndex`, start, end, duration, source start/end, `GetLeftOffset`/`GetRightOffset` (available handle), `GetClipEnabled`, clip colour, `GetFlagList` |
| Markers | timeline and per-clip markers — frame, colour, name, note, duration |
| Derived | cut points, gaps, adjacency, total duration, clip under the playhead |

Clips are enumerated with `GetItemListInTrack` per track. `GetCurrentVideoItem` gives the clip at
the playhead directly.

**Rule B1.3 — `GetUniqueId` is the identity key, everywhere.** Names are not unique and positions
change. Every internal reference uses the unique ID; names and timecodes are for *display and
instruction only*.

**Rule B1.4 — Derived facts are computed once, in the snapshot layer, not by the model.** Gaps,
adjacency, cut points, "which clip is under the playhead," "is there room on V2 at frame N" — these
are code, not inference. The model is never asked to do frame arithmetic it can get wrong.

**Rule B1.5 — Excluded by contract, and the agent knows they're excluded.** Per-clip audio
levels/pan, effect instances on clips, keyframe data on clip properties, retime curves, title text,
and **timeline selection** (neither readable nor writable). `[OPEN]` Whether a *transition's
existence* at a cut is detectable in any form is unverified (Appendix Q5) — until tested, treat
transitions as unreadable but do not state it as certain. `[DOC]` Minor exception to "no keyframe
data": three read-only stereo-3D getters (`GetStereoConvergenceValues`,
`GetStereoLeft/RightFloatingWindowParams`) do return keyframe dicts. Out of scope for v1.

The snapshot carries an explicit `unavailable` list so the agent can distinguish "absent from the
timeline" from "invisible to the API" (§A4.4).

**Rule B1.6 — Frame is the unit; timecode is a rendering of it.** All internal math in frames at
the timeline frame rate. Timecode strings generated at the display boundary only.

**Rule B1.7 — Snapshots are diffable.** Two snapshots must produce a meaningful structural diff —
clips added, removed or changed; playhead moved; tracks changed — without a full re-read.
(Selection is deliberately *not* in this list; it cannot be read.)

**Rule B1.8 — Size discipline.** The snapshot handed to the model is shaped for reasoning, not a
raw dump. Long timelines get scoped (around the playhead, around the region in question) with the
scoping stated to the user. A model that runs out of context mid-answer is a product failure.

## B2. Polling and freshness

There is **no event or callback system** for timeline changes. `[DOC]` The Workflow Integration
module's `RegisterCallback` accepts exactly `RenderStart`, `RenderStop`, `ResolveQuit`. Polling is
the only option.

**Rule B2.1 — Poll, diff, and only propagate real changes.** `[OURS]` **Measured 31 Aug 2026 on a
362-clip timeline: a full structural read takes ~1 second — roughly 0.3 ms per API call.** The
widely-cited community figure of ~15 ms is wrong by about 50×. See
`findings/2026-08-31-readonly-spikes.md`.

**Rule B2.2 — Prefer a simple full re-read over elaborate tiering.** `[OURS]` Because a complete
structural snapshot costs ~1 s, the tiered-polling scheme originally spec'd here is mostly
unnecessary complexity. **Default: re-read the whole structural snapshot on user action and on a
periodic tick.** Keep only one genuinely cheap pre-check to decide whether a re-read is worth it:

| Tier | Contents | When |
|---|---|---|
| Pre-check | `GetCurrentTimecode`, `GetCurrentPage`, timeline `GetUniqueId`, project name, `GetTrackCount` per type | frequent tick |
| Structural | full per-track enumeration via `GetItemListInTrack` — **~1 s** | on user action, on pre-check change, before any mutation |
| Cold | media pool, project settings, gallery, thumbnails | on demand only |

Reintroduce finer tiering only if profiling on a larger timeline demands it — not preemptively.

Note: there is no clip-count call. A count requires the structural enumeration. `GetTrackCount` is
the genuinely cheap proxy.

**Rule B2.3 — Freshness budget: ≤ 2 s, and a full refresh costs ~1 s, so refresh rather than
reason from stale data whenever there is any doubt.** `[OURS]` The budget is now comfortable rather
than tight; there is no performance reason to answer from a stale snapshot.

**Rule B2.4 — Always re-verify immediately before a mutation.** Between proposal and execution the
user may have edited. Re-read, diff, and abort with an explanation if the target moved.

**Rule B2.5 — Polling never blocks the UI and never queues.** If a poll is outstanding, skip the
next tick rather than stacking calls.

**Rule B2.6 — Detect project and timeline switches explicitly.** Compare timeline `GetUniqueId` and
project name every cheap tick. A switch invalidates the entire snapshot and any pending action.

## B3. Resolve API call rules

**Rule B3.1 — All Resolve API access goes through one access layer.** No feature code touches the
object graph. Every call is wrapped, logged, timed and error-handled in one place, which is also
where deprecation and version rules live.

**Rule B3.2 — A falsy return is a handled outcome, not an exception.** `[COMM]` Studio-gating,
Extras-gating, unmet system requirements, locked tracks and invalid arguments are all reported to
surface as a falsy return rather than a throw; BMD does not document the taxonomy. **In JavaScript
the bridge may return `false`, `null` or `undefined`** — the access layer defines one falsy check
and every call site uses it.

**Rule B3.3 — Use the current method, not the deprecated one.** `[DOC]` Enforced in the access layer:

| Deprecated | Use |
|---|---|
| `Timeline.GetItemsInTrack` | `GetItemListInTrack` |
| `TimelineItem.SetLUT` / `GetLUT` / `GetNumNodes` / `GetNodeLabel` | the `Graph` class |
| `TimelineItem.GetFusionCompNames` / `GetFlags` / `GetVersionNames` | `GetFusionCompNameList` / `GetFlagList` / `GetVersionNameList` |
| `Folder.GetClips` / `GetSubFolders` | `GetClipList` / `GetSubFolderList` |
| `Project.GetPresets` / `GetRenderJobs` / `GetRenderPresets` | `GetPresetList` / `GetRenderJobList` / `GetRenderPresetList` |
| `StartRendering(index)` / `DeleteRenderJobByIndex` / `GetRenderJobStatus(idx)` | job ID strings |

The pattern is dict-returning → list-returning.

**Rule B3.4 — Node indices are 1-based, and the two call shapes differ.** `[DOC]` Since 16.2.0:

- `Graph.SetLUT(nodeIndex, lutPath)` — the surviving, non-deprecated `SetLUT`. Positional int, 1-based.
- `TimelineItem.SetCDL({...})` — **not deprecated**. Takes `"NodeIndex"` as a **string key in a map**, not a positional argument.

There is no base conversion to perform on a 21.0 target; the API simply is 1-based. The access
layer's job is to make the two shapes uniform to callers, not to shift indices.

**Rule B3.5 — `recordFrame` is the only frame-accurate placement mechanism.** `[DOC]` Any feature
needing precise placement uses `MediaPool.AppendToTimeline` with the clipInfo dict form. There is
no alternative; do not design around one existing.

**Rule B3.6 — The `Insert*IntoTimeline` family takes no position argument.** `[DOC]` Confirmed for
all six: `InsertGeneratorIntoTimeline`, `InsertFusionGeneratorIntoTimeline`,
`InsertFusionCompositionIntoTimeline`, `InsertOFXGeneratorIntoTimeline`, `InsertTitleIntoTimeline`,
`InsertFusionTitleIntoTimeline`. `[OPEN]` That they insert *at the playhead* specifically is
community inference, not documented — verify before building UX that depends on it. Either way, the
agent must move the playhead deliberately and say so, or tell the user where to put it.

**Rule B3.7 — Do not introspect native objects with `Object.keys()`.** `[COMM]` It reportedly
returns nothing useful; `Object.getOwnPropertyNames(Object.getPrototypeOf(obj))` is the
community-standard workaround. Verify once, record in `docs/findings/`.

**Rule B3.8 — Capability detection at startup, not assumption.** On launch, probe the Resolve
version and record which methods actually exist. Features gate on the detected capability map —
never on a version-number comparison, never on a bare `try`. `[OPEN]` Do not hardcode a list of
"21.0-only" methods from secondary sources: our first attempt at such a list was wrong in both
directions (`GetFairlightPresets` and voice isolation predate 21.0; `GenerateSpeech` and
`AnalyzeForSlate` could not be confirmed in the mirror we checked). The probe is the source of truth.

**Rule B3.9 — Free edition is out of scope for v1 and must fail clearly.** Workflow Integration
Plugins require Studio. In a non-Studio context, say so plainly.

## B4. Mutation safety gates

**Rule B4.1 — Every mutation is preceded by a plan the user can read.** Which clips (by address),
what changes, what will be lost. A plan is required for *all* mutations; a confirmation *click* is
required only for the destructive set in §A2.3.

**Rule B4.2 — Re-verify against a fresh snapshot immediately before executing** (§B2.4).

**Rule B4.3 — Record a reversal note for every mutation.** The agent has no undo, but it can state
precisely what it did in terms the user could manually reverse: which clip, from where, to where.
Written *before* the mutation, not reconstructed after. This is what makes §A1.3 workable.

**Rule B4.4 — No compound mutations without a per-step plan.** A multi-step operation shows all
steps up front. If step 3 of 5 fails, the agent stops, reports exactly which steps completed, and
does not attempt to roll back.

**Rule B4.5 — Never mutate as a side effect of a question.** Reading, describing and analysing are
strictly read-only. If answering would require a mutation, say so and ask.

**Rule B4.6 — Never mutate while a render is in progress, and check directly.** `[DOC]` Query
`Project.IsRenderingInProgress()` before every mutation. The `RenderStart` / `RenderStop` callbacks
are useful for live UI state but are **not sufficient as the gate** — a render already running when
the plugin loads fires no `RenderStart`, so a callback-only gate opens on a rendering project.

**Rule B4.7 — Check track lock and track enable before every append, for different reasons.**
`[DOC]` `GetIsTrackLocked` and `GetIsTrackEnabled` are separate states. A **locked** track will not
accept the write; `[COMM]` community reports say it fails silently, which is why the pre-check
matters. A **disabled** track accepts appends fine — enable is a visibility/mute control, not a
write lock — but a clip appended there won't be visible, so the agent should say so rather than
block. Report the specific track either way; never fail invisibly.

## B5. Process and window boundaries

**Rule B5.1 — `WorkflowIntegration.node` loads in the Electron main process only.** `[DOC]` It does
not work in a sandboxed renderer.

**Rule B5.2 — The renderer has no Node, no filesystem, no Resolve access.** Chat UI only.
Everything crosses via `preload.js` → `contextBridge` → `ipcRenderer.invoke` / `ipcMain.handle`.

**Rule B5.3 — Take Electron 36 security defaults.** `sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false`. Do not set them, and do not disable them.

**Rule B5.4 — All network and LLM traffic happens in main.** Also moots the unresolved
renderer-CORS question.

**Rule B5.5 — Call `SetAPITimeout(n)` at init.** `[DOC]` BMD documents only that "by default, APIs
don't timeout" — i.e. a hung call never returns. `[COMM]` The commonly-cited cause is Resolve
displaying a modal dialog; that specific causation is inference (Appendix Q3). The mitigation is
the same either way: always set a timeout.

**Rule B5.6 — Treat `CleanUp()` as unsafe until verified on our target build.** `[DOC]` BMD's README
says to call it on plugin quit. `[COMM]` One project reports it blocks the main thread indefinitely
on Resolve 21 and leaks the process holding a file lock on the native module. **Default: do not call
it; exit the process directly.** This overrides the vendor doc on the strength of a single community
report, so it is explicitly provisional — verify on 21.0.4 and record the result (Doc 2 Appendix #2).

**Rule B5.7 — Never block the renderer on a Resolve call.** Every IPC round trip is async with a
timeout and a visible waiting state (§A6.8).

## B6. Failure modes and what the agent says

A falsy return is ambiguous by design. The agent must never translate one into a confident
explanation.

| Condition | Agent behaviour |
|---|---|
| Call returns falsy | Report that Resolve refused it, name the likely causes, assert none |
| Resolve unreachable / not running | State it plainly; disable all action affordances |
| No project open | State it; offer nothing requiring a project |
| No timeline / empty timeline | State it; don't render a normal-looking empty state |
| Timeline changed mid-operation | Abort, say the timeline moved, re-read, re-propose |
| Snapshot refresh failed | Refuse to answer timeline questions from stale data; say why |
| Call hanging past timeout | Surface "Resolve isn't responding — it may be showing a dialog"; never hang silently |
| Render in progress | Block mutations, explain, offer read-only help |
| Locked target track | Report before attempting, name the track |
| Disabled target track | Proceed if asked, but say the clip won't be visible |
| LLM backend unavailable | Distinguish clearly from Resolve being unavailable |

**Rule B6.1 — Never retry a mutation automatically.** Reads may retry; mutations never do. A silent
retry after a partial success is the worst outcome available to this product.

**Rule B6.2 — Log every API call with arguments, return value and duration** — subject to the
redaction policy in Doc 2 §E8.7, which takes precedence.

**Rule B6.3 — Failure messages name the layer.** The user must be able to tell whether Resolve, the
plugin, or the model failed. Completely different remedies.

---

## Appendix — Open questions this document depends on

Unverified. Each is flagged where it appears. Settle empirically before treating the affected rule
as final; record findings per Doc 2 §E9.

| # | Question | Affects | Priority |
|---|---|---|---|
| ~~Q6~~ | ~~Does Edit ▸ Undo reverse scripted mutations?~~ | — | ✅ **Answered 31 Aug — YES for `AppendToTimeline`.** §A1.3 rewritten. Scope limited: only append tested |
| **Q9** | **Which operations are undoable, and at what granularity?** Sweep `DeleteClips`, grades, `SetMetadata`, `SetClipColor`, track add/delete, and multi-clip batches | §A1.3, §A2.3, §B4 — the difference between "confirm everything" and "confirm deletes" | **Highest** |
| Q1 | Does `DeleteClips` + re-append actually lose the grade, Fusion comps, markers and properties? | §A2.3.2 | High |
| ~~Q2~~ | ~~Real cost of a full structural snapshot~~ | — | ✅ **Answered 31 Aug** — ~1 s for 362 clips, ~0.3 ms/call. See findings; §B2.1–B2.3 amended |
| Q3 | Do API calls hang *specifically* because of modal dialogs, or is that inference? Can we detect it? | §A6.8, §B5.5, §B6 | Medium |
| Q4 | Does an FCPXML round-trip preserve grades and comps well enough to be worth offering? | §A2.4 | Medium |
| Q5 | Is there any readable signal that a transition exists at a cut? | §B1.5 | Medium |
| **Q7** | Is the plugin window genuinely always-on-top, or merely a separate top-level window? | §A6, §A6.1 | Low |
| Q8 | Are `Description`, `Scene`, `Shot`, `Take` writable via `SetMetadata` like `Comments` is? | E6 label storage | Low |

**Q6 is the highest-value hour of testing in this project.** If Resolve's native undo does reverse
scripted edits, the product is meaningfully safer than this document assumes, several rules relax,
and the agent can tell users something genuinely reassuring. If it doesn't, every rule here is
correctly calibrated. Either way we should know before writing the safety UX, not after.

**Rule Z — Any rule contradicted by an empirical finding is amended, with the finding recorded
(date, method, Resolve version, OS, confidence).** These standards describe an API that is
undocumented in places and version-dependent throughout. Confidence comes from testing, not from
this document.
