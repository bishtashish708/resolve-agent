# Epics — Resolve AI Assistant

**Document 3 of 3** · Prioritized build plan.
Governed by `01-agent-operating-standards.md` and `02-engineering-standards.md`.

**Status:** v1 draft, 31 Aug 2026

---

## The reference project

Everything is scoped against one real timeline, not a hypothetical user:

> **"Silent" hiking film. ~200 clips. Single camera. No compound or nested clips.**
> **Not literally silent — at least some clips carry source audio.**
> Repeated work: **SFX · transitions · music · color · Fusion**

*"Silent" here means no narration or dialogue driving the edit — not an absence of sound. Some
clips have natural/ambient audio. This matters more than it sounds: see E6 path D.*

This timeline **is** the primary test fixture (Doc 2 §E5.2). Every performance budget, snapshot
test and demo runs against it. If it works here, it ships; if it only works on a 20-clip toy, it
doesn't.

### What the project changes about the general analysis

**Good news — four of the five are executable, not instruct-only:**

| Want | Path | Mode |
|---|---|---|
| SFX placement | `AppendToTimeline` with `mediaType: 2`, `recordFrame`, `trackIndex` | **DO** |
| Music placement | Same, plus `InsertAudioToCurrentTrackAtPlayhead` | **DO** |
| Color consistency | LUTs, CDL, `CopyGrades`, color groups, grade versions, PowerGrades | **DO** |
| Fusion work | Full Fusion API on any clip's comp | **DO** |
| Transitions | No API | **INSTRUCT** / OFFER a Fusion comp |

The "mostly instruct-only" framing from the research brief applies to *dialogue-driven Edit-page
craft* — trims, moves, retimes, ripples. This project does little of that. Transitions are the
only real gap.

**Bad news — the silent film breaks the standard approach.** Every AI video tool is built on a
transcript. There is no dialogue here, so that's worthless. And the snapshot spec'd in Doc 1 §B1.2
gives the agent clip **names and timecodes only** — `A003_C012_0421NR` at 00:14:22:08 says nothing
about whether the shot is a ridgeline, a stream, or boots on gravel.

> **The central technical risk of this project is that the agent is blind to content.**
> Color consistency survives that. SFX placement does not.

That single fact drives the entire sequencing below.

---

## Sequencing logic

```
  SPIKES ──► FOUNDATION ──►  COLOR (ships first — no vision needed)
   E0          E1–E5                    │
                                        ▼
                              CONTENT LAYER  ──►  SFX  ──►  MUSIC
                                    E6            E7        E8
                                        │
                                        ▼
                              TRANSITIONS (instruct) ──► FUSION
                                    E9                     E10
```

**Milestone 1 — "It can see my timeline."** E0–E4. Reads the 200-clip timeline correctly, answers
questions, mutates nothing. If the agent can't describe your cut accurately, nothing downstream
matters.

**Milestone 2 — "It fixes my grades."** E5, E11, E12. First real executable value. Proves the
mutation path end to end on the safest possible operations.

**Milestone 3 — "It knows what my shots are."** E6. The risky one. De-risks or kills SFX.

**Milestone 4 — "Describe it and it happens."** E7, E8. The magic.

**Milestone 5 — everything else.** E9, E10, E13.

---

# Epics

Priority: **P0** blocks everything · **P1** v1 · **P2** v1 if cheap · **P3** later
Risk: **H/M/L** — likelihood the epic reveals something that changes the plan

---

## E0 · Verification spikes `P0` · Risk H · ~1–2 days

Nine open questions across both standards docs. Cheap to answer, expensive to guess wrong. **Do
these before writing feature code.** Ordered by how much the answer changes the plan.

