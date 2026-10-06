#!/usr/bin/env bash
# Xavier one-command bootstrap.
#
#   ./install.sh              check prerequisites, configure, build, start
#   ./install.sh --start      start an existing install
#   ./install.sh --stop       stop the server (keeps data)
#   ./install.sh --restart    recreate the server so .env changes apply (keeps data)
#   ./install.sh --update     git pull, rebuild, restart
#   ./install.sh --logs       follow server logs
#   ./install.sh --status     show container state + health
#   ./install.sh --url        print the https address the app should use
#   ./install.sh --pair       mint a one-time device enrolment code (local)
#   ./install.sh --uninstall  stop and DELETE all data (asks first)
#   ./install.sh --help       this text
#
# Everything runs locally. The server binds to loopback by default; nothing is
# exposed unless you deliberately put a private mesh or proxy in front of it
# (see docs/MESH.md).
set -euo pipefail
cd "$(dirname "$0")"

BOLD=$'\033[1m'; DIM=$'\033[2m'; CYAN=$'\033[1;36m'; GREEN=$'\033[1;32m'
RED=$'\033[1;31m'; YELLOW=$'\033[1;33m'; RESET=$'\033[0m'
say()  { printf '%s\n' "${CYAN}$*${RESET}"; }
ok()   { printf '%s\n' "${GREEN}✔ $*${RESET}"; }
warn() { printf '%s\n' "${YELLOW}! $*${RESET}" >&2; }
die()  { printf '%s\n' "${RED}✘ $*${RESET}" >&2; exit 1; }

usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"; exit 0; }

# Portable in-place edit (GNU sed vs BSD/macOS sed). Used for .env edits only.
sed_inplace=(-i)
sed --version >/dev/null 2>&1 || sed_inplace=(-i '')

# Read one KEY= value from .env (no shell sourcing: values are untrusted text).
read_env_value() {
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | tail -n1
}

# Set KEY=value in .env, replacing an existing line or appending one.
set_env() {
  local key="$1" val="$2"
  [ -f .env ] || return 0
  if grep -qE "^${key}=" .env; then
    sed "${sed_inplace[@]}" "s|^${key}=.*|${key}=${val}|" .env
  else
    printf '%s=%s\n' "$key" "$val" >>.env
  fi
}

# Host-side port the server is published on. Precedence: shell env > .env > 8090.
# Exporting it keeps docker-compose (which also reads .env, but lets the shell
# win) and this script on the SAME port — the compose publish uses ${HUB_PORT}.
PORT="${HUB_PORT:-}"
[ -n "$PORT" ] || PORT="$(read_env_value HUB_PORT)"
PORT="${PORT:-8090}"
export HUB_PORT="$PORT"

# The host data dir, resolved the same way, so this script and compose agree on it.
DATA_DIR="${HUB_DATA_DIR:-}"
[ -n "$DATA_DIR" ] || DATA_DIR="$(read_env_value HUB_DATA_DIR)"
DATA_DIR="${DATA_DIR:-./data}"
export HUB_DATA_DIR="$DATA_DIR"

need_docker() {
  command -v docker >/dev/null 2>&1 \
    || die "Docker not found. Install it: https://docs.docker.com/engine/install/"
  docker compose version >/dev/null 2>&1 \
    || die "Docker Compose v2 not found (need the 'docker compose' plugin, not 'docker-compose')."
  docker info >/dev/null 2>&1 \
    || die "Cannot reach the Docker daemon. Start it (e.g. 'sudo systemctl start docker') or add your user to the 'docker' group."
}

port_busy() {
  # Best-effort probe for something already listening on $PORT. bash's /dev/tcp
  # is the portable first choice; external tools are fallbacks only. BusyBox
  # `lsof` (Alpine/NAS) ignores the -iTCP/-sTCP filters and exits 0 on a free
  # port, so it is never trusted.
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    return 0
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -q "[:.]$PORT "
    return
  fi
  if command -v lsof >/dev/null 2>&1 && ! lsof -v 2>&1 | grep -qi busybox; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
    return
  fi
  return 1  # can't tell → assume free, never block the install
}

# --url: the address the app should use. The app needs https for anything but
# localhost, and the server listens on this machine's loopback only, so a LAN
# http:// address would be unreachable and refused anyway. The https address is
# whatever a mesh or proxy serves the hub on; HUB_ORIGIN records it.
print_url() {
  local origin; origin="$(read_env_value HUB_ORIGIN)"; origin="${origin%%,*}"
  case "$origin" in
    https://*) printf '%s\n' "$origin"; return 0 ;;
  esac
  printf 'No https address configured yet (HUB_ORIGIN in .env is %s).\n' "${origin:-unset}"
  printf 'Give the server one first, e.g. on a Tailscale tailnet (tailnet-only, never funnel):\n'
  printf '  tailscale serve --bg --https=443 http://127.0.0.1:%s\n' "$PORT"
  printf 'then set HUB_ORIGIN=https://<that address> in .env and run ./install.sh --restart.\n'
  printf 'See docs/MESH.md.\n'
  return 1
}

