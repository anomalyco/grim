#!/usr/bin/env bash
# Start (or restart) the live Grim server in the background with settings from ~/.config/grimoire/live.env.
# A normal stop (SIGTERM) commits pending edits before exiting.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${GRIMOIRE_ENV:-$HOME/.config/grimoire/live.env}"
for p in $(pgrep -f "^bun src/server/index.ts" || true); do
  kill -TERM "$p"
  for _ in $(seq 1 40); do kill -0 "$p" 2>/dev/null || break; sleep 0.5; done
done
bun run build:client >/dev/null
set -a; . "$ENV_FILE"; set +a
mkdir -p "$DATA_DIR"
setsid nohup bun src/server/index.ts >> "$DATA_DIR/server.log" 2>&1 < /dev/null &
sleep 3
tail -n 3 "$DATA_DIR/server.log"