| # | Spike | If it fails |
|---|---|---|
| 0.1 | **Does a WIP shell load and reach the Resolve API at all?** Minimal manifest + `main.js` + `GetResolve()` on your 21.0.4 | Whole approach is dead — fall back to the `Workspace ▸ Scripts` + localhost-listener pattern, which also reaches the free edition |
| 0.2 | **Hot-reload dev loop** — does replacing files in a registered plugin work without restarting Resolve? (Doc 2 §E7.2) | Every code change costs a full Resolve restart; iteration plan changes |
| 0.3 | **Does Edit ▸ Undo reverse scripted mutations?** (Doc 1 Q6) | If yes, safety UX relaxes materially and the agent can reassure users |
| 0.4 | **`GetCurrentClipThumbnailImage()` on 200 clips** — format, resolution, wall-clock cost | Kills the cheapest content path; forces E6 down a slower route |
| 0.5 | **Full structural snapshot cost on your 200-clip timeline** (Doc 1 Q2) | Freshness budget (≤2 s) is wrong; polling design changes |
| 0.6 | **`DeleteClips` + re-append — what's actually lost?** (Doc 1 Q1) | Confirms or relaxes the "last resort" rule |
| 0.7 | **`CleanUp()` on 21.0.4** — does it really hang? (Doc 2 E0 #2 overrides vendor docs on one report) | We're following BMD's doc after all |
| 0.8 | **Read BMD's `SamplePlugin` / `CompatibleSamplePlugin` + real `manifest.xml` schema** on disk | No public mirror exists; this is the only source of truth |
| 0.9 | **Is IntelliSearch (`AnalyzeForIntellisearch`) usable on this footage?** | Changes E6 from "build it" to "read it" |
| 0.10 | **How many of the 200 clips carry usable source audio, and how clean is it?** | Decides whether E6 path D is a primary content signal or a footnote |

**Done when:** every answer is written to `docs/findings/` with date, method, Resolve version, OS.
**Note:** 0.1 and 0.2 gate everything. Do them first, in that order, in one sitting.

---

## E1 · Plugin shell `P0` · Risk M · Foundation

The Electron Workflow Integration Plugin that Resolve loads and hosts.

- `manifest.xml`, `main.js` (wiring only), `preload.js` allowlist, `index.html`
- Both `WorkflowIntegration.node` binaries vendored
- `Initialize(pluginId)` → `GetResolve()`, `SetAPITimeout(n)` at init
- Electron 36 security defaults untouched; no `CleanUp()` on quit
- Install script → system-level path; precondition checks (Studio, not App Store, OS, writable)
- Menu entry appears under `Workspace ▸ Workflow Integrations`

**Done when:** the panel opens from the Resolve menu, reports the connected project name, and
survives a project switch and a Resolve quit without leaking a process.

---

## E2 · Resolve access layer `P0` · Risk L · Foundation

The single module that touches the Resolve object graph (Doc 2 §E3).

- Every call wrapped: logged, timed, falsy-checked (`false` / `null` / `undefined`)
- Startup **capability probe** — never version-number comparison, never bare `try`
- Deprecated-method lint ban (Doc 1 §B3.3)
- Node-index call-shape normalisation (`Graph.SetLUT` positional vs `SetCDL` map key)
- Reads retry with backoff; **mutations never retry**
- Diagnostic/verbose logging with the redaction policy (Doc 2 §E8.7)

**Done when:** no feature code can reach Resolve directly, and a falsy return anywhere produces a
handled, logged, explainable outcome.

---

## E3 · Timeline snapshot + diff `P0` · Risk M · **The core asset**

The single most important epic in the project. Everything else reads from this.

- One structured read per Doc 1 §B1.2 — project, timeline, tracks, clips, markers
- **Derived facts computed in code, never inferred by the model**: cut points, gaps, adjacency, clip under playhead, "room on V2 at frame N"
- `GetUniqueId` as identity everywhere; names/timecodes display-only
- Frames as the unit; timecode rendered at the display boundary (drop-frame tested)
- Structural diff between snapshots
- Tiered polling (cheap / structural / cold) with drift and project-switch detection
- Explicit `unavailable` list so the agent can say "the API can't see that"
- Scoping for long timelines, with the scoping stated to the user

**Done when:** the snapshot of your 200-clip hiking timeline is **hand-verified against Resolve**
(Doc 2 §E5.5) — clip list, track layout and timecodes all match — and meets the freshness budget
set by spike 0.5.

---

## E4 · Agent loop + read-only Q&A `P0` · Risk M · **Milestone 1**

The model, wired to the snapshot, answering questions. **Zero mutations.**

- Backend transport (see Open Decisions below)
- **Compound tools, low double-digit count** — not one-per-API-method (Doc 2 §E4.1)
- Model receives the snapshot whole; does not walk the object graph
- `act` / `ask` / `offer` / `instruct` as a **structured output field**, not a tone
- Prohibitions in Doc 1 §A1 enforced in code where possible, not just prompt
- Versioned, sectioned system prompt

**Done when:** you can ask "what's on V3 between 12 and 18 minutes," "where are my longest clips,"
"which clips have no grade" — and it's right every time on the real timeline.

> **This is the honest go/no-go gate.** If the agent can't describe your cut accurately and
> repeatably, stop and fix that before building anything that writes.

---

## E5 · Color consistency `P1` · Risk L · **Milestone 2 — first real value**

Chosen to ship first because it's genuinely useful *and* needs no content understanding. Structural
grade data is enough.

- Read grade state across all 200 clips: which are ungraded, which share a version, group membership
- Surface inconsistency: "these 40 have no grade," "this clip is the only one in the group without the group grade"
- Execute: `CopyGrades` from a reference clip, apply LUT/CDL, assign to color group, apply grade from DRX, create/switch grade versions
- PowerGrade and still album management
- **Every mutation: readable plan, fresh snapshot, reversal note** (Doc 1 §B4)

**Done when:** "make these 40 clips match the grade on the ridgeline shot at 14:22" works, is
correct, and tells you exactly what it did.

---

## E6 · Clip content understanding `P1` · Risk ~~H~~ **M** · **The pivotal epic**

> **Updated 31 Aug 2026 after spike results** (`findings/2026-08-31-readonly-spikes.md`).
> Risk downgraded from High to Medium — three independent content signals are confirmed available,
> and persistence is solved.
>
> **Confirmed design:**
> 1. **Thumbnails** — `GetCurrentClipThumbnailImage()` works, **Color page only**, returns
>    576×324 RGB 8-bit base64. Navigate with `SetCurrentTimecode`; landed correctly 10/10.
>    ~500 ms/clip → **~90 s for all 181 video clips**. Cold-start warmup produces a few nils, so
>    keep a retry. Must be user-initiated and cancellable — Resolve visibly steps through clips.
> 2. **Source audio** — **100% of clips** carry 2ch 48 kHz Linear PCM. Full-coverage second signal.
> 3. **Capture timestamps** — `Date Created` is populated (`Mon Jun 29 2026 12:23:55`). Free
>    chronology and time-of-day, no analysis required. Genuinely useful for a hiking film.
> 4. **Persistence** — `SetMetadata("Comments", ...)` **works**; `Keyword` is reserved and fails.
>    `SetClipColor` works. So labels live **inside the project**: they survive sessions, move with
>    the project, are visible and correctable in the Media Pool, and are searchable in Resolve.
>
> **Pipeline:** user-initiated index → step Color page, grab thumbnails (~90 s) → vision classify
> → layer audio classification → write labels to `Comments` → clip colour as visible category.
> Re-runnable and hand-correctable.

The agent needs to know what each clip *is*. No dialogue means no transcript-based search. Four
candidate paths — spikes 0.4, 0.9 and 0.10 decide which. They are not exclusive; the likely answer
is A or B for visual labels **plus** D for ambience.

| Path | Cost | Unknowns |
|---|---|---|
| **A** `GetCurrentClipThumbnailImage()` + vision model | Low | Format, resolution, cost across 200 clips |
| **B** Resolve 21 `AnalyzeForIntellisearch()` | Lowest if it works | Studio + Extras gated; quality on landscape footage unknown; unclear whether results are readable back via the API |
| **C** External frame extraction (ffmpeg) + vision model | Highest | Slow on 200 clips; needs media paths; full control over labels |
| **D** **Source audio classification** — classify the natural sound on each clip | Low–medium | Depends on how many clips actually carry usable audio, and how clean it is |

### Path D — the one the "not actually silent" correction opens up

Since clips carry natural audio, the **source sound is itself a content signal**, and often a
better one than a single thumbnail frame. Wind, running water, footfall on gravel, birdsong and
rain are highly distinguishable audio classes, and they map directly onto the SFX decisions being
made. A thumbnail tells you a shot *looks* like a stream; the audio tells you it *is* one, and
tells you where in the clip the water starts.

This also changes what SFX work means. If a clip already has usable ambience, the job is often
sweetening or replacing rather than building from nothing — so the agent should know which clips
have usable audio, which are wind-ruined, and which are effectively silent.

Relevant API surface, all `[DOC]`: `TranscribeAudio` and audio classification exist, plus
`GetVoiceIsolationState` / `SetVoiceIsolationState` on both `Timeline` and `TimelineItem`. External
classification on the media files is the fallback and gives full control.

**Add to the snapshot:** per-clip audio presence and character — has audio / usable / wind-damaged
/ silent, plus dominant ambience class.

- Produce a per-clip content label set — terrain, subject, motion, time of day, shot scale
- Cache by `GetUniqueId`; invalidate on media change
- Labels become a snapshot field, marked as *derived and approximate* — the agent must never present a vision guess with the same confidence as a timecode

**Done when:** "which shots are exposed ridgelines" returns the right clips on your timeline,
and the agent flags its own uncertainty when it's guessing.

> **Highest-risk epic in the project.** If all three paths are too slow or too inaccurate, SFX and
> music placement degrade from "describe it and it happens" to "I'll place it, you tell me where."
> Still useful — but a different product. Find out early.

---

## E7 · SFX placement `P1` · Risk M · **Milestone 4 — the magic** · *depends on E6*

- Index an SFX library (local folder) with searchable labels
- Match SFX to content-labelled clips — using **both** visual labels and the E6 path D ambience classification
- **Know what's already there.** Since clips carry source audio, distinguish three cases: clip has good ambience (sweeten, don't replace), clip has wind-ruined or unusable audio (replace), clip is effectively silent (build from nothing)
- Place via `AppendToTimeline` — `mediaType: 2`, explicit `recordFrame` and `trackIndex`
- Auto-select or create an appropriate audio track; **check `GetIsTrackLocked` / `GetIsTrackEnabled` first** (Doc 1 §B4.7)
- Preview the plan before writing: which SFX, which clip, which frame, which track

