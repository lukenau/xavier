#!/usr/bin/env bash
#
# setup-mesh.sh — put this machine on a private Tailscale mesh and publish the
# hub over it, so your phone can reach it at a stable HTTPS URL.
#
# Why a mesh: the hub binds to 127.0.0.1 and is not exposed to the internet.
# Tailscale gives you an encrypted path plus a real certificate, which iOS
# requires (App Transport Security rejects plain http:// to anything other than
# localhost). Nothing is opened at your router.
#
# Usage:
#   ./scripts/setup-mesh.sh              # join, publish, print your URL
#   ./scripts/setup-mesh.sh --status     # inspect, change nothing
#   ./scripts/setup-mesh.sh --off        # stop publishing (stays on the mesh)
#   ./scripts/setup-mesh.sh --help
#
# Options:
#   --port N             local hub port (default 8090)
#   --https-port N       tailnet HTTPS port to serve on (default 443)
#   --login-server URL   use a self-hosted control plane (Headscale)
#   --no-serve           join the mesh only; do not publish the hub
#   --install            install Tailscale if the binary is missing
#
# Never runs `tailscale funnel`. Funnel would expose the hub to the public
# internet, which is the opposite of the point. See docs/MESH.md.

set -euo pipefail

HUB_PORT="${HUB_PORT:-8090}"
HTTPS_PORT="${HTTPS_PORT:-443}"
LOGIN_SERVER=""
DO_SERVE=1
DO_INSTALL=0
MODE="up"

usage() {
  sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --status) MODE="status"; shift ;;
    --off) MODE="off"; shift ;;
    --port) HUB_PORT="${2:?--port needs a value}"; shift 2 ;;
    --https-port) HTTPS_PORT="${2:?--https-port needs a value}"; shift 2 ;;
    --login-server) LOGIN_SERVER="${2:?--login-server needs a URL}"; shift 2 ;;
    --no-serve) DO_SERVE=0; shift ;;
    --install) DO_INSTALL=1; shift ;;
    *) echo "unknown option: $1" >&2; echo "try --help" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# sudo only when we are not already root.
as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

have() { command -v "$1" >/dev/null 2>&1; }

# --- locating and (optionally) installing tailscale --------------------------

if ! have tailscale; then
  if [ "$MODE" = "status" ]; then
    die "tailscale is not installed"
  fi
  if [ "$DO_INSTALL" -eq 1 ]; then
    say "Installing Tailscale from the official installer..."
    curl -fsSL https://tailscale.com/install.sh | sh \
      || die "installer failed; see https://tailscale.com/download"
  else
    say "Tailscale is not installed."
    say ""
    say "Install it, then re-run this script:"
    say "  Linux:  curl -fsSL https://tailscale.com/install.sh | sh"
    say "  macOS:  https://tailscale.com/download/mac"
    say ""
    say "Or let this script do it:  $0 --install"
    exit 1
  fi
fi

# --- helpers over the tailscale CLI ------------------------------------------

ts_json() { tailscale status --json 2>/dev/null || true; }

mesh_state() {
  ts_json | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("unknown"); raise SystemExit
print(d.get("BackendState") or "unknown")' 2>/dev/null || echo unknown
}

mesh_dnsname() {
  ts_json | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    raise SystemExit
self = d.get("Self") or {}
print((self.get("DNSName") or "").rstrip("."))' 2>/dev/null || echo ""
}

# --- status -----------------------------------------------------------------

if [ "$MODE" = "status" ]; then
  say "tailscale:  $(have tailscale && tailscale version | head -1 || echo 'not installed')"
  say "mesh state: $(mesh_state)"
  name="$(mesh_dnsname)"
  if [ -n "$name" ]; then
    say "tailnet name: ${name}"
    say "hub URL:      https://${name}/  (plus :PORT if you serve on a port other than 443)"
  else
    say "tailnet name: (not connected yet)"
  fi
  say ""
  say "serve config:"
  if have tailscale; then
    tailscale serve status 2>&1 | sed 's/^/  /' || true
  fi
  say ""
  say "hub local health:"
  if have curl; then
    if curl -fsS "http://127.0.0.1:${HUB_PORT}/api/healthz" >/dev/null 2>&1; then
      say "  http://127.0.0.1:${HUB_PORT}/api/healthz -> ok"
    else
      say "  http://127.0.0.1:${HUB_PORT}/api/healthz -> not answering"
    fi
  fi
  exit 0
