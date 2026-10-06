#!/usr/bin/env bash
# demo/stop-demo.sh — take the demo down cleanly.
#
# Sends SIGTERM to the launcher recorded in $DEMO_ROOT/demo.pid. start-demo.sh
# traps it, stops its children and exits 0, so a stop never lands in a
# supervisor's task list as "failed (exit 143)" — which is what a plain kill of
# a tracked background task produces.
#
# Usage:
#   demo/stop-demo.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
DEMO_ROOT="${DEMO_ROOT:-$HERE/data}"
DEMO_PID_FILE="${DEMO_PID_FILE:-$DEMO_ROOT/demo.pid}"
DEMO_API_PORT="${DEMO_API_PORT:-8095}"
BRIDGE_PORT="${BRIDGE_PORT:-8096}"

if [[ -f "$DEMO_PID_FILE" ]]; then
  pid="$(cat "$DEMO_PID_FILE" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "[demo] stopping launcher $pid ..."
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 40); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
  fi
  rm -f "$DEMO_PID_FILE"
else
  echo "[demo] no pid file at $DEMO_PID_FILE"
fi

# Belt and braces: free the demo ports, but only from this checkout's demo
# processes (the bridge by its script path, the hub by its working directory),
# never whatever else happens to listen there.
for port in "$DEMO_API_PORT" "$BRIDGE_PORT"; do
  for pid in $(ss -lptnH "sport = :$port" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true); do
    cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    if [[ "$cmd" == *"$HERE/bridge.py"* || "$cwd" == "$REPO/server" ]]; then
      echo "[demo] freeing port $port (pid $pid)"
      kill "$pid" 2>/dev/null || true
    fi
  done
done

echo "[demo] down."