**Done when:** "put wind under the exposed ridge shots" places correct files at correct frames,
skips the clips that already have usable wind, and shows you the plan before it does.

**Note the hard boundary:** the agent can *place* audio at a frame, but **cannot set clip volume,
pan, or fades** — none of that is scriptable. Level balancing is INSTRUCT, always. Worth designing
the SFX plan output so it doubles as a mix checklist.

---

## E8 · Music placement `P2` · Risk M · *depends on E6*

- Place music beds at frame-accurate positions
- Beat/energy analysis done externally, surfaced as timeline-relative markers
- Suggest cut points that align to musical structure — **instruct**, since moving cuts isn't scriptable
- Add markers at beats (markers *are* scriptable)

---

## E9 · Transitions — instruct + Fusion offer `P2` · Risk L

The one genuine gap. Handled honestly rather than faked.

- **INSTRUCT** path: precise, addressable instructions per Doc 1 §A3 — clip name, track, timecode, numbered steps, confirmation signal
- **OFFER** path: build the effect as a Fusion comp, with the tradeoff stated first (Doc 1 §A2.4.1)
- Never claim a transition was added (Doc 1 §A1.1)
- `[OPEN]` Spike whether an existing transition is *detectable* at all (Doc 1 Q5) — affects whether the agent can even see its own past instructions took effect

