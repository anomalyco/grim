#!/usr/bin/env bash
# Run editor parity scenarios on the Mac. Usage: tools/parity/run.sh [both|bear|ours] [filter]
set -euo pipefail
MODE="${1:-ours}"
FILTER="${2:-}"
MAC="${PARITY_MAC:-james@100.109.145.97}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT=/tmp/opencode/parity
mkdir -p "$OUT/page"

bun build "$HERE/page.ts" --outfile "$OUT/page/page.js" --target browser >/dev/null
cp "$HERE/page.html" "$OUT/page/page.html"
cp "$ROOT/src/client/editor/editor.css" "$OUT/page/editor.css"
ssh -o BatchMode=yes "$MAC" 'mkdir -p /tmp/parity/page'
scp -q "$OUT/page/"* "$MAC:/tmp/parity/page/"
scp -q "$HERE/runner.swift" "$HERE/scenarios.json" "$MAC:/tmp/parity/"

if [ "$MODE" != "bear" ]; then
  # A separate Chrome instance (own profile) with CDP on 9333, restarted every run so it loads the new build.
  ssh -o BatchMode=yes "$MAC" '
    pkill -f "user-data-dir=/tmp/parity-chrome" 2>/dev/null; sleep 1
    open -na "Google Chrome" --args --user-data-dir=/tmp/parity-chrome --remote-debugging-port=9333 \
      --no-first-run --no-default-browser-check --window-size=1000,800 file:///tmp/parity/page/page.html
    for i in $(seq 1 30); do curl -s -m 1 http://127.0.0.1:9333/json/version >/dev/null && break; sleep 0.5; done
    sleep 2'
fi

TARGET=$([ "$MODE" = "ours" ] && echo chrome || echo "$MODE")
RESULT=$([ "$MODE" = "bear" ] && echo bear.json || echo ours.json)
ssh -o BatchMode=yes "$MAC" "cd /tmp/parity && swift runner.swift scenarios.json $RESULT $TARGET '$FILTER'"
scp -q "$MAC:/tmp/parity/$RESULT" "$OUT/$RESULT"
if [ "$MODE" = "ours" ]; then scp -q "$MAC:/tmp/parity/bear.json" "$OUT/bear.json"; fi
if [ -f "$OUT/bear.json" ] && [ -f "$OUT/ours.json" ]; then
  bun "$HERE/compare.ts" "$OUT/bear.json" "$OUT/ours.json" "$OUT/report.md"
fi
