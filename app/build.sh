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

# App icon (Finder, Get Info, the Automation permission dialog) from the logo.
ICON_SRC="$PROJ/assets/command-icon.png"
if [ -f "$ICON_SRC" ] && command -v iconutil >/dev/null 2>&1; then
  ICONSET="$(mktemp -d)/AppIcon.iconset"; mkdir -p "$ICONSET"
  sips -z 16 16     "$ICON_SRC" --out "$ICONSET/icon_16x16.png"      >/dev/null
  sips -z 32 32     "$ICON_SRC" --out "$ICONSET/icon_16x16@2x.png"   >/dev/null
  sips -z 32 32     "$ICON_SRC" --out "$ICONSET/icon_32x32.png"      >/dev/null
  sips -z 64 64     "$ICON_SRC" --out "$ICONSET/icon_32x32@2x.png"   >/dev/null
  sips -z 128 128   "$ICON_SRC" --out "$ICONSET/icon_128x128.png"    >/dev/null
  sips -z 256 256   "$ICON_SRC" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
  sips -z 256 256   "$ICON_SRC" --out "$ICONSET/icon_256x256.png"    >/dev/null
  sips -z 512 512   "$ICON_SRC" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
  sips -z 512 512   "$ICON_SRC" --out "$ICONSET/icon_512x512.png"    >/dev/null
  sips -z 1024 1024 "$ICON_SRC" --out "$ICONSET/icon_512x512@2x.png" >/dev/null
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
  rm -rf "$(dirname "$ICONSET")"
  echo "==> app icon set"
fi

# Ad-hoc code signature — gives the app a stable identity for TCC (Automation)
# and lets macOS load it without Gatekeeper complaints for a locally built app.
echo "==> ad-hoc signing"
codesign --force --sign - "$APP" >/dev/null 2>&1 || echo "   (codesign skipped)"

echo "==> done: $APP"