probe_health() {
  # 0 = the server answered /api/healthz on the host port.
  if command -v curl >/dev/null 2>&1; then
    curl -fsS "http://127.0.0.1:${PORT}/api/healthz" >/dev/null 2>&1
    return
  fi
  # No curl on the host: ask the container itself. It ships Python and serves
  # this same endpoint for its own compose healthcheck. The in-container port is
  # always 8090 (the Dockerfile's CMD); only the host side varies.
  docker compose exec -T hub-api python -c \
    "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/api/healthz', timeout=3)" \
    >/dev/null 2>&1
}

wait_healthy() {
  say "Waiting for the server to become healthy…"
  local i
  for i in $(seq 1 45); do
    if probe_health; then
      ok "hub-api is up  →  http://127.0.0.1:${PORT}"
      return 0
    fi
    sleep 2
  done
  warn "Server did not report healthy in 90s. Recent logs:"
  docker compose logs --tail=40 || true
  die "Startup failed. Full logs: ./install.sh --logs"
}

random_hex() {
  if [ -r /dev/urandom ] && command -v od >/dev/null 2>&1; then
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; echo; return
  fi
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32; return; fi
  python3 -c 'import secrets; print(secrets.token_hex(32))'
}

# The key the assistant gateway's Hub adapter and this server share
# (/api/platform/hub/* one way, the gateway's events callback the other). The server
# reads it from a file only — /data/hub-platform/HUB_PLATFORM_KEY in the container —
# so mint one on first install. Never printed.
ensure_platform_key() {
  local dir="$1/hub-platform" file key
  file="$dir/HUB_PLATFORM_KEY"
  [ -s "$file" ] && return 0
  mkdir -p "$dir" && chmod 700 "$dir" || die "Could not create $dir"
  key="$(random_hex)"
  [ "${#key}" -ge 64 ] || die "Could not generate a platform key (needs /dev/urandom, openssl or python3)."
  ( umask 077 && printf '%s\n' "$key" > "$file" ) || die "Could not write $file"
  chmod 600 "$file"
  ok "Platform key created: $file (mode 600)"
}

# The shared key the hub and the hub-bridge sidecar authenticate with (the hub
# sends it as a bearer token; the bridge checks it). Minted beside the platform key
# so a later `docker compose --profile bridge up` finds it. Never printed. Only
# relevant when you run the bridge, but minting it always keeps enabling it a
# one-liner.
ensure_bridge_key() {
  local dir="$1/hub-bridge" file key
  file="$dir/HUB_BRIDGE_KEY"
  [ -s "$file" ] && return 0
  mkdir -p "$dir" && chmod 700 "$dir" || die "Could not create $dir"
  key="$(random_hex)"
  [ "${#key}" -ge 64 ] || die "Could not generate a bridge key (needs /dev/urandom, openssl or python3)."
  ( umask 077 && printf '%s\n' "$key" > "$file" ) || die "Could not write $file"
  chmod 600 "$file"
  ok "Bridge key created: $file (mode 600)"
}

prepare_data_dir() {
  # Create the bind-mount source and make it writable by the container user.
  # Docker would otherwise create a missing ./data as root:root 755, while the
  # container runs non-root — writes fail with EACCES later, after a "Done."
  local data_dir want_uid
  data_dir="$DATA_DIR"
  mkdir -p "$data_dir" || die "Could not create the data directory: $data_dir"
  ensure_platform_key "$data_dir"
  ensure_bridge_key "$data_dir"

  if [ "$(id -u)" -eq 0 ]; then
    want_uid="${HUB_UID:-1000}"
    chown -R "$want_uid" "$data_dir" \
      || die "Could not give $data_dir to uid ${want_uid} (chown failed)."
  else
    # A normal user cannot hand the dir to another uid, so make the container
    # uid match the directory owner instead. Persist it so later runs agree.
    want_uid="$(id -u)"
    if [ "${HUB_UID:-}" != "$want_uid" ]; then
      set_env HUB_UID "$want_uid"
      export HUB_UID="$want_uid"
    fi
  fi
  ok "Data directory ready: $data_dir (uid ${want_uid})"
}

