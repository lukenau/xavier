# Host kit: the terminal and Claude Code shells

The app's **Terminal** and its **Claude Code shell picker** need two programs on the
machine the hub runs on. The hub (`server/`) only proxies to them:

- **ttyd** serves a shell to the hub's `/terminal` proxy, over a unix socket.
- **hub-tmuxd** (`hub-tmuxd/tmuxd.py`) lists, starts, resumes and stops Claude Code
  sessions in tmux, for `/api/tmux/*` and the `tmux.spawn` / `tmux.kill` writes.

Both are clients of a third piece, a private tmux server that every shell and every
Claude Code session runs in. Restarting ttyd or hub-tmuxd therefore never ends a shell.

```
phone ──Face ID──▶ hub (Docker) ──/run/xavier/ttyd.sock──▶ ttyd ──┐
                              └──/run/xavier/tmuxd.sock─▶ hub-tmuxd ┴─▶ tmux -L xavier
                                                                      (your shells, claude)
```

## What you are installing

**A real, writable shell on your machine, as your user, behind Face ID.** Read this
before you install it.

- Whoever passes the hub's terminal unlock (Face ID on a phone you paired, or one of
  your passkeys) gets that shell. So does **anything that can open the sockets**: they
  have no login of their own. The kit keeps them in a directory only you and the hub's
  group can enter.
