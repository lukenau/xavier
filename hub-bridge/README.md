# hub-bridge

A small, authenticated helper that runs a **fixed, allowlisted** set of Hermes
CLI commands on the hub's behalf.

## What it does

A few hub panels — Config, Cron, Skills, Plugins, MCP, Memory, Doctor, Spend and
the device-code Connectors login — need data that only the `hermes` CLI can
produce. In the usual deployment that CLI lives inside the agent's container. The
hub server runs non-root with no privileged access, so instead of handing it a
docker socket it POSTs a command here; this sidecar holds the privilege, runs one
allowlisted command, and returns the output.

The hub reaches it at `HUB_BRIDGE_URL` and calls:

| Endpoint | Method | Purpose |
|---|---|---|
| `/run` | POST | a **read** command (`config show`, `cron list`, `doctor`, `kanban …`, `sessions list`, `skills list`, `plugins list`, `mcp list`, `auth …`, `memory status`, `pairing list`) |
| `/run-write` | POST | a **write** command (`config set`, `cron create/edit/pause/resume/run/remove`, `pairing approve/revoke`, `gateway restart/stop`) |
| `/spend`, `/config-raw`, `/cron-logs`, `/cron-costs` | POST/GET | fixed read-only scripts over the agent's `state.db` / `config.yaml` / cron archive |
| `/oauth-start`, `/oauth-status` | POST/GET | drive a device-code login for a small provider allowlist |
| `/healthz` | GET | unauthenticated liveness |

## The risk, plainly

In the default **docker** exec mode this process runs `docker exec` into the
agent container, which needs `/var/run/docker.sock`. **The docker socket is
root-equivalent on the host**: anyone who can use it can start a privileged
container and take over the machine. Treat this sidecar as a privileged component.

What keeps that privilege behind a narrow door:

- **A shared key on every endpoint** (except `/healthz`), compared in constant
  time. With no key configured the bridge **fails closed** — every request 503s.
- **A strict, data-driven allowlist.** Only the exact subcommands above, each with
  per-argument regex checks. Reads and writes are served by **different**
  endpoints and never overlap. Values that start with `-` are rejected (no option
  injection); `config set` additionally refuses secret-shaped and `UPPER_SNAKE`
  keys so a direct caller can't write a credential or an env var.
- **No shell** on the `/run` and `/run-write` path: `argv` is a Python list handed
  straight to `hermes`. The fixed scripts take their few inputs as separate argv
  tokens. The exec template is fixed, so an argv can only ever run `hermes …` — it
  can't become a `docker run` or a different program.
- **Run it on a private network and never publish its port.** The compose profile
  below does exactly that.

This is the *second* gate. The hub already verifies a Face ID (WebAuthn /
Secure-Enclave) signature before it calls `/run-write`. The key + allowlist here
mean that even a caller who reaches the port directly still can't do more than the
allowlist permits — and can't do even that without the key.

## Install

### Option A — docker, as a sidecar (opt-in compose profile)

The bridge is **not** in the default install. Enable it explicitly:

```bash
# 1) generate the shared key (install.sh does this for you on first run):
#    it lands at <HUB_DATA_DIR>/hub-bridge/HUB_BRIDGE_KEY, mode 600
./install.sh

# 2) point the hub at the bridge and name the agent container, in .env:
HUB_BRIDGE_URL=http://hub-bridge:8091
HERMES_CONTAINER=hermes          # your Hermes gateway container name

# 3) bring it up WITH the bridge profile (adds the docker-socket sidecar):
docker compose --profile bridge up -d
```

The compose service mounts `/var/run/docker.sock`, joins a private network with
the hub, **publishes no host port**, and runs as root because the socket needs it.

### Option B — local, no docker socket

If Hermes is installed directly on a machine rather than in a container, run
`bridge.py` on that machine instead, with no docker at all:

```bash
BRIDGE_EXEC=local \
HERMES_DATA_DIR=/path/to/your/hermes/home \
HUB_BRIDGE_KEY_FILE=/path/to/xavier/data/hub-bridge/HUB_BRIDGE_KEY \
BRIDGE_HOST=<an address only the hub can reach> \
python3 hub-bridge/bridge.py
```

