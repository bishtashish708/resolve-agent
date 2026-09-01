#!/bin/bash
# Install the Resolve Agent plugin. macOS only (v1 decision, 31 Aug 2026).
#
# Doc 2 E7.1 — SYSTEM-level path, not ~/Library. Resolve does not reliably
# scan the user-level path (verified by another project on Studio 20.3).
# Doc 2 E7.4 — check preconditions and name the specific failure.

set -euo pipefail

PLUGIN_ID="com.resolveagent.plugin"
BMD="/Library/Application Support/Blackmagic Design/DaVinci Resolve"
DEV_DIR="$BMD/Developer/Workflow Integrations"
DEST_ROOT="$BMD/Workflow Integration Plugins"
DEST="$DEST_ROOT/$PLUGIN_ID"
SRC="$(cd "$(dirname "$0")" && pwd)/plugin"

fail() { echo "FAIL: $1" >&2; exit 1; }
ok()   { echo "  ok  $1"; }

echo "Resolve Agent installer"
echo "-----------------------"

# --- preconditions -----------------------------------------------------
[ -d "$BMD" ] || fail "DaVinci Resolve not found at $BMD"
ok "Resolve support dir found"

if [ -d "/Applications/DaVinci Resolve/DaVinci Resolve.app" ]; then
  ok "Resolve app found"
else
  echo "  ??  Resolve.app not at the usual path - continuing anyway"
fi

# Workflow Integrations are Studio-only, and are reportedly ABSENT from the
# Mac App Store build (Apple sandbox). If the Developer dir is missing, that
# is the most likely reason.
[ -d "$DEV_DIR" ] || fail "No 'Developer/Workflow Integrations' dir.
       You are probably on Resolve free, or the Mac App Store build.
       Workflow Integration Plugins require Studio, installed from
       blackmagicdesign.com (NOT the App Store)."
ok "Workflow Integrations SDK present"

# --- the native bridge -------------------------------------------------
# VERIFIED 31 Aug 2026: the four Example plugins ship FOUR DIFFERENT binaries
# (distinct sha1s). They are NOT interchangeable. An earlier version of this
# script used `find | head -1`, which picked CompatibleSamplePlugin — BMD's
# LEGACY pre-19.0.2 non-sandboxed example. Our architecture is the modern
# sandboxed one, so we must take SamplePlugin's.
#
#   SamplePlugin            84e70429...  <- modern sandboxed model. USE THIS.
#   CompatibleSamplePlugin  9ed9145a...  <- legacy, nodeIntegration:true
#   SamplePromisePlugin     48da4aa0...  <- promise-flavoured API
#   ScriptTestPlugin        d0f69288...
NODE_BIN="$DEV_DIR/Examples/SamplePlugin/WorkflowIntegration.node"
if [ ! -f "$NODE_BIN" ]; then
  echo "  !!  SamplePlugin binary missing - falling back to first found"
  NODE_BIN="$(find "$DEV_DIR" -name 'WorkflowIntegration.node' -maxdepth 3 2>/dev/null | head -1 || true)"
  [ -n "$NODE_BIN" ] || fail "WorkflowIntegration.node not found under $DEV_DIR"
  echo "  !!  using $NODE_BIN - verify this is the sandboxed build"
fi
ok "bridge: $NODE_BIN"
ok "sha1:   $(shasum "$NODE_BIN" | cut -d' ' -f1)"

# --- install -----------------------------------------------------------
[ -w "$DEST_ROOT" ] || [ -w "$BMD" ] || {
  echo "  !!  $DEST_ROOT is not writable - re-running with sudo"
  exec sudo "$0" "$@"
}

mkdir -p "$DEST"
cp -R "$SRC/." "$DEST/"
cp "$NODE_BIN" "$DEST/WorkflowIntegration.node"
ok "copied plugin -> $DEST"

# Doc 2 E7.5 — Gatekeeper quarantines the copied native module.
xattr -cr "$DEST" 2>/dev/null || true
ok "cleared quarantine attributes"

echo
echo "Installed. Now:"
echo "  1. FULLY QUIT DaVinci Resolve and reopen it."
echo "     (Resolve scans the plugin root at STARTUP only - Doc 2 E7.2)"
echo "  2. Workspace > Workflow Integrations > Resolve Agent"
echo
echo "Spike 0.2 (hot reload): after the first launch, edit a file in"
echo "  $DEST"
echo "then relaunch from the Workspace menu WITHOUT restarting Resolve."
echo "If the change appears, the dev loop works and iteration is cheap."
