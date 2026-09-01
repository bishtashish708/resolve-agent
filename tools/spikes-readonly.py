# Read-only spikes for <project>
# Paste into DaVinci Resolve: Workspace > Console, Py3 tab.
# NOTHING HERE MUTATES THE PROJECT. No appends, no deletes, no property writes.
# Run each block separately and paste the output back.

# =====================================================================
# SPIKE 1 — snapshot cost (Doc 1 Q2 / epic E0.5)
# Times a full structural read of the timeline.
# Sets the freshness budget in E3. May take 30-60s on 200 clips — that IS the finding.
# =====================================================================

import time

pm = resolve.GetProjectManager()
proj = pm.GetCurrentProject()
tl = proj.GetCurrentTimeline()

print("=== SPIKE 1 ===")
print("resolve:", resolve.GetVersionString())
print("project:", proj.GetName())
print("timeline:", tl.GetName())
print("fps:", tl.GetSetting("timelineFrameRate"))
print("frames:", tl.GetStartFrame(), "->", tl.GetEndFrame())

# --- pass A: track enumeration only (the "cheap tier" candidate)
t0 = time.time()
tracks = []
for tt in ("video", "audio", "subtitle"):
    n = tl.GetTrackCount(tt)
    for i in range(1, n + 1):
        tracks.append((tt, i, tl.GetTrackName(tt, i),
                       tl.GetIsTrackEnabled(tt, i), tl.GetIsTrackLocked(tt, i)))
tA = time.time() - t0
print("passA tracks-only: %.3fs  (%d tracks)" % (tA, len(tracks)))
for r in tracks:
    print("   ", r)

# --- pass B: full per-clip read (the real snapshot)
t0 = time.time()
clips = []
for tt in ("video", "audio"):
    for i in range(1, tl.GetTrackCount(tt) + 1):
        for it in (tl.GetItemListInTrack(tt, i) or []):
            clips.append({
                "id": it.GetUniqueId(),
                "name": it.GetName(),
                "track": (tt, i),
                "start": it.GetStart(),
                "end": it.GetEnd(),
                "dur": it.GetDuration(),
                "lo": it.GetLeftOffset(),
                "ro": it.GetRightOffset(),
                "enabled": it.GetClipEnabled(),
                "color": it.GetClipColor(),
            })
tB = time.time() - t0
print("passB full read: %.3fs  (%d clips)" % (tB, len(clips)))
if clips:
    print("per-clip: %.1f ms" % (tB / len(clips) * 1000.0))
    print("sample:", clips[0])

# --- pass C: markers
t0 = time.time()
m = tl.GetMarkers()
tC = time.time() - t0
print("passC markers: %.3fs  (%d)" % (tC, len(m or {})))
print("TOTAL SNAPSHOT: %.3fs" % (tA + tB + tC))


# =====================================================================
# SPIKE 2 — thumbnail access (epic E0.4, decides E6 path A)
# Reads the thumbnail at the CURRENT playhead. Does not move the playhead.
# =====================================================================

print("=== SPIKE 2 ===")
cur = tl.GetCurrentVideoItem()
print("clip at playhead:", cur.GetName() if cur else None)
try:
    th = tl.GetCurrentClipThumbnailImage()
    if isinstance(th, dict):
        print("keys:", list(th.keys()))
        for k, v in th.items():
            print("   ", k, "=", (str(v)[:60] + "...") if len(str(v)) > 60 else v,
                  "(len %d)" % len(str(v)))
    else:
        print("type:", type(th), "value:", str(th)[:120])
except Exception as e:
    print("FAILED:", repr(e))

# timing across 5 clips (moves playhead — set it back with the timecode printed above)
print("start timecode was:", tl.GetCurrentTimecode())


# =====================================================================
# SPIKE 3 — audio survey (epic E0.10, decides E6 path D)
# How many clips actually carry source audio, and how many channels.
# =====================================================================

print("=== SPIKE 3 ===")
from collections import Counter

audio_ch = Counter()
fmt = Counter()
no_mpi = 0
t0 = time.time()
for i in range(1, tl.GetTrackCount("video") + 1):
    for it in (tl.GetItemListInTrack("video", i) or []):
        mpi = it.GetMediaPoolItem()
        if not mpi:
            no_mpi += 1
            continue
        p = mpi.GetClipProperty()
        audio_ch[p.get("Audio Ch", "?")] += 1
        fmt[(p.get("Video Codec", "?"), p.get("Resolution", "?"), p.get("FPS", "?"))] += 1
print("survey: %.3fs" % (time.time() - t0))
print("audio channels ->", dict(audio_ch))
print("no mediapoolitem:", no_mpi)
print("formats ->")
for k, v in fmt.most_common(10):
    print("   ", v, "x", k)

# what clip properties are even available (useful for E3 snapshot design)
first = None
for i in range(1, tl.GetTrackCount("video") + 1):
    l = tl.GetItemListInTrack("video", i) or []
    if l:
        first = l[0].GetMediaPoolItem()
        break
if first:
    print("available clip properties:", sorted(first.GetClipProperty().keys()))
