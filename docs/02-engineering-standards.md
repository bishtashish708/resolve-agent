# Engineering Standards

**Document 2 of 2** · Conventions any agent or human writing code on this project follows.
Companion: `01-agent-operating-standards.md` (how the product's assistant behaves).

**Status:** v1.1 draft, 31 Aug 2026
**Target platform:** DaVinci Resolve **Studio** 21.0.4 · Electron 36.3.2 / Node 22.15.1 / Chromium 136 / **ABI 135** `[COMM]`
**Platforms:** macOS + Windows. **Linux is not supported** `[DOC]` — Resolve does not load Workflow Integration Plugins on Linux.

**Confidence tags:** `[DOC]` in Blackmagic's shipped README · `[COMM]` community reverse-engineering, unverified by us · `[OURS]` our own tested finding · `[OPEN]` unverified, see Appendix

---

## E0. Non-negotiables

Violating any of these breaks the product outright. Listed first because they are the ones most
easily lost in a refactor.

1. **`WorkflowIntegration.node` loads in the main process only.** `[DOC]` Never in the renderer, never in preload.
2. **Do not call `WorkflowIntegration.CleanUp()`; exit the process directly.** `[COMM]` BMD's README says to call it on quit, but one project reports it blocks the main thread indefinitely on Resolve 21 and leaks the process holding a file lock on the native module. **This overrides vendor documentation on a single community report, so it is provisional** — verify on 21.0.4 (Appendix #2) and amend if wrong.
3. **Call `SetAPITimeout(n)` during init.** `[DOC]` BMD: *"By default, apis dont timeout."* A hung call never returns. **Q3 answered 31 Aug 2026** from BMD's own `CHANGELOG.txt`: the modal-dialog hang was real — the community inference was correct — and **20.1 "Addressed unresponsive queries when a DaVinci Resolve modal dialog is active."** We target 21.0.3.7, so the fix is present. Keep the timeout anyway as cheap insurance against other blocking cases, but the modal-dialog failure mode is no longer expected.
4. **Never set `nodeIntegration`, `contextIsolation` or `sandbox`.** Take Electron 36 defaults.
5. **No feature code touches the Resolve object graph.** Everything goes through the access layer (§E3).
6. **No mutation without a readable plan and a fresh snapshot.** A confirmation *click* is additionally required for the destructive set in Doc 1 §A2.3 — but not for every mutation, which would delete the DO branch of Doc 1's four-mode decision tree.
7. **`GetUniqueId` is clip identity.** Never key on name or index.
8. **Do not `Object.keys()` a native Resolve object.** `[COMM]` Use `Object.getOwnPropertyNames(Object.getPrototypeOf(obj))`. Verify once and record.

---

## E1. Repository structure

```
/
├─ plugin/                    # everything Resolve loads
│  ├─ manifest.xml            # [COMM] Id, Name, Version, Description, FilePath — full
│  │                          #   schema is not in any public BMD doc; confirm against
│  │                          #   Examples/SamplePlugin on disk before relying on it
│  ├─ package.json            # BMD's own listing shows "package.js" — likely a doc typo;
│  │                          #   every real plugin uses package.json
│  ├─ index.html              # renderer entry; what FilePath's main.js loads
│  ├─ main.js                 # Electron main — wiring only, no logic
│  ├─ preload.js              # contextBridge surface — explicit allowlist, no passthrough
│  ├─ WorkflowIntegration.node          # win32 binary, vendored
│  ├─ WorkflowIntegration.darwin.node   # darwin binary, vendored
│  ├─ resolve/                # THE ACCESS LAYER — only place that touches the API
│  │  ├─ client.js            # init, GetResolve, capability probe, SetAPITimeout
│  │  ├─ calls.js             # every wrapped call: logged, timed, falsy-checked
│  │  ├─ snapshot.js          # the snapshot contract (Doc 1 §B1)
│  │  ├─ diff.js              # structural diff between snapshots
│  │  └─ mutations.js         # every write, each with a plan + reversal note
│  ├─ agent/                  # model orchestration
│  │  ├─ backend.js           # LLM transport (subprocess or API)
│  │  ├─ tools.js             # compound tool definitions
│  │  ├─ prompt/              # system prompt, versioned, one file per section
│  │  └─ modes.js             # act / ask / offer / instruct decision
│  ├─ ipc/                    # one module per domain; thin, no business logic
│  └─ ui/                     # renderer — React, no Node, no Resolve
├─ test/
│  ├─ unit/                   # pure logic, no Resolve
│  ├─ fixtures/               # captured real snapshots as JSON
│  └─ live/                   # requires a running Resolve Studio; never in CI
├─ docs/
│  ├─ 01-agent-operating-standards.md
│  ├─ 02-engineering-standards.md
│  └─ findings/               # dated empirical findings (§E9)
└─ scripts/                   # install, dev-link, capability probe
```

**Rule E1.1 — `main.js` is wiring only.** Window creation, IPC registration, lifecycle. If it
contains a Resolve call or a business rule, that's a defect.

**Rule E1.2 — The access layer is the only module that imports the native binary.** Enforced by
lint rule, not convention.

**Rule E1.3 — Both native binaries are vendored and committed.** They are BMD-supplied and
platform-specific. Record the Resolve version they were taken from in `docs/findings/`.

---

## E2. IPC and process boundaries

```
renderer (ui/)          React. No Node. No fs. No Resolve. No network.
    │  window.<api>.<method>()  — explicit allowlist only
    ▼
preload.js              contextBridge.exposeInMainWorld. Names methods one by one.
    │  ipcRenderer.invoke(channel, payload)
    ▼
main (ipc/ → resolve/)  Full Node. Native module. Network. Subprocesses. Filesystem.
```

**Rule E2.1 — `preload.js` exposes a named allowlist, never a generic bridge.** No
`invoke(channel, ...args)` passthrough — that reintroduces everything context isolation prevents.

**Rule E2.2 — Every IPC handler is async, typed at the boundary, and has a timeout.** A hung
Resolve call must surface as a timeout in the UI, not a frozen panel.

**Rule E2.3 — IPC payloads are plain serialisable data.** Native Resolve objects never cross the
boundary. The snapshot is JSON.

**Rule E2.4 — IPC modules contain no business logic.** They validate, delegate to `resolve/` or
`agent/`, and shape the response.

**Rule E2.5 — All network and LLM traffic is in main.** Also sidesteps the unresolved question of
whether cross-origin `fetch` works from the renderer.

**Rule E2.6 — The renderer never assumes success.** Every call can return unavailable, refused or
timed out, and the UI has a state for each.

---

## E3. The Resolve access layer

**Rule E3.1 — Every call is wrapped.** No exceptions, including one-liners. The wrapper logs the
method, arguments, return value and duration (Doc 1 §B6.2).

**Rule E3.2 — Falsy returns are handled outcomes, not exceptions.** `[COMM]` Studio-gating,
Extras-gating, unmet system requirements, locked tracks and invalid arguments are reported to
surface as a falsy return rather than a throw; BMD documents no taxonomy. **This is a JavaScript
codebase — the bridge may return `false`, `null` or `undefined`.** Define one falsy check in the
layer and use it at every call site. Do not write Python-style `=== false` comparisons.

**Rule E3.3 — Deprecated methods are banned at the lint level.** The replacement table lives in
Doc 1 §B3.3. Adding a deprecated call should fail the build.

**Rule E3.4 — Node index handling is uniform at the layer, but there is no base conversion.**
`[DOC]` Node indices are 1-based (since 16.2.0) and the API simply *is* 1-based on a 21.0 target —
nothing to shift. What the layer normalises is the two different call shapes:
`Graph.SetLUT(nodeIndex, lutPath)` takes a positional int, while `TimelineItem.SetCDL({...})`
takes `"NodeIndex"` as a string key inside a map. Note `SetCDL` is **not** deprecated even though
`TimelineItem.SetLUT` is.

**Rule E3.4b — Mutations target the CURRENT timeline. Set it explicitly, every time.** `[OURS]`
Verified 31 Aug 2026: `MediaPool:AppendToTimeline()` appends to whatever `GetCurrentTimeline()`
returns *at call time*, **not** to any Timeline object you are holding. Worse, `DuplicateTimeline`
silently changes the current timeline as a side effect — which in testing caused an append to land
on the wrong timeline while counts were read from the right one, producing a convincing false
"append failed" reading.

The access layer must, for every mutation: `SetCurrentTimeline(target)` → verify
`GetCurrentTimeline():GetUniqueId()` matches → mutate → **re-fetch** the timeline before reading
results. Never trust a held Timeline reference across a mutation.

Related: `DuplicateTimeline` is on **`Timeline`**, not `MediaPool` (`mp:DuplicateTimeline` is nil).
Method locations in community documentation are unreliable — probe, don't assume (E3.5).

**Rule E3.4c — Success is not `true`.** `[OURS]` `AppendToTimeline` returns a **table** of created
TimelineItems on success. A `=== true` check reports success as failure. The falsy check in E3.2
must treat any non-falsy return — table, object, string, number — as success, and inspect the
shape only where the return value is needed.

**Rule E3.5 — Capability probe at startup.** Detect the Resolve version and the presence of
version-gated methods. Cache it. Features check the capability map — never a version-number
comparison, and never a bare `try`.

**Rule E3.6 — Reads may retry with backoff. Mutations never retry.** A silent retry after a
partial success is the worst failure this product can have.

**Rule E3.7 — Every mutation writes its reversal note before executing** (Doc 1 §B4.3). Same
transaction as the call, not reconstructed afterwards.

**Rule E3.8 — The snapshot is built by one function with one shape.** Not assembled ad hoc per
feature. Fields are added to the contract, not fetched opportunistically.

**Rule E3.9 — Frames are the unit.** Timecode conversion happens at the display boundary only.
One conversion function, tested against drop-frame and non-drop-frame rates.

---

## E4. Agent and prompt layer

**Rule E4.1 — Compound tools, not one-per-API-method.** In the Aug 2026 survey of open-source
Resolve MCP servers, the common failure mode was a tool surface enumerated 1:1 from the API — the
largest claimed 440 tools, several others 200+ — which no model uses well. The one actively
maintained project had independently compressed 353 granular tools into 35 compound ones with an
action parameter, explicitly to control context cost. Group by user intent. Target a low
double-digit tool count.

**Rule E4.2 — The model receives the snapshot, not getters.** It reasons over a structured
document. It does not walk the object graph one call at a time.

**Rule E4.3 — Frame arithmetic is code, never inference.** Gaps, adjacency, overlaps, durations,
"is there room on V2 at frame N" — all computed in `snapshot.js` and handed to the model as
facts (Doc 1 §B1.4).

**Rule E4.4 — The system prompt is versioned, sectioned, and diffable.** One file per section
under `agent/prompt/`. Prompt changes are reviewed like code and referenced by version in bug
reports.

**Rule E4.5 — The prohibitions in Doc 1 §A1 are enforced in code where possible, not only in the
prompt.** If no transition tool exists, the model cannot claim to have added one. Prefer removing
the capability to instructing against it.

**Rule E4.6 — Mode is a structured output, not a tone.** `act` / `ask` / `offer` / `instruct` is a
field the UI reads (Doc 1 §A6.5), not something inferred from phrasing.

**Rule E4.7 — Instructions are structured data rendered by the UI.** Target address, steps and
confirmation signal are fields — not free prose the model formats differently each time. This is
what makes Doc 1 §A3 enforceable.

**Rule E4.8 — Never send more snapshot than needed.** Scope to the relevant region and tell the
user it was scoped (Doc 1 §B1.8).

### E4.9 — The model's OWN tools are part of the trust boundary `[OURS]`

**Learned the hard way, 1 Sep 2026.** The Q&A session was spawned via the Claude Code CLI without
restricting tools, so it inherited the CLI's **full default toolset** — Bash, Read, Write, WebFetch.
The panel was described to the user as "read-only, nothing here can modify your project" while the
model had a working shell the whole time. It used it: `{"command":"echo \"scanning\""}`. Harmless in
itself, but nothing prevented worse, and it was invisible until a tool-call fragment leaked into
rendered text.

**Rule E4.9.1 — Every model invocation declares its tools explicitly. No invocation inherits
defaults.** For the Q&A session that means an empty allowlist *and* an explicit denylist:

```
--allowedTools ''
--disallowedTools 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit'
```

The vision classifier is the one exception and gets `Read,Glob` scoped to a single `--add-dir`.

**Rule E4.9.2 — "Read-only" must describe the whole system, not just our code.** A claim about what
the plugin can do is false if the model reachable from it can do more. Audit the capability surface,
not the call sites.

**Rule E4.9.3 — Never render non-text deltas.** `partial_json` on a `content_block_delta` is
tool-call *arguments*. Filter on `delta.type === 'text_delta'` and drop everything else, regardless
of whether tools are supposed to be disabled — this is what surfaced the problem, and a renderer
that shows only text cannot be tricked into displaying a tool call as prose.

---

## E5. Testing

Testing against a live NLE is awkward; the answer is a hard split.

**Rule E5.1 — Three tiers, and CI runs only the first two.**

| Tier | Needs Resolve | Runs in CI | Covers |
|---|---|---|---|
| `unit/` | no | yes | timecode math, diffing, derived facts, instruction formatting, mode selection |
| `fixtures/` | no | yes | snapshot parsing and reasoning against captured real timelines |
| `live/` | yes | **no** | access layer, mutations, capability probe, plugin lifecycle |

**Rule E5.2 — Every real timeline encountered becomes a fixture.** Capture the snapshot JSON and
commit it. Multi-cam, nested timelines, duplicate clip names, subtitle tracks, locked tracks,
mixed frame rates, 200+ clips. This corpus is the most valuable asset in the repo.

**Rule E5.3 — Every bug gets a fixture before it gets a fix.**

**Rule E5.4 — Live tests run against a dedicated throwaway project, never a real one.** They
mutate, and there is no undo.

**Rule E5.5 — Snapshot correctness is verified by hand at least once per fixture.** Someone opens
the timeline in Resolve and confirms the clip list, timecodes and track layout match. Automated
self-consistency is not sufficient — the whole product rests on this being right.

**Rule E5.6 — Test the refusal paths explicitly.** Locked track, disabled track, no project, no
timeline, render in progress, Resolve quit mid-call, timeline switched mid-operation. These are
the common paths in real use, not edge cases.

**Rule E5.7 — Performance budget is a test.** Full structural snapshot on the largest fixture,
measured and asserted against the freshness budget (Doc 1 §B2.3).

---

## E6. Dependencies

**Rule E6.1 — Prefer zero native modules.** Anything with a classic native binding must be
rebuilt for **ABI 135**, and a Resolve auto-update can silently break it. N-API modules are safe.
`[OPEN]` `node:sqlite` exists in Node 22 but landed in 22.5.0 as **experimental**, and on the Node 22
line may require `--experimental-sqlite` — a flag we do not control, because Resolve launches the
runtime. Do not assume it is available; test inside a hosted plugin before designing around it.

**Rule E6.2 — Renderer dependencies must be pure browser code.**

**Rule E6.3 — Every dependency is justified in the PR that adds it.** This ships inside someone's
NLE; the dependency tree is a liability.

**Rule E6.4 — Pin exact versions.** Commit the lockfile. Reproducibility matters more than
freshness for a plugin users install manually.

**Rule E6.5 — Never bundle Electron.** Resolve supplies the runtime.

---

## E7. Install, packaging and the dev loop

**Rule E7.1 — Install to the system-level path, not the user-level one.**

- macOS: `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/`
- Windows: `%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins\`

Resolve does not reliably scan `~/Library/...` — at least one project verified it does not on
Studio 20.3.

**Rule E7.2 — Know the reload rules.** New plugin or changed `manifest.xml` → **full Resolve
restart** `[DOC]`, which follows from the documented startup scan. `[OPEN]` Changed files inside an
already-registered plugin are *reported* to be picked up on the **next launch from the Workspace
menu** — community knowledge, and the entire dev loop rests on it. Verify on day one (Appendix #7);
if it's wrong, every code change costs a Resolve restart and the iteration plan needs rethinking.

**Rule E7.3 — The plugin `Id` is stable forever.** `Initialize(pluginId)` uses it. Changing it
after release orphans installs.

**Rule E7.4 — The installer verifies preconditions and says which one failed.** Studio (not free),
not the Mac App Store build, supported OS, correct path writable. A generic failure here is a
support burden with no diagnostic path.

**Rule E7.5 — macOS installs may need `xattr -cr`.** Gatekeeper quarantines the downloaded native
module. Handle it or document it prominently.

**Rule E7.6 — Never inherit Resolve's environment implicitly.** The plugin receives whatever
`PATH` and env Resolve hands it, which is not the user's shell environment. Maintain an explicit
env object for every subprocess.

---

## E8. Logging, errors and diagnostics

**Rule E8.1 — Every Resolve API call is logged** (method, argument *shape*, return *shape*,
duration) — subject to the redaction policy in E8.7, which takes precedence over this rule.

**Rule E8.2 — Every mutation is logged with its plan, its reversal note and its outcome.** Same
redaction policy applies.

**Rule E8.3 — Errors name their layer** — Resolve / plugin / model. Different remedies (Doc 1 §B6.3).

**Rule E8.4 — Logs are on disk, rotated, and one click to reveal.** Users cannot open DevTools and
should not be asked to.

**Rule E8.5 — Never swallow an error to keep the UI tidy.** Doc 1 §A6.9 requires honest
degradation; that needs the error to reach the surface.

**Rule E8.6 — Log the Resolve version, plugin version, prompt version and capability map at
startup.** Every bug report needs these four.

### E8.7 Redaction policy — resolves the tension between "log everything" and "log nothing sensitive"

Clip names, timecodes and media paths are client-confidential. Logging the return of
`GetItemListInTrack` or the arguments of `AppendToTimeline` *is* logging exactly that. Two log
levels, with different rules:

| | **Diagnostic (default, always on)** | **Verbose (opt-in, off by default)** |
|---|---|---|
| Method name, duration, success/failure | full | full |
| Clip names, timeline names, media paths | **hashed** — stable short hash, so correlation still works | plaintext |
| Timecodes and frame numbers | retained (needed for almost every bug) | retained |
| `GetUniqueId` values | retained — opaque, not client-identifying | retained |
| Retention | rotated, capped | session-scoped, deleted on quit |

**Rule E8.7.1 — Diagnostic level must be sufficient to debug most issues without plaintext names.**
If it isn't, the hash correlation is wrong, not the policy.

**Rule E8.7.2 — Verbose logging requires an explicit, visible, per-session opt-in**, with a clear
statement that project content will be written to disk in plaintext.

**Rule E8.7.3 — No project content leaves the machine except what the active request requires.**
Never transmit media paths. Never send anything to a third party the user did not choose. Logs are
local-only and are never auto-uploaded, at either level.

---

## E9. Findings discipline

This platform is undocumented in places, version-dependent throughout, and community knowledge is
frequently wrong. Treat empirical findings as first-class artifacts.

**Rule E9.1 — Every empirical discovery gets a dated file in `docs/findings/`** with: what was
tested, how, on which Resolve version and OS, the result, and the confidence level.

**Rule E9.2 — Distinguish documented / community-verified / our own finding.** Never let the
second two harden into assumed fact.

**Rule E9.3 — The shipped `README.txt` and `CHANGELOG.txt` beat any release note.** The 19.0.2
sandbox break — the most disruptive change in this SDK's history — appeared in neither the 19 nor
20 nor 21 New Features Guides. Re-read the shipped docs after every Resolve update.

**Rule E9.4 — Re-run the capability probe against every new Resolve release** before claiming
support, and record the result.

**Rule E9.5 — A rule contradicted by a finding gets amended, with the finding linked.** Applies to
both documents (Doc 1 Rule Z).

---

## E10. Definition of done

A change is not done until:

- [ ] No feature code touches the Resolve API outside the access layer
- [ ] Every new API call is wrapped, logged, and handles a falsy return
- [ ] No deprecated methods; the two node-index call shapes normalised in the layer
- [ ] Any mutation has a readable plan, a reversal note, and no retry — plus a confirmation gate if it's in Doc 1 §A2.3
- [ ] A fresh snapshot is re-verified immediately before any mutation
- [ ] Clip identity is `GetUniqueId` throughout; names/timecodes are display-only
- [ ] Unit + fixture tests pass; a new fixture added if a new timeline shape was encountered
- [ ] Refusal paths tested (locked track, no project, render running, timeline switched)
- [ ] Renderer has no Node, no fs, no Resolve, no network
- [ ] Nothing regressed the Electron security defaults
- [ ] Any prohibition in Doc 1 §A1 that could now be violated is blocked in code, not just prompt
- [ ] Instruction output is structured data with address + steps + confirmation signal
- [ ] Any new empirical knowledge written to `docs/findings/`
- [ ] Verified on a live Resolve Studio 21.0.4 on at least one of macOS / Windows

---

## Appendix — Environment facts to verify locally before first commit

These come from community reverse-engineering and public mirrors, not from BMD's own published
docs. Confirm each against the files on your machine, then record in `docs/findings/`.

| # | Verify | Where | Priority |
|---|---|---|---|
| 0 | **Does Resolve's Edit ▸ Undo reverse scripted timeline mutations?** (Doc 1 Q6) | live test on a throwaway project | **Highest** |
| 1 | Exact Electron / Node / Chromium / ABI on your Resolve build | probe from inside a running plugin | High |
| 2 | `CleanUp()` behaviour on your exact 21.0.4 build — E0 #2 overrides vendor docs on one report | `Developer/Workflow Integrations/CHANGELOG.txt` + live test | High |
| 3 | Whether the Promises API is *worth using* — availability is already documented (`InitializePromise`, `GetResolvePromise`, `SamplePromisePlugin`) | shipped `README.txt` (newer than any public mirror) | Medium |
| ~~4~~ | ~~BMD sample plugin source~~ | ✅ **Located 31 Aug.** Four examples on disk: `SamplePlugin` (sandboxed, **recommended**), `SamplePromisePlugin` (sandboxed + promises), `CompatibleSamplePlugin` (legacy non-sandboxed), `ScriptTestPlugin`. Still worth reading `SamplePlugin/main.js` + `preload.js` | Med |
| **4b** | **The four Examples ship FOUR DIFFERENT `WorkflowIntegration.node` binaries** (distinct sha1s — not interchangeable). BMD README line 17: *"The latest version can be found alongside this document, in Examples/SamplePlugin/"*. **Always take SamplePlugin's.** Our first installer used `find \| head -1` and grabbed the legacy CompatibleSamplePlugin binary | ✅ **Fixed in `install.sh`** | — |
| 5 | Confirm your Resolve Studio is the blackmagicdesign.com build, not Mac App Store | Workflow Integrations are reportedly absent from the App Store build | High |
| 6 | The Windows `Developer\` path on your install | inferred from the documented Scripting sibling path | Low |
| 7 | The hot-reload dev loop (E7.2) — does replacing files inside a registered plugin work without a restart? | live test | **High — blocks iteration planning** |
| 8 | Whether `node:sqlite` is usable inside a Resolve-hosted plugin without launch flags (E6.1) | live test | Low |
