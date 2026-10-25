#!/bin/bash
nohup ~/.bearshot/daemon.sh > ~/.bearshot/daemon.log 2>&1 &
disown
osascript -e "tell application \"Terminal\" to close (every window whose name contains \"start.command\")" >/dev/null 2>&1 &
exit 0