---

## E10 · Fusion authoring `P3` · Risk M

Full Fusion API access is already available; this is about making it usable conversationally.

- Read and describe an existing comp
- Build common comps from description — animated masks, reveals, text
- Uses Fusion's own `StartUndo`/`EndUndo`, the **only** real undo transaction available anywhere

---

## E11 · Safety and mutation gates `P0` · Risk L · *cross-cutting, lands with E5*

Not a phase — built into the first mutation and never relaxed.

- Readable plan for every mutation; confirmation click for the destructive set (Doc 1 §A2.3)
- Fresh snapshot re-verified immediately before execution
- Reversal note written **before** the mutation
- `Project.IsRenderingInProgress()` checked directly, not just render callbacks
- No automatic retry on any mutation
- Compound operations report exactly which steps completed on failure

---

## E12 · Install and packaging `P1` · Risk M · *lands with E5*

- Installer with precondition checks that name the specific failure
- macOS `xattr -cr` handling for the quarantined native module
- Explicit subprocess env — never inherit Resolve's `PATH` implicitly
- Version and capability map logged at startup

---

## E13 · Panel UX polish `P2` · Risk L

Doc 1 §A6 in full: persistent instruction steps readable while looking away, copyable timecodes,
distinct mode treatment, snapshot freshness indicator, honest degraded states.

