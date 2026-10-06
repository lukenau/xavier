#!/usr/bin/env bash
# host/install.sh: install the Xavier host kit as three systemd units: a tmux server,
# ttyd behind the hub's /terminal, and hub-tmuxd behind the shell picker. Linux with
# systemd only; for macOS see the launchd section of host/README.md.
#
#   sudo host/install.sh               install or upgrade, then start the units
#   sudo host/install.sh --uninstall   stop and remove the units and installed programs
#   host/install.sh --render DIR       only write the rendered units and settings to DIR
#                                      (no root, nothing installed or started)
#
# Settings are environment variables, e.g. `sudo XAVIER_USER=alice host/install.sh`.
# host/README.md lists them all.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
MODE=install
OUT=""
case "${1:-}" in
  "") ;;
  --uninstall) MODE=uninstall ;;
  --render) MODE=render; OUT="${2:-}"; [ -n "$OUT" ] || { echo "--render needs a directory" >&2; exit 2; } ;;
  -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
  *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
esac

die() { echo "host/install.sh: $*" >&2; exit 1; }
say() { echo "==> $*"; }

# Every value is substituted into unit files with sed, so each is held to a character
# set that can break neither a unit line nor the sed expression.
is_path() { [[ "$1" =~ ^/[A-Za-z0-9._/+-]*$ ]] && [[ "$1/" != *"/../"* ]]; }
is_name() { [[ "$1" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; }
is_label() { [[ "$1" =~ ^[A-Za-z0-9_-]{1,32}$ ]]; }
is_list() { # separator, value: a non-empty list of paths
  local sep="$1" p parts
  IFS="$sep" read -r -a parts <<<"$2"
  [ "${#parts[@]}" -gt 0 ] || return 1
  for p in "${parts[@]}"; do is_path "$p" || return 1; done
}

RUN_DIR="${XAVIER_RUN_DIR:-/run/xavier}"
[[ "$RUN_DIR" =~ ^/run/[a-z0-9][a-z0-9_-]{0,31}$ ]] \
  || die "XAVIER_RUN_DIR must be /run/<name>: systemd creates and owns it"
RUN_NAME=${RUN_DIR#/run/}
TMUX_RUN_NAME="$RUN_NAME-tmux"
LIBEXEC="${XAVIER_LIBEXEC:-/usr/local/lib/xavier}"
ETC_DIR="${XAVIER_ETC_DIR:-/etc/xavier}"
UNIT_DIR="${XAVIER_UNIT_DIR:-/etc/systemd/system}"
SOCKET_GROUP="${XAVIER_SOCKET_GROUP:-xavier-hub}"
for v in LIBEXEC ETC_DIR UNIT_DIR; do is_path "${!v}" || die "$v must be a plain absolute path"; done
is_name "$SOCKET_GROUP" || die "XAVIER_SOCKET_GROUP must be a plain group name"
UNITS=(xavier-tmux xavier-ttyd xavier-tmuxd)

if [ "$MODE" = uninstall ]; then
  [ "$(id -u)" -eq 0 ] || die "run it with sudo"
  systemctl disable --now xavier-tmuxd.service xavier-ttyd.service xavier-tmux.service 2>/dev/null || true
  for u in "${UNITS[@]}"; do rm -f "$UNIT_DIR/$u.service"; done
  systemctl daemon-reload
  rm -rf "$LIBEXEC" "$RUN_DIR" "/run/$TMUX_RUN_NAME"
  say "removed the units, $LIBEXEC and the sockets."
  say "left in place: $ETC_DIR (your settings) and the $SOCKET_GROUP group."
  say "  sudo rm -r $ETC_DIR; sudo groupdel $SOCKET_GROUP"
  say "in the hub's .env, drop COMPOSE_FILE and XAVIER_HUB_GID, then ./install.sh --restart"
  exit 0
fi

USER_NAME="${XAVIER_USER:-${SUDO_USER:-}}"
[ -n "$USER_NAME" ] || die "set XAVIER_USER to the account the terminal and Claude Code run as"
is_name "$USER_NAME" || die "XAVIER_USER must be a plain user name"
[ "$USER_NAME" != root ] || die "refusing to serve a root shell over the web; pick a normal account"
PW=$(getent passwd "$USER_NAME") || die "no such user: $USER_NAME"
IFS=: read -r _ _ USER_UID USER_GID _ USER_HOME _ <<<"$PW"
[ "$USER_UID" != 0 ] || die "refusing uid 0"
USER_GROUP=$(getent group "$USER_GID" | cut -d: -f1)
is_name "$USER_GROUP" || die "cannot resolve the primary group of $USER_NAME"
is_path "$USER_HOME" || die "the home directory of $USER_NAME has characters this installer does not handle"
[ "$USER_GROUP" != "$SOCKET_GROUP" ] || die "XAVIER_SOCKET_GROUP must not be $USER_NAME's own group"

TTYD_SOCK_NAME="${XAVIER_TTYD_SOCKET_NAME:-ttyd.sock}"
TMUXD_SOCK_NAME="${XAVIER_TMUXD_SOCKET_NAME:-tmuxd.sock}"
# ttyd 1.7 binds a unix socket only when the --interface value ends in .sock or
# .socket; any other value is taken as a network interface and ttyd listens on TCP.
[[ "$TTYD_SOCK_NAME" =~ ^[a-z0-9][a-z0-9_-]{0,40}\.sock$ ]] \
  || die "XAVIER_TTYD_SOCKET_NAME must be a plain name ending in .sock (anything else makes ttyd listen on TCP)"
[[ "$TMUXD_SOCK_NAME" =~ ^[a-z0-9][a-z0-9_-]{0,40}\.sock$ ]] \
  || die "XAVIER_TMUXD_SOCKET_NAME must be a plain name ending in .sock"
[ "$TTYD_SOCK_NAME" != "$TMUXD_SOCK_NAME" ] || die "the two sockets need different names"
TMUX_SOCKET_NAME="${XAVIER_TMUX_SOCKET_NAME:-xavier}"
TERM_SESSION="${XAVIER_TERM_SESSION:-hub-term}"
is_label "$TMUX_SOCKET_NAME" || die "XAVIER_TMUX_SOCKET_NAME must be 1-32 letters, digits, _ or -"
is_label "$TERM_SESSION" || die "XAVIER_TERM_SESSION must be 1-32 letters, digits, _ or -"
[[ "$TERM_SESSION" != claude-* ]] || die "XAVIER_TERM_SESSION must not start with claude-"

TTYD_BIN="${XAVIER_TTYD_BIN:-$(command -v ttyd || echo /usr/bin/ttyd)}"
TMUX_BIN="${XAVIER_TMUX_BIN:-$(command -v tmux || echo /usr/bin/tmux)}"
PYTHON_BIN="${XAVIER_PYTHON:-$(command -v python3 || echo /usr/bin/python3)}"
CLAUDE_BIN="${XAVIER_CLAUDE_BIN:-$USER_HOME/.local/bin/claude}"
for v in TTYD_BIN TMUX_BIN PYTHON_BIN CLAUDE_BIN; do is_path "${!v}" || die "$v must be a plain absolute path"; done
CWD_ROOTS="${XAVIER_CWD_ROOTS:-$USER_HOME}"
is_list : "$CWD_ROOTS" || die "XAVIER_CWD_ROOTS must be a colon-separated list of absolute paths"
SHELL_PATH="${XAVIER_SHELL_PATH:-$USER_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin}"
is_list : "$SHELL_PATH" || die "XAVIER_SHELL_PATH must be a colon-separated list of absolute paths"
# Extra directories shells may write to besides the home directory (space-separated).
RW_PATHS="$USER_HOME"
if [ -n "${XAVIER_RW_PATHS:-}" ]; then
  is_list ' ' "$XAVIER_RW_PATHS" || die "XAVIER_RW_PATHS must be space-separated absolute paths"
  RW_PATHS="$USER_HOME $XAVIER_RW_PATHS"
fi

render() { # template -> stdout, failing on any placeholder left unfilled
  local out
  out=$(sed -e "s|@USER@|$USER_NAME|g" -e "s|@USER_GROUP@|$USER_GROUP|g" \
            -e "s|@SOCKET_GROUP@|$SOCKET_GROUP|g" -e "s|@HOME@|$USER_HOME|g" \
            -e "s|@RW_PATHS@|$RW_PATHS|g" -e "s|@RUN_NAME@|$RUN_NAME|g" \
            -e "s|@TMUX_RUN_NAME@|$TMUX_RUN_NAME|g" -e "s|@TTYD_SOCK_NAME@|$TTYD_SOCK_NAME|g" \
            -e "s|@TMUXD_SOCK_NAME@|$TMUXD_SOCK_NAME|g" -e "s|@TMUX_SOCKET_NAME@|$TMUX_SOCKET_NAME|g" \
            -e "s|@TERM_SESSION@|$TERM_SESSION|g" -e "s|@LIBEXEC@|$LIBEXEC|g" \
            -e "s|@ETC_DIR@|$ETC_DIR|g" -e "s|@TTYD_BIN@|$TTYD_BIN|g" \
            -e "s|@TMUX_BIN@|$TMUX_BIN|g" -e "s|@PYTHON_BIN@|$PYTHON_BIN|g" \
            -e "s|@CLAUDE_BIN@|$CLAUDE_BIN|g" -e "s|@CWD_ROOTS@|$CWD_ROOTS|g" \
            -e "s|@SHELL_PATH@|$SHELL_PATH|g" "$1")
  if grep -qE '@[A-Z_]+@' <<<"$out"; then die "unfilled placeholder in $1"; fi
  printf '%s\n' "$out"
}

render_all() { # directory
  render "$HERE/terminal/xavier-tmux.service.in" > "$1/xavier-tmux.service"
  render "$HERE/terminal/xavier-ttyd.service.in" > "$1/xavier-ttyd.service"
  render "$HERE/hub-tmuxd/xavier-tmuxd.service.in" > "$1/xavier-tmuxd.service"
  render "$HERE/hub-tmuxd/tmuxd.conf.in" > "$1/tmuxd.conf"
}

if [ "$MODE" = render ]; then
  mkdir -p "$OUT"
  render_all "$OUT"
  say "rendered into $OUT: xavier-tmux.service xavier-ttyd.service xavier-tmuxd.service tmuxd.conf"
  exit 0
fi

[ "$(id -u)" -eq 0 ] || die "run it with sudo (or use --render DIR to only look)"
[ "$(uname -s)" = Linux ] || die "Linux with systemd only; for macOS see host/README.md"
command -v systemctl >/dev/null || die "systemd not found"
[ -x "$TTYD_BIN" ] || die "ttyd not found at $TTYD_BIN (Debian/Ubuntu: apt install ttyd), or set XAVIER_TTYD_BIN"
[ -x "$TMUX_BIN" ] || die "tmux not found at $TMUX_BIN (apt install tmux), or set XAVIER_TMUX_BIN"
[ -x "$PYTHON_BIN" ] || die "python3 not found, or set XAVIER_PYTHON"
"$PYTHON_BIN" -c 'import sys; sys.exit(sys.version_info < (3, 9))' || die "hub-tmuxd needs Python 3.9 or newer"
read -r TMUX_MAJOR TMUX_MINOR < <("$TMUX_BIN" -V | sed -n 's/^tmux \([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2/p') || true
if [ -n "${TMUX_MAJOR:-}" ] && { [ "$TMUX_MAJOR" -lt 3 ] || { [ "$TMUX_MAJOR" -eq 3 ] && [ "$TMUX_MINOR" -lt 2 ]; }; }; then
  die "tmux 3.2 or newer is needed (the server runs with -D); found $("$TMUX_BIN" -V)"
fi
[ -x "$CLAUDE_BIN" ] || say "note: $CLAUDE_BIN is not there yet; spawns fail until Claude Code is installed (or set XAVIER_CLAUDE_BIN in $ETC_DIR/tmuxd.conf)"

if ! getent group "$SOCKET_GROUP" >/dev/null; then
  groupadd --system "$SOCKET_GROUP"
  say "created group $SOCKET_GROUP"
fi
SOCKET_GID=$(getent group "$SOCKET_GROUP" | cut -d: -f3)
MEMBERS=$(getent group "$SOCKET_GROUP" | cut -d: -f4)
[ -z "$MEMBERS" ] || say "WARNING: $MEMBERS can open the terminal socket (members of $SOCKET_GROUP); only the hub should"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
render_all "$TMP"
install -d -m 0755 "$LIBEXEC" "$ETC_DIR"
install -m 0755 "$HERE/hub-tmuxd/tmuxd.py" "$LIBEXEC/tmuxd.py"
install -m 0755 "$HERE/terminal/xavier-term" "$LIBEXEC/xavier-term"
if [ -e "$ETC_DIR/tmuxd.conf" ]; then
  install -m 0644 "$TMP/tmuxd.conf" "$ETC_DIR/tmuxd.conf.new"
  say "kept your $ETC_DIR/tmuxd.conf; this version's defaults are in tmuxd.conf.new"
else
  install -m 0644 "$TMP/tmuxd.conf" "$ETC_DIR/tmuxd.conf"
fi
for u in "${UNITS[@]}"; do install -m 0644 "$TMP/$u.service" "$UNIT_DIR/$u.service"; done

systemctl daemon-reload
systemctl enable "${UNITS[@]/%/.service}"
# Start, never restart, the tmux server: restarting it ends every shell. ttyd and
# hub-tmuxd are only its clients and pick up an upgrade with a restart.
systemctl start xavier-tmux.service
systemctl restart xavier-ttyd.service xavier-tmuxd.service

for _ in $(seq 1 20); do
  [ -S "$RUN_DIR/$TTYD_SOCK_NAME" ] && [ -S "$RUN_DIR/$TMUXD_SOCK_NAME" ] && break
  sleep 0.25
done
for f in "$RUN_DIR" "$RUN_DIR/$TTYD_SOCK_NAME" "$RUN_DIR/$TMUXD_SOCK_NAME"; do
  [ -e "$f" ] && say "$(stat -c '%A %U:%G %n' "$f")" || say "MISSING: $f (journalctl -u xavier-ttyd -u xavier-tmuxd)"
done

cat <<EOF

Installed. To connect the hub container, add to the .env next to docker-compose.yml:

  COMPOSE_FILE=docker-compose.yml:host/compose.host.yml
  XAVIER_HUB_GID=$SOCKET_GID
EOF
[ "$RUN_DIR" = /run/xavier ] || echo "  XAVIER_RUN_DIR=$RUN_DIR"
[ "$TTYD_SOCK_NAME" = ttyd.sock ] || echo "  XAVIER_TTYD_SOCKET_NAME=$TTYD_SOCK_NAME"
[ "$TMUXD_SOCK_NAME" = tmuxd.sock ] || echo "  XAVIER_TMUXD_SOCKET_NAME=$TMUXD_SOCK_NAME"
cat <<EOF

then recreate it with ./install.sh --restart, and run the checks under "Verify" in
host/README.md. hub-tmuxd settings: $ETC_DIR/tmuxd.conf
EOF
