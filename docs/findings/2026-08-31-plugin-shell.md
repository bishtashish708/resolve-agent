# Findings — plugin shell v0.1 running inside Resolve

**Date:** 31 Aug 2026
**Environment:** DaVinci Resolve **Studio 21.0.3.7**, macOS, darwin/arm64
**Confidence:** `[OURS]` — observed directly in a running Workflow Integration Plugin

---

## ✅ Spike 0.1 — the plugin loads and reaches the API

The whole approach is viable. Menu entry appeared, window opened, `Initialize` →
`SetAPITimeout(20)` → `GetResolve` all succeeded.

```
product:     DaVinci Resolve Studio
version:     21.0.3.7
plugin id:   com.resolveagent.plugin
module info: {"version":"2.0.0"}
```

## ✅ Spike 0.2 — hot reload works

Replacing `index.html` and `main.js` inside the **already-registered** plugin folder, then
relaunching from `Workspace ▸ Workflow Integrations`, picked up the change **without restarting
Resolve**. Community claim confirmed. Iteration is cheap; only manifest changes and new plugins
need a restart.

## ✅ Runtime versions confirmed (were `[COMM]`, now `[OURS]`)

| | |
|---|---|
| Electron | **36.3.2** |
| Node | **22.15.1** |
| Chromium | **136.0.7103.115** |
| **ABI (modules)** | **135** |
| Platform | darwin / arm64 |

Exactly matches the community-reported figures. Native npm modules must target ABI 135.

## ⭐ CRITICAL — the plugin's PATH is minimal

```
PATH = /usr/bin:/bin:/usr/sbin:/sbin
execPath = /Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Applications/
           .hidden/Electron.app/Contents/MacOS/Electron
cwd      = (same directory as execPath)
```

**None of the usual CLI install locations are present** — no `/usr/local/bin`, no
`/opt/homebrew/bin`, no `~/.local/bin`, no nvm shims.

**Consequence for E4:** the Claude Code CLI **will not be found by name**. The backend must resolve
an absolute path — configured explicitly, or discovered once and cached — and pass an explicit
`env` to `spawn`. Doc 2 §E7.6 anticipated this in the abstract; it is now concrete and would
otherwise have surfaced as a baffling "command not found" much later.

`cwd` is inside the Resolve app bundle, so relative paths are meaningless. Always absolute.

## ⭐ Performance — even faster than the Lua baseline

Snapshot of a 157-clip timeline (`BACKUP_Timeline 1`):

```
total       283 ms   (285 ms incl. IPC round trip)
API calls   1766  ·  avg 0.157 ms  ·  4 failed
breakdown   tracks 5 ms · clips 267 ms · markers 1 ms
```

**0.157 ms per API call.** Lua measured ~0.3 ms; the community figure of ~15 ms is wrong by
roughly **95×**. Extrapolated to the full 362-clip timeline: **~650 ms**.

**Doc 1 §B2.2 tiered polling is definitively unnecessary.** Re-read the whole snapshot.

Derived facts computed correctly: 155 cut points, 0 gaps, 1 marker, clip length median/min/max
308/49/739 frames, no locked tracks.

## ✅ Introspection works identically in JS

`Object.getOwnPropertyNames(Object.getPrototypeOf(obj))` returns real method lists — confirming the
community workaround and giving us an **authoritative per-build method inventory**, better than any
doc or mirror.

| Object | Methods |
|---|---|
| Resolve | 39 |
| ProjectManager | 30 |
| Project | 52 |
| Timeline | 62 |
| WorkflowIntegration | 9 |

`WorkflowIntegration` exposes exactly the 9 documented methods: `CleanUp`, `DeregisterCallback`,
`GetInfo`, `GetResolve`, `GetResolvePromise`, `Initialize`, `InitializePromise`,
`RegisterCallback`, `SetAPITimeout`.

`DuplicateTimeline` confirmed present on **Timeline** (not MediaPool) — matching what we found by
hitting a nil in Lua. `GetFairlightPresets` present on Resolve, confirming it predates 21.0.

## ⭐ The four Example binaries are NOT interchangeable

```
SamplePlugin            84e70429...  <- sandboxed, CANONICAL. Use this.
CompatibleSamplePlugin  9ed9145a...  <- legacy non-sandboxed (nodeIntegration:true)
SamplePromisePlugin     48da4aa0...
ScriptTestPlugin        d0f69288...
```

Distinct sha1s. Our first installer used `find | head -1` and grabbed the **legacy** binary.
BMD's README line 17 is explicit: *"The latest version can be found alongside this document, in
'Examples/SamplePlugin/'."* `install.sh` now hardcodes that path.

## ✅ Q3 answered from BMD's own CHANGELOG

`Developer/Workflow Integrations/CHANGELOG.txt`, last updated **28 July 2025**:

```
## 20.1
* Update to Electron 36.3.2.
* New promise based Javascript asynchronous APIs.
* Improved handling of large lists and data collections in Javascript based workflows.
* Addressed unresponsive queries when a DaVinci Resolve modal dialog is active.
## 20.0
* General performance improvements.
```

- **The modal-dialog hang was real** — community inference correct — and **fixed in 20.1**. We run
  21.0.3.7, so it is present. Keep `SetAPITimeout` as insurance, but drop it as an expected failure mode.
- Promises API confirmed **new in 20.1**, resolving the date discrepancy flagged earlier.
- **No 21.x entry at all** — nothing plugin-facing changed in 21.

## ⚠️ `CleanUp()` — still unresolved, and now a direct conflict

BMD README line 124: *"CleanUp() → Bool ... **This should be called during plugin app quit.**"*
No mention of hanging. Our Doc 2 E0 #2 overrides this on one community report about Resolve 21,
and the CHANGELOG documents no such change. **Spike 0.7 is the tiebreaker** — check for lingering
`Electron` processes after closing the plugin.

---

## Open

| # | Item | Status |
|---|---|---|
| — | **4 failed API calls per snapshot** — which? | Diagnostic added in build 2, not yet read |
| 0.7 | `CleanUp()` / process leak | Not yet checked |
| 0.6 | `DeleteClips` + re-append losses | Not run |
| 0.9 | IntelliSearch usability | Not run |
| Q9 | Which operations are undoable, at what granularity | Not run — **highest priority** |
| Q7 | Is the window always-on-top? | Deliberately unset; observe |