---

# Priority summary

| Epic | Priority | Risk | Blocks |
|---|---|---|---|
| E0 Spikes | **P0** | H | Everything |
| E1 Plugin shell | **P0** | M | Everything |
| E2 Access layer | **P0** | L | E3+ |
| E3 Snapshot + diff | **P0** | M | Everything downstream |
| E4 Agent loop / Q&A | **P0** | M | Go/no-go gate |
| E5 Color consistency | **P1** | L | — |
| E6 Content understanding | **P1** | **H** | E7, E8 |
| E7 SFX placement | **P1** | M | — |
| E11 Safety gates | **P0** | L | any mutation |
| E12 Install | **P1** | M | shipping |
| E8 Music | P2 | M | — |
| E9 Transitions | P2 | L | — |
| E13 UX polish | P2 | L | — |
| E10 Fusion authoring | P3 | M | — |

---

# Explicitly out of scope for v1

- **Free edition support** — WIPs are Studio-only
- **Windows** — decided; macOS only for v1. Keep platform-specific code isolated so it's packaging work later, not a rewrite
- **Linux** — Resolve does not load WIPs on Linux, at any version
- **API-key auth** — decided; Claude Code CLI subprocess only. No key handling anywhere in the codebase
- **Trims, moves, retimes, ripples** — not scriptable; instruct only, and rare in this project anyway
- **Multicam, compound and nested timelines** — absent from the reference project; revisit when a real timeline needs them
- **FCPXML round-trip bulk editing** — real but heavy; only if E9 proves instruct-only isn't enough
- **Multi-user / sharing / cloud anything** — personal-use tool

---

# Decisions

## Settled — 31 Aug 2026

**LLM backend: Claude Code CLI as a long-lived subprocess.** `spawn` from the Electron main
process, JSON over stdin/stdout, auth via the user's existing `claude` login.

*Consequences:* no API key is ever handled, stored or logged, which removes a whole class of
security surface. Requires a Claude Pro or Max subscription. Requires the CLI installed and
authenticated — the installer must detect and guide this (E12). Cost is a flat subscription rather
than per-token. The plugin inherits Resolve's `PATH`, not your shell's, so the CLI path must be
resolved explicitly (Doc 2 §E7.6).

**Platform: macOS only for v1.** Ship `WorkflowIntegration.darwin.node` only. Windows is not
excluded forever — just not carried as scope while the fundamentals are unproven. Keep
platform-specific code isolated so adding Windows later is packaging work, not a rewrite.

*Consequences:* one native binary, one install path, one Gatekeeper/`xattr` story, one test
target. Roughly halves E1 and E12.

## Still open

| Decision | Needed by | Note |
|---|---|---|
| **SFX library** — where it lives, whether it's already tagged, roughly how large | E7 | If it's an untagged folder of thousands of files, indexing it becomes its own epic. If it's a few hundred with decent filenames, it's a spike. |

---

# The one-sentence plan

Prove the shell loads (E0.1), build a snapshot of your hiking timeline that is provably correct
(E3), let the agent answer questions about it until you trust it (E4), then ship color consistency
(E5) while finding out whether the agent can see your footage (E6) — because that answer decides
whether SFX is magic or merely helpful.