# This host's IANA timezone name (Europe/Berlin), for HUB_TZ. Debian-likes keep it
# in /etc/timezone; elsewhere (macOS, Fedora, Arch) /etc/localtime is a symlink into
# a zoneinfo tree whose tail is the name. `date +%Z` is NOT a fallback: it prints an
# abbreviation (EDT, PDT) that no timezone database knows. Anything unusable -> UTC.
host_tz() {
  local tz="" target=""
  [ -r /etc/timezone ] && tz=$(head -n 1 /etc/timezone 2>/dev/null | tr -d '[:space:]')
  if [ -z "$tz" ] && [ -L /etc/localtime ]; then
    target=$(readlink /etc/localtime 2>/dev/null || true)
    case "$target" in
      */zoneinfo/*) tz="${target##*/zoneinfo/}" ;;
    esac
  fi
  tz="${tz#posix/}"; tz="${tz#right/}"
  case "$tz" in
    ""|/*|*..*|*[!A-Za-z0-9_+/-]*) tz="UTC" ;;
  esac
  printf '%s' "$tz"
}

write_env() {
  if [ -f .env ]; then ok "Using existing .env"; return 0; fi
  [ -f .env.example ] || die ".env.example is missing — is this a complete clone?"
  cp .env.example .env

  # Seed a sensible timezone so schedules/calendar read correctly.
  set_env HUB_TZ "$(host_tz)"

  chmod 600 .env
  ok "Created .env (mode 600)"
}

case "${1:-}" in
  -h|--help) usage ;;
  --url)     print_url; exit 0 ;;
  --stop)    need_docker; docker compose down; ok "hub-api stopped (your data is untouched)"; exit 0 ;;
  --logs)    need_docker; exec docker compose logs -f --tail=100 ;;
  --status)  need_docker; docker compose ps; exit 0 ;;
  --restart)
    # Recreate rather than `docker compose restart`: a restart keeps the environment
    # the container was created with, so .env edits (HUB_ORIGIN, HUB_ALLOWED_HOSTS…)
    # would silently not apply.
    need_docker; docker compose up -d --force-recreate; ok "hub-api recreated with the current .env"; exit 0 ;;
  --pair)
    # Mint an enrolment code locally, inside the running server. No browser and
    # no network: the code is generated over a unix socket in the data dir.
    need_docker
    docker compose exec -T hub-api python3 /opt/hub-api/pair_cli.py \
      || die "Could not mint a code. Is the hub running? Start it with ./install.sh"
    exit 0 ;;
  --uninstall)
    need_docker
    warn "This deletes the server AND all data under ${DATA_DIR}."
    printf 'Type "delete" to confirm: '
    read -r reply
    [ "$reply" = "delete" ] || die "Cancelled — nothing was deleted."
    docker compose down -v || true
    rm -rf "${DATA_DIR}"
    ok "Uninstalled. .env was kept (delete it yourself if you want a clean slate)."
    exit 0 ;;
  --update)
    need_docker
    say "Pulling the latest source…"
    git pull --ff-only || warn "git pull failed (dirty tree or no upstream) — continuing with local source."
    prepare_data_dir
    docker compose up -d --build
    wait_healthy
    ok "Updated and restarted"
    exit 0 ;;
  ""|--start) ;;
  *) die "Unknown option: $1 (try --help)" ;;
esac

# ---- install ---------------------------------------------------------------
say "Xavier installer"
echo "${DIM}A private AI hub you run yourself. No telemetry, nothing phones home.${RESET}"
echo

say "1/4  Checking prerequisites"
need_docker
if ! command -v curl >/dev/null 2>&1; then
  echo "${DIM}  (no curl on this host — using the container's built-in health probe)${RESET}"
fi
ok "Docker + Compose v2 ready"

say "2/4  Configuring"
if [ -f .env ]; then
  ok "Existing .env found"
else
  write_env
fi
# Keep the persisted port in step with what compose will actually publish.
set_env HUB_PORT "$PORT"

say "3/4  Building the server (first run takes a minute)"
prepare_data_dir
if port_busy; then
  warn "Port ${PORT} already has a listener — if this is not a previous Xavier install, the build will fail to bind. Set HUB_PORT to change it."
fi
docker compose up -d --build

say "4/4  Health check"
wait_healthy

cat <<EOF

$(ok "Done.")

  Running on:         http://127.0.0.1:${PORT}   (this machine only — it binds loopback)

  Next, give it an https address. The app needs https for anything but
  localhost, and nothing else can reach this server yet. On a Tailscale tailnet
  (tailnet-only; never use \`tailscale funnel\`, which is the public internet):

                      tailscale serve --bg --https=443 http://127.0.0.1:${PORT}
                      (with sudo on Linux)

                      or ./scripts/setup-mesh.sh, or see docs/MESH.md for
                      Headscale, WireGuard or a proxy of your own.

                      Then set HUB_ORIGIN=https://<that address> in .env and
                      run ./install.sh --restart: the server only answers to
                      hostnames it has been told about.

  Pair the app:       ./install.sh --pair  mints a one-time enrolment code on
                      this machine; enter it in the app (Config → Security →
                      Pair this iPhone) after pointing the app at the https
                      address. See docs/CONNECT-APP.md.

  Assistant:          the Hermes hub-platform plugin needs this server's key,
                      ${DATA_DIR}/hub-platform/HUB_PLATFORM_KEY — point the
                      plugin's HUB_PLATFORM_KEY_FILE at it (or copy it to
                      \$HERMES_HOME/hub-platform/HUB_PLATFORM_KEY).

  Privacy:            no telemetry, no analytics. Your data stays in
                      ${DATA_DIR} on this machine.
EOF
