# Resolve Agent

A timeline-aware AI assistant that runs **inside DaVinci Resolve Studio** as a Workflow
Integration Plugin. You describe an edit; it reads your timeline with real precision and either
does the thing or tells you exactly where to click.

> **Status: early. Read-only.** Nothing in this build can modify your project.

---

## Why this exists

Resolve's scripting API is strong on project, media, colour and Fusion — and has **no API at all**
for the Edit-page craft operations you'd most want automated. There is no way to add a transition,
move a clip, trim one, retime, add a ResolveFX effect to an existing clip, or keyframe a property.

That constraint is easy to wish away and expensive to discover late, so it's the starting point
here rather than a footnote. The design principle:

> **Know the timeline exactly. Never guess about it. Do what the API genuinely supports, and give
> precise, addressable instructions for everything else.**

An assistant that says *"add a cross dissolve at the cut between `A003_C012` and `A003_C013` on V1
at 00:01:44:16"* is useful. One that claims it added the dissolve is worse than nothing.

## What works today

- Loads inside Resolve Studio and reaches the scripting API from JavaScript
- Reads a full structural snapshot of the current timeline — **~700 ms for 362 clips**
- Answers questions about the timeline from a fresh snapshot every time
- **Content indexing** — steps the Color page through each clip, grabs a frame, labels it with a
  vision model, and writes the label to the clip's `Comments` field so it is visible and
  correctable in the Media Pool. Nothing is written without explicit approval, and it is reversible.
- Refuses correctly: won't claim impossible operations, and treats content labels as approximate
  while keeping timecodes exact
- Diagnostics: per-call timing, failure tracking, API surface introspection

Content labels look like this, written to `Comments`:

```
C1163.MP4  01:00:00:00  [agent] hikers on forest trail · forest · wide · midday
C1174.MP4  01:00:20:05  [agent] backpacker on granite slab · rock · medium · overcast
                                — trekking pole, storm clouds
```

## What doesn't yet

Timeline mutations, audio-based classification, streaming responses, and everything in
[`docs/03-epics.md`](docs/03-epics.md) past E6.

---

## Requirements

- **DaVinci Resolve Studio** — Workflow Integration Plugins are Studio-only, and are reportedly
  absent from the Mac App Store build. Use the blackmagicdesign.com download.
- **macOS.** Resolve does not load Workflow Integration Plugins on Linux at any version. Windows
  is deliberately out of scope for v1, not excluded forever.
