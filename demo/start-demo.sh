#!/usr/bin/env bash
# demo/start-demo.sh — bring up the Xavier demo (fake bridge + seeded hub-api).
#
# Everything is fictional; nothing here touches the real hub (ports 8090/8091)
# or the real data dirs. The API binds loopback on 8095, the stub bridge on 8096.
# Fake data lives under DEMO_ROOT (default: demo/data, gitignored).
#
# HUB_ORIGIN comes from YOUR environment and is unset by default: every passkey
# write surface then answers 503 webauthn_unconfigured and the chat/terminal gates
# show their locked state. Writes refuse on a demo box — the intended posture. To
# demo pairing and Face ID through a mesh, export the https address the demo is
# served on first, e.g. HUB_ORIGIN=https://demo.<your-tailnet>.ts.net:8448 — the
# server also only answers to hostnames it knows, and that one is then among them.
#
# Usage:
#   demo/start-demo.sh            # start, wait for readiness, keep running
#   Ctrl-C                        # stops both processes
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
SERVER="$REPO/server"
PY="$SERVER/.venv/bin/python"
if [[ ! -x "$PY" ]]; then
  PY="$(command -v python3)"
fi

DEMO_ROOT="${DEMO_ROOT:-$HERE/data}"
DEMO_PID_FILE="${DEMO_PID_FILE:-$DEMO_ROOT/demo.pid}"
DEMO_API_HOST="${DEMO_API_HOST:-127.0.0.1}"
DEMO_API_PORT="${DEMO_API_PORT:-8095}"
HUB_BRIDGE_URL="${HUB_BRIDGE_URL:-http://127.0.0.1:8096}"

export DEMO_ROOT HUB_BRIDGE_URL
export HUB_BRIDGE_TIMEOUT_S=35

# Cache / store paths — mirror demo/seed.py and app.py's env-overridable names.
export MY_PAGES_ROOT="$DEMO_ROOT/Sites/my-pages"
export HUB_LOG_DIR="$DEMO_ROOT/log"
export HUB_ACCESS_REPORT="$DEMO_ROOT/.hub/access-report.json"
export HUB_ROSTER="$DEMO_ROOT/.hub/agents.json"
export HUB_ACTIVITY="$DEMO_ROOT/.hub/activity.json"
export HUB_SCHEDULES="$DEMO_ROOT/.hub/schedules.json"
export HUB_SKILLS="$DEMO_ROOT/.hub/skills.json"
export HUB_INBOX_DIR="$DEMO_ROOT/hub-inbox"
export HUB_DECISIONS_DIR="$DEMO_ROOT/decisions"
export HUB_FINANCE_SNAPSHOT="$DEMO_ROOT/sites/finance/snapshot.json"
export HUB_RECURRING_COSTS="$DEMO_ROOT/finance/recurring-costs.json"
export HUB_MCP_WATCH_LOG="$DEMO_ROOT/log/mcp-watch.jsonl"
export HUB_CHAT_DB="$DEMO_ROOT/chat/chat.db"
export HUB_CHAT_MEDIA_DIR="$DEMO_ROOT/chat/media"
export HUB_CHAT_SESSIONS_FILE="$DEMO_ROOT/chat/sessions.json"
export HUB_BRIEFING_DISMISSALS="$DEMO_ROOT/data/briefing_dismissals.json"
export HUB_BRIEFING_FEEDBACK="$DEMO_ROOT/data/briefing_feedback.jsonl"
export HUB_BRIEFING_RULES="$DEMO_ROOT/data/briefing_rules.json"
export HUB_PUSH_TOKENS="$DEMO_ROOT/data/push_tokens.json"
export HUB_TOPICS_CONFIG="$DEMO_ROOT/hub-config/telegram-topics.json"
export HUB_TOPICS_LIVE="$DEMO_ROOT/hub-config/telegram-topics.live.json"
# Host shell manager: the demo's stub (served by bridge.py on this unix socket).
# hub-tmuxd is an optional host daemon (the host/ kit) the demo does not run, so without
# this the Ops "Claude shells" read is an honest 503 and the section stays empty.
export DEMO_TMUXD_SOCK="$DEMO_ROOT/data/tmuxd.sock"
export HUB_TMUXD_SOCK="$DEMO_TMUXD_SOCK"
# Calendar: the host snapshot hub_calendar.py reads (seeded by demo/seed.py).
export HUB_CALENDAR="$DEMO_ROOT/hub-config/calendar.json"
export HUB_FS_ROOTS="sites:Sites:$DEMO_ROOT/Sites;hub_config:.hub:$DEMO_ROOT/.hub;workspace:Workspace:$DEMO_ROOT/workspace"

