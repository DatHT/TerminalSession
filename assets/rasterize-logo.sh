#!/bin/bash
# Rasterize assets/logo.svg → a transparent PNG at a given size (default 512),
# using headless Chrome. Usage:  bash assets/rasterize-logo.sh [size] [out.png]
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
SIZE="${1:-512}"
OUT="${2:-$DIR/command-icon.png}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP="$(mktemp -d)"

# wrap the SVG so it exactly fills a SIZE×SIZE viewport
{
  echo '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0}svg{display:block}</style>'
  sed -E "s/<svg /<svg width=\"$SIZE\" height=\"$SIZE\" /" "$DIR/logo.svg"
} > "$TMP/wrap.html"

"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size="$SIZE,$SIZE" \
  --default-background-color=00000000 \
  --screenshot="$OUT" "file://$TMP/wrap.html" >/dev/null 2>&1

rm -rf "$TMP"
echo "wrote $OUT (${SIZE}x${SIZE}, transparent)"