- The shell can do whatever your user can: read your SSH keys, cloud credentials and
  Claude Code login, change your shell profile, reach the network. If your user is in
  the `docker` group, that is root. The units block `sudo` (see
  [what the units protect](#what-the-units-do-and-do-not-protect)).
- The hub is the gate. Code running inside the hub container can open both sockets by
  design, so a compromised hub is a shell on this machine. Keep the hub on loopback and
  a private mesh ([SECURITY.md](../SECURITY.md)).
- Claude Code sessions started from the app run **without** permission bypass and
  without remote control. Both are opt-in (`tmuxd.conf`, below).
- Never mount `/run/xavier` (or your home directory) into another container, an
  agent's least of all, and never add anyone to the `xavier-hub` group. Either one
  hands out the shell without Face ID.

## Install (Linux, systemd)

Needs ttyd 1.6 or newer, tmux 3.2 or newer, Python 3.9 or newer, and Claude Code
installed for the user the shells run as (`claude` on that user's PATH, by default
`~/.local/bin/claude`).

```sh
sudo apt install ttyd tmux        # Debian/Ubuntu; any package manager will do
sudo host/install.sh              # as yourself via sudo: the shells run as you
```

It creates the `xavier-hub` group, copies `tmuxd.py` and `xavier-term` to
`/usr/local/lib/xavier/`, writes `/etc/xavier/tmuxd.conf`, installs and starts three
units, and prints the lines to add to the hub's `.env`. To see exactly what it would
write without installing anything:
`XAVIER_USER=$USER host/install.sh --render /tmp/xavier-units`.

| Unit | Runs | Socket |
|---|---|---|
| `xavier-tmux` | `tmux -L xavier -D`, the server the shells live in | `/run/xavier-tmux/` (0700, yours only) |
| `xavier-ttyd` | `ttyd --interface /run/xavier/ttyd.sock … xavier-term` | `ttyd.sock` 0660 |
| `xavier-tmuxd` | `python3 tmuxd.py` | `tmuxd.sock` 0660 |

`/run/xavier` is 0750, owned by you and the `xavier-hub` group. Re-running
`install.sh` upgrades in place: it restarts ttyd and hub-tmuxd, never the tmux server,
and keeps your `tmuxd.conf` (the new defaults land in `tmuxd.conf.new`).

Install-time settings, as environment variables (`sudo XAVIER_USER=alice host/install.sh`):

| Variable | Default | |
|---|---|---|
| `XAVIER_USER` | the user who ran sudo | account the shells and Claude Code run as; never root |
| `XAVIER_SOCKET_GROUP` | `xavier-hub` | the group the hub container joins |
| `XAVIER_RUN_DIR` | `/run/xavier` | socket directory; must be `/run/<name>` |
| `XAVIER_TTYD_SOCKET_NAME` | `ttyd.sock` | must end in `.sock`: ttyd listens on TCP for any other name |
| `XAVIER_TMUXD_SOCKET_NAME` | `tmuxd.sock` | |
| `XAVIER_TMUX_SOCKET_NAME` | `xavier` | name (`tmux -L`) of the kit's tmux server |
| `XAVIER_TERM_SESSION` | `hub-term` | the terminal's tmux session; hub-tmuxd never stops it |
| `XAVIER_SHELL_PATH` | `~/.local/bin:/usr/local/bin:/usr/bin:/bin` | `PATH` of every shell and session |
| `XAVIER_RW_PATHS` | none | directories besides your home that shells may write (space-separated) |
| `XAVIER_CLAUDE_BIN`, `XAVIER_CWD_ROOTS` | `~/.local/bin/claude`, your home | written into `tmuxd.conf` |
| `XAVIER_TTYD_BIN`, `XAVIER_TMUX_BIN`, `XAVIER_PYTHON` | found on `PATH` | |

## Connect the hub

### Hub in Docker (the default)

Add the lines `install.sh` printed to the `.env` next to `docker-compose.yml`, then
recreate the container:

```ini
COMPOSE_FILE=docker-compose.yml:host/compose.host.yml
XAVIER_HUB_GID=<gid of xavier-hub, printed by host/install.sh; getent group xavier-hub>
```

```sh
./install.sh --restart
```

[`compose.host.yml`](compose.host.yml) bind-mounts `/run/xavier` into the container
read-only (it can connect to the sockets, not replace them), adds the group to the
container's process by number, and sets `HUB_TTYD_SOCK=/run/xavier/ttyd.sock` and
`HUB_TMUXD_SOCK=/run/xavier/tmuxd.sock`.

**User and group ids.** The container runs as `HUB_UID` (the root `install.sh` sets it
to your uid when you install without sudo). If that is the shell user's uid, the
container reaches the sockets as their owner; otherwise through the group, which is
why `group_add` uses the host's numeric gid. No group with that number has to exist in
the image, and `HUB_UID` does not change.

### Hub outside Docker

Add the hub's user to the group (`sudo usermod -aG xavier-hub <hub user>`, then restart
the hub) and set `HUB_TTYD_SOCK=/run/xavier/ttyd.sock` and
`HUB_TMUXD_SOCK=/run/xavier/tmuxd.sock` in its environment.

## Verify

```sh
ls -ld /run/xavier /run/xavier/*.sock
#   drwxr-x--- you xavier-hub  /run/xavier
#   srw-rw---- you xavier-hub  /run/xavier/ttyd.sock and tmuxd.sock
sudo -u nobody ls /run/xavier          # must fail: Permission denied
curl -s --unix-socket /run/xavier/tmuxd.sock http://localhost/healthz      # {"ok": true}
curl -s -o /dev/null -w '%{http_code}\n' --unix-socket /run/xavier/ttyd.sock http://localhost/terminal/   # 200
sudo ss -ltnp | grep -E 'ttyd|tmuxd' || echo "nothing on TCP"
docker compose exec hub-api python -c "import socket; s = socket.socket(socket.AF_UNIX); s.connect('/run/xavier/tmuxd.sock'); print('hub can connect')"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8090/terminal/   # 401 or 412: locked
```

Then in the app: unlock the Terminal with Face ID, open the shell picker, start a
shell. `hub-term` (the terminal itself) shows as protected. From an SSH login you can
reach the same sessions with `TMUX_TMPDIR=/run/xavier-tmux tmux -L xavier ls`.

## hub-tmuxd settings

`/etc/xavier/tmuxd.conf`, then `sudo systemctl restart xavier-tmuxd`. Every value is
checked at startup; hub-tmuxd refuses to start on anything it does not understand.

| Variable | Default | |
|---|---|---|
| `XAVIER_CLAUDE_BIN` | `~/.local/bin/claude` | the only program a spawn runs. Refused if it or its directory is world-writable |
| `XAVIER_CWD_ROOTS` | your home | colon-separated. A requested directory is resolved (symlinks, `..`) and must sit inside one; world-writable ones are refused. A resumed session starts in the directory its transcript was recorded in, under the same rule |
| `XAVIER_CLAUDE_REMOTE_CONTROL` | `0` | `1` adds `--remote-control`: the session also appears in the Claude app, drivable from your Claude account |
| `XAVIER_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS` | `0` | `1` adds `--dangerously-skip-permissions` to every spawn: Claude Code then runs every tool call unasked |
| `XAVIER_TMUX_PREFIX` | `claude-` | sessions hub-tmuxd may start and stop. The hub only accepts `claude-*` |
| `XAVIER_TMUX_PROTECTED` | none | comma list of `claude-*` sessions never to stop |
| `XAVIER_TMUXD_MAX_SESSIONS` | `8` | |
| `XAVIER_TMUXD_HISTORY_LIMIT` | `30` | past sessions offered for resume |
| `XAVIER_TMUXD_HISTORY_SHOW_CWD` | `0` | `1` also sends each session's directory (absolute path) to the app |
| `XAVIER_HOST_LABEL` | `This machine` | |
| `XAVIER_SOCKET_MODE` | `0660` | `0600` when only the same user connects (a hub outside Docker, as you) |

What hub-tmuxd does, and refuses, on each request:

- **Spawn** runs `tmux new-session -d -s claude-<slug> -c <dir> -- <XAVIER_CLAUDE_BIN>
  [--resume <id>]` as an argument list: no shell. Names must match
  `[a-z0-9][a-z0-9-]{0,30}`, resume ids must be UUIDs, directories `/[A-Za-z0-9_./-]*`.
  That strictness is load-bearing: tmux treats an argument ending in `;` as the start
  of another tmux command, and expands `#(...)` in session names and directories by
  running a shell. A transcript already open in a running Claude Code is not resumed
  twice.
- **Kill** stops only `claude-*` sessions that nobody is attached to and that are not
  protected, by exact name.
- **History** reads `~/.claude/projects/*/<id>.jsonl` (regular files only, never
  symlinks) and `~/.claude/sessions/<pid>.json`, and returns ids, titles, times and a
  running flag. Never prompt or message text; the directory only if you opt in.
- **Environment.** tmux, and so every session, gets only `HOME`, `USER`, `LOGNAME`,
  `SHELL`, `PATH`, `LANG`, `LC_*`, `TZ`, `TERM`, `TMUX_TMPDIR` and `CLAUDE_CONFIG_DIR`
  from hub-tmuxd. Under systemd the sessions' environment is the `xavier-tmux` unit's,
  which holds no secrets unless you add them.
- It talks only to its own tmux server (`tmux -L xavier`), never your personal one.

## What the units do and do not protect

| | `xavier-tmux` (the shells) | `xavier-ttyd`, `xavier-tmuxd` |
|---|---|---|
| `NoNewPrivileges` | yes: no sudo, su or setuid programs | yes |
| `ProtectSystem=strict` | the OS is read-only; writable are your home, `XAVIER_RW_PATHS` and a private `/tmp` | the socket directory only |
| `ProtectHome` | no, the home directory is the point | read-only |
| `PrivateTmp` | yes: the terminal's `/tmp` is not your SSH session's | yes |
| Network | unrestricted | no IP sockets (`RestrictAddressFamilies`), and `IPAddressDeny=any` |

None of this limits what your user can do inside the home directory, which is where the
valuable things are. A writable shell is a writable shell. If you want `sudo` in the web
terminal, add a drop-in with `NoNewPrivileges=no` to `xavier-tmux` and know that you are
then serving a root-capable shell behind Face ID. `systemctl restart xavier-tmux` ends
every shell; the other two restart freely.

## macOS (launchd)

On a Mac the hub usually runs in Docker Desktop, which cannot carry a container's
connection to a unix socket on the Mac (its file sharing passes files, not sockets).
So the terminal needs the hub running outside Docker, as your own user, and this
repository does not ship a tested setup for that yet: such a run has to point every
setting that defaults under `/data` somewhere real, the way `demo/start-demo.sh`
does. Check your container runtime's documentation if it claims socket passthrough.
The two daemons themselves install like this:

```sh
brew install ttyd tmux
mkdir -p ~/.xavier/run && chmod 700 ~/.xavier ~/.xavier/run
for f in host/terminal/local.xavier.ttyd.plist.in host/hub-tmuxd/local.xavier.tmuxd.plist.in; do
  sed -e "s|@HOME@|$HOME|g" -e "s|@REPO@|$PWD|g" -e "s|@BREW@|$(brew --prefix)|g" "$f" \
    > ~/Library/LaunchAgents/"$(basename "${f%.in}")"
done
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.xavier.ttyd.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.xavier.tmuxd.plist
```

Give the hub `HUB_TTYD_SOCK=$HOME/.xavier/run/ttyd.sock` and
`HUB_TMUXD_SOCK=$HOME/.xavier/run/tmuxd.sock`. Both sockets are owner-only, so only
processes running as you can connect. launchd has no sandbox like the systemd units':
the shells have your full rights. macOS privacy controls apply to what launchd starts,
so a project under `~/Documents`, `~/Desktop` or `~/Downloads` may be unreadable from
these sessions, and so may the plists' `@REPO@` if your checkout lives there. Remove
with `launchctl bootout gui/$(id -u)/local.xavier.ttyd` (and `.tmuxd`), then delete the
two plists and `~/.xavier`.

## Uninstall

```sh
sudo host/install.sh --uninstall      # stops and removes the units, programs and sockets
```

Then delete `COMPOSE_FILE` and `XAVIER_HUB_GID` from the hub's `.env` and run
`./install.sh --restart`. Your settings (`/etc/xavier`) and the `xavier-hub` group stay
until you remove them: `sudo rm -r /etc/xavier && sudo groupdel xavier-hub`.

## Troubleshooting

- **503 "terminal backend not configured"**: `HUB_TTYD_SOCK` is empty in the
  container, so the override is not active. Check `COMPOSE_FILE` in `.env`, then
  `./install.sh --restart`.
- **502 "terminal backend unreachable: Permission denied"**: the container is not in
  the group. `XAVIER_HUB_GID` must be the number `getent group xavier-hub` prints, and
  the container must be recreated after you set it.
- **hub-tmuxd does not start**: `journalctl -u xavier-tmuxd`. It names the setting it
  refused, or the socket directory's mode if anything but you and the group can reach it.
- **ttyd does not start, "Address family not supported"**: some ttyd build needs an
  address family the unit blocks. Add a drop-in that resets `RestrictAddressFamilies=`
  for `xavier-ttyd` (`IPAddressDeny=any` still keeps it off the network), and please
  report the ttyd version.
- **Development**: `python3 -m unittest discover -s host/hub-tmuxd -p 'test_*.py'` and
  `python3 -m unittest discover -s host -p 'test_*.py'`. The live tests start a private
  tmux server in a temporary directory and never touch yours.
