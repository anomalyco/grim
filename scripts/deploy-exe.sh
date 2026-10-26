#!/usr/bin/env bash
# Deploy Grimoire to an exe.dev VM: sync the code, install, build, (re)install the systemd service, restart, check health.
# Usage: scripts/deploy-exe.sh [vm-host]        (default grimoire.exe.xyz)
# Secrets (Code Storage key, env file) live on the VM in /etc/grimoire/ and are never synced from here.
set -euo pipefail
HOST="${1:-grimoire.exe.xyz}"
APP=/home/exedev/grimoire
cd "$(dirname "$0")/.."

rsync -az --delete \
  --exclude node_modules --exclude dist --exclude data --exclude .git --exclude '*.log' \
  ./ "$HOST:$APP/"

ssh -o BatchMode=yes "$HOST" bash -s <<'REMOTE'
set -euo pipefail
APP=/home/exedev/grimoire
export PATH="$HOME/.bun/bin:$PATH"
cd "$APP"
bun install --frozen-lockfile >/dev/null
bun run build:client >/dev/null
sudo install -d -m 700 -o exedev -g exedev /etc/grimoire /var/lib/grimoire
sudo tee /etc/systemd/system/grimoire.service >/dev/null <<UNIT
[Unit]
Description=Grimoire (multiplayer markdown notebooks)
After=network-online.target
Wants=network-online.target

[Service]
User=exedev
WorkingDirectory=$APP
EnvironmentFile=/etc/grimoire/grimoire.env
ExecStart=/home/exedev/.bun/bin/bun src/server/index.ts
# SIGTERM makes the server commit pending edits before exiting.
KillSignal=SIGTERM
TimeoutStopSec=30
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable grimoire >/dev/null 2>&1
sudo systemctl restart grimoire
for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:8000/api/config && break; sleep 0.5; done
curl -fsS http://127.0.0.1:8000/api/config && echo
sudo journalctl -u grimoire -n 3 --no-pager -o cat
REMOTE