- **[Claude Code CLI](https://claude.ai/download)** — `curl -fsSL https://claude.ai/install.sh | bash`.
  Auth is your existing Claude subscription. **No API key is handled, stored or logged anywhere in
  this codebase.**

Developed against Resolve Studio 21.0.3.7 (Electron 36.3.2 / Node 22.15.1 / ABI 135).

## Install

```bash
chmod +x install.sh
./install.sh          # re-runs itself with sudo; the plugin root is under /Library
```

Then **fully quit and reopen Resolve** — the plugin root is scanned at startup only.
Launch from **Workspace ▸ Workflow Integrations ▸ Resolve Agent**.

Forking? Change `<Id>` in `plugin/manifest.xml` and `PLUGIN_ID` in `plugin/resolve/client.js` to
your own reverse-DNS identifier, and the folder name in `install.sh` to match.

## Development

File changes inside an already-registered plugin are picked up on the **next launch from the
Workspace menu** — no Resolve restart. Only new plugins and `manifest.xml` changes need a restart.

```bash
sudo cp -R plugin/. "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/<your.plugin.id>/"
```

---

## Architecture

```
renderer (index.html)      React-free UI. No Node, no fs, no Resolve, no network.
      │  window.agent.*  — named allowlist only
preload.js                 contextBridge. Electron 36 security defaults, untouched.
      │  ipcRenderer.invoke
main.js                    Wiring only.
      ├── resolve/
      │     calls.js       THE only place that invokes Resolve methods
      │     client.js      connect + capability probe
      │     snapshot.js    one structured read; derived facts computed in code
      └── agent/
            context.js     snapshot -> compact text document for the model
            prompt.js      versioned system prompt
            backend.js     Claude Code CLI subprocess
            timecode.js    frames <-> timecode
```

Two rules carry most of the weight:

**All Resolve access goes through `calls.js`.** Wrapped, timed, logged, with one falsy check.
Nothing else touches the object graph.

**Derived facts are computed in code, never inferred by the model.** Gaps, cut points, adjacency,
durations, timecode conversion. The model is never asked to do frame arithmetic it can get wrong.

---

## Documentation

The docs are the substance of this project — the code is young, the research isn't.

| | |
|---|---|
| [`docs/00-research-brief.md`](docs/00-research-brief.md) | A precise map of what the Resolve scripting API can and cannot do, and how Workflow Integration Plugins actually work |
| [`docs/01-agent-operating-standards.md`](docs/01-agent-operating-standards.md) | How the assistant must behave — prohibitions, act-vs-instruct, instruction format, snapshot contract, safety gates |
| [`docs/02-engineering-standards.md`](docs/02-engineering-standards.md) | How the code is built — IPC boundaries, access layer, API traps, testing, logging |
| [`docs/03-epics.md`](docs/03-epics.md) | Prioritised build plan |
| [`docs/findings/`](docs/findings) | **Empirically verified behaviour.** Dated, with method and confidence |

Every technical claim carries a confidence tag: `[DOC]` in Blackmagic's shipped docs, `[COMM]`
community reverse-engineering, `[OURS]` our own tested finding, `[OPEN]` unverified.

## Findings that may save you time

Measured on Resolve Studio 21.0.3.7, macOS. Details in [`docs/findings/`](docs/findings).

- **A Resolve API call takes ~0.16 ms, not the widely-repeated ~15 ms.** A full 362-clip snapshot
  is ~700 ms. Elaborate polling tiers are unnecessary — just re-read.
- **Resolve's Edit ▸ Undo *does* reverse scripted appends.** Verified for `AppendToTimeline` only;
  other operations untested.
- **`AppendToTimeline` targets the CURRENT timeline**, not the Timeline object you hold — and
  `DuplicateTimeline` silently changes which timeline is current. This combination produces
  convincing false "append failed" readings.
- **`DuplicateTimeline` is on `Timeline`, not `MediaPool`.** Community docs get this backwards.
- **`AppendToTimeline` returns a table**, not `true`. A `=== true` check reports success as failure.
- **Some calls return zero values, not `nil`.** Never inline a Resolve call as an argument.
- **Playhead calls return null on the wrong page.** `GetCurrentClipThumbnailImage()` works **only
  on the Color page**, returning 576×324 RGB base64.
- **The four bundled Example plugins ship four *different* `WorkflowIntegration.node` binaries.**
  Use `Examples/SamplePlugin/` — Blackmagic's README says so explicitly.
- **A plugin's `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`.** No `/usr/local/bin`, no Homebrew, no
  `~/.local/bin`. Subprocesses must be resolved by absolute path.
- **`SetMetadata("Comments", …)` works; `Keyword` is reserved and fails.** `SetClipProperty` only
  accepts a small settable subset — it is not the same thing as `SetMetadata`.
- **The modal-dialog API hang was real and was fixed in Resolve 20.1** — per Blackmagic's own
  CHANGELOG, which is more reliable than the release notes for this SDK.
- **API calls return before Resolve has finished.** `OpenPage()` and `SetCurrentTimecode()` return
  immediately, but the Color page needs ~1.5 s to load and a seek needs ~120 ms before a frame is
  renderable. A tight loop captured **0/10** thumbnails; adding deliberate waits made it **10/10**.
  Console testing hides this — round-trip overhead supplies the delay by accident.
- **`os.tmpdir()` is not `/tmp` on macOS** — it is a per-user path under `/var/folders/…/T/`.

## Contributing

If you have verified behaviour that contradicts anything here, that's the most valuable
contribution — open an issue with the Resolve version, OS, and how you tested. This platform is
undocumented in places and version-dependent throughout; confidence should come from testing, not
from this README.

## License

MIT. See [LICENSE](LICENSE).

Not affiliated with or endorsed by Blackmagic Design. DaVinci Resolve is a trademark of Blackmagic
Design Pty Ltd.
