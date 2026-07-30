#!/bin/bash
# One-command install: build → copy to /Applications → register with Launch
# Services → refresh Finder's icon cache → launch. Run from anywhere:
#   bash app/install.sh
#
# (A freshly built .app often shows a generic icon in the build folder until it
#  is registered — this handles that so the logo shows immediately.)
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
APP_SRC="$DIR/build/Terminal Sessions.app"
APP_DST="/Applications/Terminal Sessions.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

echo "==> building"
bash "$DIR/build.sh"

echo "==> installing to /Applications"
pkill -f TerminalSessions 2>/dev/null || true
sleep 1
rm -rf "$APP_DST"
cp -R "$APP_SRC" "$APP_DST"

echo "==> registering + refreshing icon"
"$LSREGISTER" -f "$APP_DST" >/dev/null 2>&1 || true
touch "$APP_DST"
killall Finder >/dev/null 2>&1 || true

echo "==> launching"
open "$APP_DST"

echo ""
echo "Installed: $APP_DST"
echo "• App icon (the logo) now shows in Finder → Applications."
echo "• Menu-bar icon: the >| mark near the top-right (may sit just left of the notch)."
echo "• Press ⌥Space, or run 'open terminalsessions://', to open the search panel."
