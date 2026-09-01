# What the DaVinci Resolve API can and cannot do

*Background research for building an assistant inside Resolve Studio.*

**Date:** 31 August 2026 · **Target:** Resolve Studio 21.0.4 (21.0 shipped 3 Jun 2026; 21.0.4 on 5 Aug 2026)

**Confidence key:** ✅ read in a primary source · ⚠️ community-verified, not in BMD docs · ❓ inferred or unconfirmed

---

## Headline findings

1. **The architecture you want is confirmed possible and largely unoccupied.** A Workflow Integration Plugin is an Electron app that Resolve Studio hosts, and it can render an arbitrary HTML/JS chat UI *and* call the full Resolve scripting API from JavaScript via a Blackmagic-supplied native module. No Python shell-out required. ✅
2. **The scripting API is strong where you don't need it and absent where you do.** Project, media, render, color and Fusion are well covered. Every Edit-page craft operation you'd actually want to automate — **transitions, trims, moves, retimes, ResolveFX, keyframes** — has no API at all. ✅
3. **So "executes what it can" is a small set.** For most transition/edit requests the agent will be giving instructions, not performing them. Design for that from day one rather than discovering it in week three.
4. **There is no event system and no undo transaction.** ✅ You must poll for state, and you cannot give the user a clean one-step undo of anything the agent does.
5. **The plumbing is proven.** Prior art exists for an Electron Workflow Integration Plugin that renders a custom UI, loads `WorkflowIntegration.node` in the main process, and spawns a CLI subprocess for model access — so none of that path is speculative.

---

## 1. Scripting API surface (Resolve 21.0)

