#!/bin/bash
# Screenshot helper: runs under Terminal (which has Screen Recording permission).
# Request: write an output path into ~/.bearshot/req ; result appears at that path.
cd ~/.bearshot
echo $$ > pid
swift /tmp/axcheck.swift > perm.txt 2>&1
while true; do
  if [ -f req ]; then
    out=$(cat req); rm -f req
    args=$(cat args 2>/dev/null); rm -f args
    screencapture -x $args "$out.tmp.png" && mv "$out.tmp.png" "$out"
  fi
  sleep 0.2
done