`HERMES_DATA_DIR` holds `state.db`, `config.yaml` and `cron/`. In local mode the
bridge runs `hermes` / `python3` / `sh` directly as the user who starts it, so
start it as the user Hermes runs as, never as root. It listens on every
interface unless you set `BRIDGE_HOST`. Point the hub's `HUB_BRIDGE_URL` at it.
The Compose profile above is docker mode only: it always mounts the socket.

## The key

- A random secret in `HUB_BRIDGE_KEY_FILE` (default `/keys/HUB_BRIDGE_KEY` in the
  container), mode 0600, created by `install.sh` next to the hub-platform key.
- The hub reads the same file (its own `HUB_BRIDGE_KEY_FILE`) and sends it as
  `Authorization: Bearer <key>` on every call.
- Rotate by replacing the file on both sides; the bridge re-reads it per request.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HUB_BRIDGE_KEY_FILE` | `/keys/HUB_BRIDGE_KEY` | shared bearer key file (0600) |
| `BRIDGE_EXEC` | `docker` | `docker` (exec into a container) or `local` |
| `HERMES_CONTAINER` | `hermes` | container name for docker mode |
| `HERMES_EXEC_USER` | *(unset)* | optional `uid:gid` for `docker exec -u` |
| `HERMES_DATA_DIR` | `/opt/data` | where `state.db`, `config.yaml`, `cron/` are visible to the exec target |
| `BRIDGE_TZ` | `UTC` | IANA tz the cost buckets group in |
| `BRIDGE_HOST` | `0.0.0.0` | listen address; set it in local mode, where every interface is not private |
| `BRIDGE_PORT` | `8091` | listen port (never publish it to the host) |
| `BRIDGE_EXEC_TIMEOUT_S` | `30` | per-command timeout |
| `BRIDGE_MAX_OUTPUT_BYTES` | `1000000` | cap on `/run` stdout/stderr |
| `BRIDGE_KANBAN_TTL_S` | `15` | how long a kanban board read is cached (seconds) |

## Verify

```bash
# liveness (no key):
curl -s http://hub-bridge:8091/healthz            # {"ok": true}

# without the key, everything else is refused:
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://hub-bridge:8091/run \
  -H 'Content-Type: application/json' -d '{"argv":["cron","list"]}'   # 401

# with the key, an allowlisted read runs; a non-allowlisted one is 403:
KEY=$(cat <HUB_DATA_DIR>/hub-bridge/HUB_BRIDGE_KEY)
curl -s -X POST http://hub-bridge:8091/run \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"argv":["doctor"]}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://hub-bridge:8091/run \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"argv":["bash","-c","id"]}'                                     # 403
```

Tests: `python3 -m unittest -v` in this directory (stdlib only; no network, no
real exec).

## Known limits

- **The docker socket is root-equivalent.** The key and allowlist reduce what a
  caller can *ask for*; they do not change the fact that this process can control
  the Docker daemon. Keep it off any shared or public network.
- **The allowlist trusts the `hermes` CLI's own argument parsing** for anything it
  passes through (a cron prompt, a config value). It guarantees *which* subcommand
  runs and blocks shell metacharacters and option injection; it does not sandbox
  what a legitimately-allowed command then does (e.g. a `cron create` prompt is
  arbitrary agent instruction — that is a hub-gated, Face-ID-protected action by
  design).
- **`/config-raw` masking is by key name.** `/config-raw` redacts any config leaf
  whose dotted key matches `key|token|secret|password|hash` (the same rule the hub
  applies, so the two agree). A genuine secret stored under a key that matches none
  of those words would not be masked. The authentication above is the real control
  here: an unauthenticated peer gets nothing at all.
- **`/healthz` is unauthenticated** by design, so the compose healthcheck needs no
  key. It returns only `{"ok": true}`.
- **Single shared key, no per-caller identity.** Anyone holding the key is the
  hub. Treat the key like the hub-platform key.