# Point the gateway reads at the stub bridge's fake-gateway routes.
export HERMES_API_BASE="$HUB_BRIDGE_URL"
export HERMES_API_KEY="demo-not-a-secret"
export HERMES_AGENT_ID="demo-agent"
export HERMES_AGENT_NAME="Demo Agent"
export HUB_TZ="${HUB_TZ:-UTC}"

# Demo posture: the passkey and device-key stores live inside DEMO_ROOT, and no
# real provider keys are passed through. HUB_ORIGIN is whatever you exported.
export HUB_ORIGIN="${HUB_ORIGIN:-}"
export HUB_RP_NAME="Hub (demo)"
export HUB_USER_NAME="demo-user"
export HUB_USER_DISPLAY="Demo User"
export HUB_PASSKEYS="$DEMO_ROOT/auth/passkeys.json"
export HUB_DEVICEKEYS="$DEMO_ROOT/auth/devicekeys.json"
export HUB_PAIR_SOCK="$DEMO_ROOT/auth/pair.sock"
unset OPENROUTER_API_KEY OPENROUTER_MGMT_KEY || true

BRIDGE_PID=""
API_PID=""
cleanup() {
  for pid in "$API_PID" "$BRIDGE_PID"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait_http() {
  local url="$1" tries="${2:-60}"
  for ((i = 0; i < tries; i++)); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  return 1
}

# Fail fast BEFORE the seed wipes DEMO_ROOT out from under a live instance.
port_busy() {
  "$PY" - "$1" <<'EOF'
import socket, sys
s = socket.socket()
try:
    s.connect(("127.0.0.1", int(sys.argv[1]))); print("busy")
except OSError:
    print("free")
finally:
    s.close()
EOF
}
for port in "${HUB_BRIDGE_URL##*:}" "$DEMO_API_PORT"; do
  if [[ "$(port_busy "$port")" == "busy" ]]; then
    echo "[demo] ERROR: port $port is already in use — another demo instance is" >&2
    echo "[demo]        running. Stop it first (Ctrl-C in its terminal, or kill" >&2
    echo "[demo]        its bridge/uvicorn PIDs) and try again." >&2
    exit 1
  fi
done

echo "[demo] seeding fake data under $DEMO_ROOT ..."
"$PY" "$HERE/seed.py"
mkdir -p "$DEMO_ROOT"
echo "$$" > "$DEMO_PID_FILE"

started_pids=()
stop_demo() {
  # A stop is not a failure. Taking the demo down with SIGTERM/SIGINT (or
  # demo/stop-demo.sh) is the normal path, but a supervisor watching this
  # process records exit 143 as a failed background task and the Hub draws a red
  # card for it. Trap, stop the children, and leave with 0.
  trap - TERM INT
  for pid in "${started_pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  rm -f "$DEMO_PID_FILE"
  echo "[demo] stopped."
  exit 0
}
trap stop_demo TERM INT

echo "[demo] starting stub bridge on $HUB_BRIDGE_URL ..."
"$PY" "$HERE/bridge.py" &
BRIDGE_PID=$!
started_pids+=("$BRIDGE_PID")
if ! wait_http "$HUB_BRIDGE_URL/health"; then
  echo "[demo] ERROR: stub bridge did not come up" >&2
  exit 1
fi

echo "[demo] starting hub-api on http://$DEMO_API_HOST:$DEMO_API_PORT ..."
( cd "$SERVER" && exec "$PY" -m uvicorn app:app --host "$DEMO_API_HOST" --port "$DEMO_API_PORT" --log-level warning ) &
API_PID=$!
started_pids+=("$API_PID")
if ! wait_http "http://$DEMO_API_HOST:$DEMO_API_PORT/api/healthz"; then
  echo "[demo] ERROR: hub-api did not become ready" >&2
  exit 1
fi

echo "[demo] ready — probing read endpoints:"
for ep in /api/health /api/agents /api/schedules /api/skills /api/activity /api/feed \
          /api/brief /api/my-pages /api/decisions /api/finance /api/vitals /api/sessions \
          /api/cron /api/kanban /api/connectors /api/memory /api/chat/bootstrap; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://$DEMO_API_HOST:$DEMO_API_PORT$ep" || echo "ERR")
  printf '  %-24s %s\n' "$ep" "$code"
done
echo "[demo] (chat/bootstrap is cookie-gated: 412 no_passkey is the locked state)"
echo "[demo] Ctrl-C to stop."
wait
