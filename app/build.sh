#!/bin/bash
# Build the native menu-bar app into app/build/Terminal Sessions.app
# Requires the Xcode command-line tools (swiftc). No third-party dependencies.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PROJ="$(cd "$DIR/.." && pwd)"
APP="$DIR/build/Terminal Sessions.app"
BIN="TerminalSessions"

echo "==> cleaning"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "==> compiling Swift (swift 5 mode)"
swiftc -swift-version 5 -O \
    -framework AppKit \
    -framework Carbon \
    -framework ServiceManagement \
    -o "$APP/Contents/MacOS/$BIN" \
    "$DIR"/Sources/*.swift

echo "==> assembling bundle"
cp "$DIR/Info.plist" "$APP/Contents/Info.plist"

# Bundle the (already-tested) Node engine so the .app is self-contained.
rm -rf "$APP/Contents/Resources/tm"
cp -R "$PROJ/assets/tm" "$APP/Contents/Resources/tm"

# Ad-hoc code signature — gives the app a stable identity for TCC (Automation)
# and lets macOS load it without Gatekeeper complaints for a locally built app.
echo "==> ad-hoc signing"
codesign --force --sign - "$APP" >/dev/null 2>&1 || echo "   (codesign skipped)"

echo "==> done: $APP"