Primary source: the shipping `Developer/Scripting/README.txt`, **"Last Updated: 24 Jul 2026"** — [mirrored gist](https://gist.github.com/X-Raym/2f2bf453fc481b9cca624d7ca0e19de8), read in full (1,155 lines) and diffed against the [v20.0 README](https://gist.github.com/Manouchehri/e32461dccd824167bac8358bb21c8040).

### ✅ What IS scriptable

**Timeline read — good.** `GetTrackCount(trackType)`, `GetItemListInTrack`, `GetTrackName/SubType`, `GetIsTrackEnabled/Locked`, `GetCurrentVideoItem`, `GetMarkers`, `GetMarkInOut`, `GetCurrentTimecode`, `GetSetting`. Per-item: `GetStart/GetEnd/GetDuration/GetLeftOffset/GetRightOffset` (all with optional `subframe_precision`), `GetSourceStartFrame/EndFrame`, `GetTrackTypeAndIndex()`, `GetLinkedItems`, `GetProperty`, `GetClipColor`, `GetFlagList`, `GetUniqueId`, `GetMediaPoolItem`.

**Timeline mutation — narrow.** `MediaPool.AppendToTimeline([{mediaPoolItem, startFrame, endFrame, mediaType, trackIndex, recordFrame}])`. **`recordFrame` is the only frame-accurate placement mechanism in the entire API.** Plus `CreateEmptyTimeline`, `CreateTimelineFromClips`, `ImportTimelineFromFile`, `DeleteClips(items, rippleDelete)`, `AddTrack`/`DeleteTrack`/`SetTrackEnable`/`SetTrackLock`/`SetTrackName`, `CreateCompoundClip`, `CreateFusionClip`, `DetectSceneCuts`.

Playhead inserts (no position argument — always at playhead): `InsertGeneratorIntoTimeline`, `InsertFusionGeneratorIntoTimeline`, `InsertFusionCompositionIntoTimeline`, `InsertOFXGeneratorIntoTimeline`, `InsertTitleIntoTimeline`, `InsertFusionTitleIntoTimeline`.

Clip properties (static values only): `Pan`, `Tilt`, `ZoomX/Y`, `RotationAngle`, `AnchorPointX/Y`, `Crop*`, `Opacity`, `CompositeMode` (33 constants), `Distortion`, `RetimeProcess`, `MotionEstimation`, `Scaling`, `ResizeFilter`.

**Fusion — the real escape hatch.** `AddFusionComp()`, `GetFusionCompByIndex/ByName`, `GetFusionCompNameList`, `ImportFusionComp(path)`, `ExportFusionComp(path, idx)`. The README states outright that the returned `fusion` object "allows access to all existing Fusion scripting functionality" — full node graph read/write, tool creation, keyframe splines, and `comp:StartUndo()`/`EndUndo()`.

**Color — well covered.** New `Graph` class via `Timeline.GetNodeGraph()` / `TimelineItem.GetNodeGraph(layerIdx)` / `ColorGroup.GetPre|PostClipNodeGraph()`: `GetNumNodes`, `SetLUT/GetLUT`, `GetNodeLabel`, `GetToolsInNode`, `SetNodeEnabled`, `ApplyGradeFromDRX`, `ApplyArriCdlLut`, `ResetAllGrades`. Plus color groups, grade versions, `SetCDL`, `CopyGrades`, `ExportLUT`, gallery/stills/PowerGrade albums, `GrabStill`/`GrabAllStills`.

### 🔴 What is NOT exposed — the important part

An exhaustive case-insensitive search of the v21.0 README for `undo|transition|dissolve|speed|retime|fade|OFX|effect|callback|event|listen|notify` returned only `InsertOFXGeneratorIntoTimeline`, the `RetimeProcess`/`MotionEstimation` constants, and `"Speed"` inside the text-to-speech settings dict. Nothing else.

| Capability | Status |
|---|---|
| **Add a transition (cross dissolve etc.)** | ✅ **Not possible.** "transition", "dissolve", "fade" appear **zero times** in the v21, v20 *and* ~v16 READMEs. No `Transition` class, no add/set/delete method. Longstanding absence, not a regression. |
| **Move a clip after placement** | ✅ **Not possible.** `GetStart`/`GetEnd` exist; there is no `SetStart`/`SetPosition`/`Move`. `recordFrame` applies only at append time. |
| **Trim an existing clip** | ✅ **Not possible.** `GetLeftOffset`/`GetRightOffset` are read-only (they report available handle). No setters. |
| **Add/configure ResolveFX on an Edit-page clip** | ✅ **No direct API.** No `AddEffect`/`AddOFX`/`AddResolveFX`. `InsertOFXGeneratorIntoTimeline` inserts a *generator as its own clip* — a different thing. Even `Graph` can read tools and enable/disable nodes but **cannot add a node**. ❓ The Fusion-comp route is the workaround; the Resolve README doesn't document ResolveFX-as-Fusion-tools. |
| **Keyframe arbitrary properties** | ✅ **Not possible.** `SetProperty` writes static values. `SetKeyframeMode` only switches the *UI* editor mode. The only keyframe-shaped getters are three read-only stereo-3D ones. |
| **Speed ramps / retiming** | ✅ **Not possible.** You can pick the retime *algorithm*; you cannot set speed or add retime keyframes. |
| **Text+ / title content** | ✅ **Partial.** You can *insert* a title at the playhead. There is **no API to set its text, font, or style** — that requires driving the Text+ tool through the Fusion API. |
| **Undo** | ✅ **Does not exist** — correcting a common assumption. "Undo" appears nowhere in the Resolve README. `StartUndo`/`EndUndo` are **Fusion Composition methods** and only group changes inside that comp. Timeline and media-pool operations are not wrapped in any scriptable undo transaction. |
| **Events / callbacks** | ✅ **Does not exist.** No event, listener, subscription or notification API. An external process **must poll and diff** (`GetCurrentTimecode`, `GetItemListInTrack`, `GetUniqueId` sets). |
| **Read or set the timeline selection** | ✅ **Neither is possible.** *(Corrected 31 Aug — an earlier draft claimed `Timeline.GetSelectedClips()` exists. It does not.)* `GetSelectedClips`/`SetSelectedClip` are **`MediaPool` methods only**. The closest timeline equivalent is `GetCurrentVideoItem()`. This kills "script prepares a selection, user acts on it." |
| Track reordering; per-clip audio level/pan/automation; ripple-insert primitive | ✅ All absent. Fairlight is limited to `ApplyFairlightPresetToCurrentTimeline`, `GetFairlightPresets`, voice isolation. |

### Escape hatches

- **Round-trip export/import** — the primary workaround for transitions, retimes, exact repositioning, keyframes. `Timeline.Export(...)` supports AAF, DRT, EDL, FCP7 XML, FCPXML 1.8/1.9/1.10, OTIO, ALE, ALE_CDL, CSV/TSV, HDR10, Dolby Vision. `MediaPool.ImportTimelineFromFile` accepts AAF/EDL/XML/FCPXML/DRT/ADL/OTIO. `Timeline.ImportIntoTimeline` merges an AAF into an existing timeline with `insertWithOffset`. **Cost: you get a new timeline, not an in-place edit.**
- **Fusion comp route** — for anything needing keyframes or effects on a specific clip.
- **`Workspace ▸ Console`** — Python 2.7/3.6 and Lua REPL, evaluates immediately. Scripts in `Fusion/Scripts/<subfolder>` auto-appear under `Workspace ▸ Scripts`; the subfolder name (`Utility`/`Comp`/`Edit`/`Color`/`Deliver`) controls which page shows them. **This path works on the free edition**, which is how tools that support non-Studio Resolve get in.
- `-nogui` headless mode keeps all scripting APIs. Remote scripting access can be widened beyond Console in Preferences — the README explicitly warns about the security implications.

### Version notes

New in 21.0 (absent from the 7 May 2025 v20.0 README): `"photo"` page, `GetFairlightPresets`, `ApplyFairlightPresetToCurrentTimeline`, `GenerateSpeech`, `RemoveMotionBlur`, `AnalyzeForIntellisearch`, `AnalyzeForSlate`, `Get/SetVoiceIsolationState`, `ResetAllNodeColors`. 21.0.4 adds get-timeline-clip-selection, get-timeline-from-media-pool-entry, and extra `SetRenderSettings` options. Since 16.2.0, `nodeIndex` in `SetLUT`/`SetCDL` is **1-based** (was 0-based). Deprecated-but-working: `TimelineItem.SetLUT/GetLUT/GetNumNodes` (use `Graph`), `Timeline.GetItemsInTrack` (use `GetItemListInTrack`). Studio-only and Extras-gated calls **return `False`** rather than raising when unavailable.

---

## 2. Workflow Integration Plugins

Primary source: BMD's `Developer/Workflow Integrations/README.txt` ([verbatim mirror](https://raw.githubusercontent.com/thatcherfreeman/resolve-scripts/main/Documentation/workflow_integrations_documentation.txt)). BMD's own words: *"Users can write their own Workflow Integration Plugin (an Electron app) which could be loaded into DaVinci Resolve Studio."* ✅

### Stack

**Electron — but you don't ship it.** Resolve installs and launches its own runtime. ⚠️ Probed from inside a running plugin on Studio 21.0.0: **Electron 36.3.2 / Node 22.15.1 / Chromium 136 / ABI 135**. Corroborated by BMD's 20.1 release note, *"Support for Electron 36.3.2 for Workflow Integrations."* ✅

The bridge is **`WorkflowIntegration.node`**, an N-API native module BMD ships prebuilt (~390 KB Win, ~1.6 MB macOS). Not a `window` global — you `require()` it. API: ✅

```
GetInfo() · Initialize(pluginId) · InitializePromise(pluginId)
GetResolve() · GetResolvePromise() · RegisterCallback(name, fn)
DeregisterCallback(name) · CleanUp() · SetAPITimeout(secs)
```

**Callbacks are `'RenderStart'`, `'RenderStop'`, `'ResolveQuit'` — those three only.** ⚠️ Community probing confirms `TimelineChanged`, `ProjectChanged`, `ProjectOpened`/`Closed` all fail with "Failed to register callback with host." **So: no push notification of user edits, at either layer. Poll.** ⚠️ ~15 ms per API round trip, so polling is cheap.

Files: `manifest.xml` (5 fields, unchanged since 2020 — `Id`, `Name`, `Version`, `Description`, `FilePath`), `main.js`, `index.html`, `package.json`, `node_modules/`. Folder name need not match `<Id>`. ⚠️

### Install & registration

✅ **macOS:** `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/`
✅ **Windows:** `%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins\`
🔴 **Linux: not supported for plugins**, in every version through 21. Scripts still work on Linux.

⚠️ Use the **system-level** path — one repo's README documents `~/Library/...` and another empirically confirmed Resolve does *not* scan it on Studio 20.3. Resolve scans the root **at startup only**, reads `manifest.xml`, and adds an entry under `Workspace ▸ Workflow Integrations`. ⚠️ Dev loop: adding a plugin or editing the manifest needs a full Resolve restart, but replacing files *inside* an already-registered plugin is picked up on the next launch from the menu. ⚠️ The window is an ordinary OS-level Electron window — floats over Resolve, own taskbar entry, **no docking**.

The SDK ships inside the install (`Help ▸ Documentation ▸ Developer`), with `README.txt`, `CHANGELOG.txt` and four sample plugins. ✅ **No developer program, no application, no NDA, no plugin-ID registry, no distribution approval, no code signing.** Resolve isn't even listed on [blackmagicdesign.com/developer](https://www.blackmagicdesign.com/developer). The two real gates: **Studio license required**, and ❓ **the Mac App Store build of Resolve Studio reportedly does not support Workflow Integrations at all** (Apple sandbox) — consistent across independent vendor help centers (Epidemic Sound, Ziflow), not found in a BMD primary doc. Use the blackmagicdesign.com download.

### ✅ Chat UI + scripting API: yes, confirmed

Mandatory architecture since 19.0.2 (Electron sandbox + context isolation on by default):

```
renderer (index.html — your chat UI; Chromium, NO Node)
   ↕ contextBridge.exposeInMainWorld
preload.js (require('electron/renderer') — note the subpath)
   ↕ ipcRenderer.invoke / ipcMain.handle
main.js (full Node: WorkflowIntegration.node, fs, child_process, http)
```

Every modern plugin examined **omits** `sandbox`/`contextIsolation`/`nodeIntegration` and takes Electron 36 defaults. Nobody flips them.

### Sandbox limits

| Concern | Status |
|---|---|
| Node in renderer | ✅ Off by default since 19.0.2. Use preload + IPC. Legacy `nodeIntegration: true` still works via the `CompatibleSamplePlugin` pattern; BMD says "not recommended." |
| `WorkflowIntegration.node` in renderer | ✅ Doesn't work sandboxed. **Main process only.** |
| Network | ⚠️ No documented or observed restriction. One plugin runs an inbound HTTP listener on `127.0.0.1:9087` from inside the plugin. |
| CORS | ❓ **Unknown.** No documented policy and nobody has reported trying cross-origin `fetch` from the renderer. Do network in main and the question doesn't arise. |
| Filesystem | ✅ Unrestricted from main (`fs`, `dialog`, on-disk SQLite all verified in shipping code). None from renderer, by design. |
| Subprocesses | ⚠️ `child_process.spawn` from main is proven in shipping plugins — CLIs, ffmpeg, `osascript`. **Gotcha:** the plugin inherits whatever `PATH`/env Resolve hands it, which is minimal; maintain an explicit env object and resolve binaries by absolute path. |
| npm packages | ⚠️ Pure-JS fine. Classic native modules need `electron-rebuild` for **ABI 135** and a Resolve auto-update can silently break them. N-API modules are safe; `node:sqlite` is built in. |
| DevTools | ✅ `webContents.openDevTools()` works. README caveat: no console-based support for the JavaScript API. |

**⚠️ Two landmines:** `CleanUp()` **blocks the main thread forever on Resolve 21** (module v2.0.0) and leaks the process — plain process exit is safe; one repo reports eight lingering `electron.exe` processes holding a file lock on the binary. And `Object.keys()` returns nothing useful on the native objects — use `Object.getOwnPropertyNames(Object.getPrototypeOf(obj))`. Also set `SetAPITimeout(n)`: **API calls block while Resolve shows a modal dialog, and by default never time out.**

### Version history

19.0.2 was the big break (sandbox + context isolation). 19.x added the Promise API and `ResolveQuit`. **20.0: nothing. 21.0: nothing** — exhaustive grep of both New Features Guides returns zero hits for "Workflow Integration", "Electron", "plugin", "SDK", "MCP", "LLM", "agent". 20.1 is the only confirmed 20/21-era change (Electron 36.3.2 + Promises API). ⚠️ Note: **the 19.0.2 sandboxing break — the most disruptive change in this SDK's history — was never announced in any New Features Guide.** Release notes are not a reliable channel here; the shipped `README.txt` + `CHANGELOG.txt` are.

**Discrepancy:** BMD bills the Promises API as new in 20.1, but the README dated 3 Oct 2024 already documents it. Either it shipped quietly in 19.x, or that mirror is a 20.1+ copy whose header was never bumped.

---

## Implications for your build

**Recommended shape:** a standard sandboxed Electron Workflow Integration Plugin for the shell; a **compound tool surface** grouped by user intent rather than one tool per API method; and a **timeline context snapshot** handed to the model whole, rather than having it walk the object graph one getter at a time. Because there is no event system, freshness comes from re-reading, not from notifications.

**Design around the three hard constraints:**

1. **Instruction-first is not a compromise, it's the correct default.** Transitions, trims, moves, retimes, ResolveFX and keyframes are simply not scriptable. An agent that *reads* the timeline precisely and gives step-by-step instructions grounded in the actual clip names, timecodes and track layout is a real product; one that promises to execute those edits will fail constantly.
2. **No undo means every mutation needs a confirmation gate.** Especially `DeleteClips` + re-append, which is the only way to move or trim — and ❓ almost certainly discards that item's grade, Fusion comps, markers and properties, since a new TimelineItem is created. Verify this empirically before shipping anything that uses it.
3. **A "bulk apply" mode via FCPXML round-trip** is the honest way to deliver transitions and retimes — build the change externally, import as a new timeline, let the user compare. Slower and less magical, but it's the only path that actually works.

**Verify locally before writing code** (these files on your disk are newer than any public mirror):

- `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/CHANGELOG.txt` and `README.txt` — the authoritative per-version record; settles the Promises-API date and current Linux status.
- `Examples/SamplePlugin/main.js` + `preload.js` and `CompatibleSamplePlugin` — **no public mirror of BMD's official samples exists.**
- Confirm your Resolve Studio is the blackmagicdesign.com build, not Mac App Store.

**Open questions worth 30 minutes of testing:** does cross-origin `fetch` work from the renderer? Does `DeleteClips` + re-append preserve grades? What's the real polling cost of a full timeline snapshot on a 200-clip timeline?

---

## Sources

**Primary (Blackmagic):** [Scripting README v21.0, 24 Jul 2026](https://gist.github.com/X-Raym/2f2bf453fc481b9cca624d7ca0e19de8) · [Scripting README v20.0](https://gist.github.com/Manouchehri/e32461dccd824167bac8358bb21c8040) · [Workflow Integrations README](https://raw.githubusercontent.com/thatcherfreeman/resolve-scripts/main/Documentation/workflow_integrations_documentation.txt) · [Resolve 20.1 New Features Guide](https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_20.1_New_Features_Guide.pdf) · [Resolve 21 New Features Guide](https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_21_New_Features_Guide.pdf) · [blackmagicdesign.com/developer](https://www.blackmagicdesign.com/developer)


**Forum threads (not machine-readable — BMD blocks automated fetching; open manually):** [t=215562 Compatibility Mode](https://forum.blackmagicdesign.com/viewtopic.php?f=12&t=215562) · [t=224855 WI Development Questions](https://forum.blackmagicdesign.com/viewtopic.php?f=12&t=224855) · [t=189135 Transitions via Python API](https://forum.blackmagicdesign.com/viewtopic.php?f=21&t=189135)

**Note:** the gist links are community mirrors of the `README.txt` files that ship inside a Resolve
install. If you have Resolve Studio, prefer your own copies at
`Developer/Scripting/README.txt` and `Developer/Workflow Integrations/README.txt` — they are
authoritative, and newer than any mirror.
