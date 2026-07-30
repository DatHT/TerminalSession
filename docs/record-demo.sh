#!/bin/bash
# Turn a screen recording into an optimized demo.gif.
#
# 1. Record the search panel with macOS:  ⌘⇧5 → record a region → stop.
#    Save the .mov (default lands on your Desktop).
# 2. Run:  bash docs/record-demo.sh ~/Desktop/your-recording.mov
#
# Produces docs/demo.gif (palette-optimized, ~12fps, max width 860).
set -euo pipefail

SRC="${1:?usage: record-demo.sh <screen-recording.mov>}"
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/demo.gif"
PAL="$(mktemp -t tmpal).png"

ffmpeg -y -i "$SRC" -vf "fps=12,scale=860:-1:flags=lanczos,palettegen=stats_mode=diff" "$PAL"
ffmpeg -y -i "$SRC" -i "$PAL" \
  -lavfi "fps=12,scale=860:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer" "$OUT"
rm -f "$PAL"
echo "wrote $OUT"