fi

# --- stop publishing --------------------------------------------------------

if [ "$MODE" = "off" ]; then
  say "Stopping the tailnet proxy for the hub (leaving the mesh itself up)..."
  # Only the route this script made: `serve reset` would also drop every other
  # serve route on the machine.
  as_root tailscale serve --https="${HTTPS_PORT}" off \
    || die "could not remove the hub's serve route (see: tailscale serve status)"
  say "Done. The machine is still on the mesh; the hub is no longer published."
  say "Re-enable with: $0"
  exit 0
fi

# --- 1. join the mesh -------------------------------------------------------

state="$(mesh_state)"
if [ "$state" = "Running" ]; then
  say "Already on the mesh ($(mesh_dnsname || echo 'name pending'))."
else
  say "Joining the mesh (a browser or terminal sign-in may appear)..."
  if [ -n "$LOGIN_SERVER" ]; then
    as_root tailscale up --login-server "$LOGIN_SERVER" || die "tailscale up failed"
  else
    as_root tailscale up || die "tailscale up failed"
  fi
fi

name="$(mesh_dnsname)"
[ -n "$name" ] || die "joined, but no tailnet DNS name yet; try: tailscale status"
if [ "$HTTPS_PORT" = "443" ]; then hub_url="https://${name}"; else hub_url="https://${name}:${HTTPS_PORT}"; fi

# --- 2. confirm the hub answers locally -------------------------------------

if have curl; then
  if curl -fsS "http://127.0.0.1:${HUB_PORT}/api/healthz" >/dev/null 2>&1; then
    say "Hub is answering on 127.0.0.1:${HUB_PORT}."
  else
    warn "nothing is answering on 127.0.0.1:${HUB_PORT}/api/healthz."
    warn "start the hub first (./install.sh --start), or pass --port N."
    warn "continuing anyway — the proxy is added but will 502 until the hub is up."
  fi
fi

# --- 3. publish over the tailnet (HTTPS, tailnet-only) ----------------------

if [ "$DO_SERVE" -eq 1 ]; then
  say "Publishing the hub over the mesh on HTTPS port ${HTTPS_PORT}..."
  as_root tailscale serve --bg --https="${HTTPS_PORT}" \
    "http://127.0.0.1:${HUB_PORT}" || die "tailscale serve failed"

  if tailscale funnel status 2>/dev/null | grep -qi 'funnel'; then
    warn "a funnel appears to be configured. That exposes the hub to the"
    warn "public internet. Remove it:  sudo tailscale funnel reset"
  fi
fi

# --- done -------------------------------------------------------------------

say ""
say "Mesh setup complete."
say ""
say "  Your hub URL:  ${hub_url}"
say ""
say "Next:"
say "  1. Tell the server its address — it only answers to hostnames it knows."
say "     In .env set  HUB_ORIGIN=${hub_url}  then run ./install.sh --restart."
say "  2. Install the Tailscale app on your phone and sign in to the SAME tailnet."
say "  3. Open ${hub_url}/api/healthz on the phone to confirm it answers."
say "  4. Point the app at the hub URL and pair it with a one-time code from"
say "     ./install.sh --pair. See docs/CONNECT-APP.md."
say ""
say "Notes:"
say "  - This is tailnet-only. Only devices signed in to your tailnet can reach it."
say "  - Never use 'tailscale funnel'. It would expose this publicly."
say "  - Keep the machine name stable: the URL is derived from it."
say "  - Re-check any time with:  $0 --status"
