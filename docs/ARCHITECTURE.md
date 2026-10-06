# Architecture

What the pieces are, how they talk, and why some choices are the way they are.

![Architecture: the app talks to your server, which hands the work to the agent, which calls the model provider you chose](../assets/img/architecture.png)

---

## The big picture

Xavier is a self-hosted client/server pair, plus a plugin for the agent that
does the thinking:

```
┌──────────────────┐   HTTPS over your mesh   ┌──────────────────┐   HTTP    ┌──────────────────────┐
│  Xavier app      │ ───────────────────────▶ │  hub-api         │ ────────▶ │  Hermes Agent        │
│  (iOS)           │ ◀─────────────────────── │  (this repo,     │ ◀──────── │  + hub-platform      │
└──────────────────┘    JSON, WebSockets      │   FastAPI)       │  plugin   │    plugin (this repo)│
                                              └──────────────────┘           └──────────────────────┘
                                                │ files, unix sockets,                │
                                                │ hub-bridge sidecar                  ▼
                                                ▼                              your model provider
                                      data dir, ttyd, hub-tmuxd
```

- **`app/`**: the Xavier client, built with Expo / React Native (Expo SDK 57,
  React Native 0.86, TypeScript, expo-router). iOS is the platform it targets;
  the web and Android targets build from the same tree for development only.
- **`server/`**: **hub-api**, a FastAPI (Python) service. Runs in Docker, listens
  on `8090` inside the container, speaks JSON over HTTP(S) plus WebSockets for
  chat and the terminal.
- **`hermes-plugin/hub-platform/`**: the plugin you install into Hermes. It
  carries chat, approvals and automation runs between Hermes and the hub.
- **`hub-bridge/`**: an opt-in, authenticated sidecar that runs a fixed,
  allowlisted set of Hermes CLI commands for the config/cron/skills/plugins/MCP/
  memory/doctor/spend panels. It, not the hub, holds the privileged access
  (a docker socket in the default mode) so the hub stays unprivileged. The default
  install does not start it; see [hub-bridge/README.md](../hub-bridge/README.md).

There is no Xavier cloud service in between. The app talks directly to the
server you installed, over your own mesh. Data leaves only to services you turn
on: your model provider (through Hermes), Expo and Apple for push notifications,
EAS Update for over-the-air update checks, and any hosted service you connect;
see [PRIVACY.md](PRIVACY.md).

## Server internals

| Piece | What it does |
|---|---|
| `app.py` | The FastAPI app: the read endpoints, the write gate (`/api/action/*`), the terminal proxy, the brief, decisions, push registration, iMessage drafts, and the request middleware. |
| `chat/` | Chat threads and messages (`store.py`, `routes.py`), the Face ID chat session (`session.py`), the live socket (`ws.py`), approvals (`approval.py`), automations, push (`notify.py`), and the routes the Hermes plugin calls (`platform.py`). |
| `webauthn_gate.py` / `devicekeys.py` | Proof of presence for sensitive routes: a WebAuthn passkey, or the phone's Secure Enclave device-key signature, plus enrolment codes. |
| `pair_local.py` / `pair_cli.py` | The local unix socket behind `./install.sh --pair`. |
| `files.py` | Read-only multi-root file browser (`/api/files/{roots,browse,read}`), traversal-guarded, size-capped. |
| `hub_calendar.py` | The calendar read surface and sync request. |
| `ha_actions.py` | A Home Assistant challenge and dry-run apply. Not wired to Home Assistant yet: a live apply returns 501. |
| `Dockerfile` | `python:3.12-slim`, `requirements.txt` only, non-root user (uid = `HUB_UID`, default 1000), uvicorn on `0.0.0.0:8090` inside the container. |

### API surface

- **Liveness**: `GET /api/healthz` → `200`, `{"status":"ok"}`.
- **Reads** (`GET`): health, agents, sessions and transcripts, config, cron,
  costs, calendar, the brief, decisions, files, pages and more. **Most carry no
  authentication**: anyone who can reach the server can read them. Chat and the
  terminal (including the tmux lists) are the exceptions; they need a Face ID
  session cookie. The full list, with what each reveals, is in
  [SECURITY.md](../SECURITY.md).
- **Writes** (`POST`): only paths on an explicit allowlist are accepted; any
  other `POST`, and any other method, gets a 405. Most allowlisted writes need a
  fresh device-key or passkey signature bound to the exact payload. A few are
  gated differently by design (the plugin's shared key, per-item brief tokens,
  the one-time enrolment code) or not at all (a calendar sync request, starting a
  connector login); SECURITY.md lists them.
- **WebSockets**: the chat socket (`/api/chat/ws`) and the terminal
  (`/terminal/ws`), each behind its own session cookie.

## Runtime shape

- **Docker Compose**, one service, `hub-api`, built from `server/`.
- **Publishing**: `${HUB_BIND:-127.0.0.1}:${HUB_PORT:-8090}:8090` on the host →
  `8090` in the container. Default `127.0.0.1` means loopback-only; exposure is
  the host publish's job, never the container's.
- **Data**: `HUB_DATA_DIR` (default `./data`) is bind-mounted to `/data` in the
  container. The database, uploads, and keys live there and survive rebuilds,
  restarts, and `--update`s.
- **Restart policy**: `unless-stopped`; the container comes back with the
  Docker daemon after a reboot.
- **Logs**: json-file driver, capped at 10 MB × 3 files.
- **Healthcheck**: the compose file polls `/api/healthz` in-process every 30 s;
  the installer polls it from the host as well.

### Why a single worker

The WebAuthn challenge cache and the chat and terminal sessions live
in-process, so the server must run as a single uvicorn worker. Don't add
`--workers`; scale vertically instead.

### Why loopback by default

The container itself must bind `0.0.0.0` (it has no other interfaces from its
own point of view), but the *host* publishes it on `127.0.0.1`, which is what
actually decides reachability. This means:

- fresh installs are unreachable from the network;
- `tailscale serve` or a reverse proxy on the same host can front it with HTTPS
  without exposing the raw port;
- `HUB_BIND=0.0.0.0` is the explicit opt-in to LAN access, with no TLS and the
  unauthenticated reads open to every device on the LAN. It does not make the
  app work, because the app needs an `https://` address; see
  [CONNECT-APP.md](CONNECT-APP.md).

## Configuration surface

Everything is environment-driven via `.env` (see
[SETUP.md](SETUP.md#configuration) for the main table and
[SERVICES.md](SERVICES.md) for every integration). Key ones:

- `HUB_BIND`, `HUB_PORT`: host publish address and port.
- `HUB_DATA_DIR`: persistence.
- `HUB_ORIGIN`: the origin passkeys are bound to. Required for WebAuthn; must
  match the address a browser uses.
- `HUB_PUBLIC_BASE`: the URL advertised to clients.
- `HUB_ALLOWED_HOSTS`: extra host names the server answers to, beyond
  `HUB_ORIGIN`'s host and `localhost`.
- `HERMES_API_BASE`, `HERMES_API_KEY`, `HUB_PLATFORM_KEY_FILE`: the connection
  to Hermes and its plugin.

There is no API token: nothing per-request authenticates the open reads.

## Security model

Summary; full details in [SECURITY.md](../SECURITY.md):

- Loopback by default; the mesh is an explicit step you take.
- No request authentication on most reads. Access control there is the network
  boundary: whoever can reach the server can read them, agent transcripts
  included.
- Chat and the terminal need a session cookie minted by Face ID.
- Writes need a fresh device-key or passkey signature bound to the payload;
  phones are paired with codes from the server's shell.
- A `Host` allowlist blocks DNS rebinding.
- Non-root `hub-api` container, no docker socket, no telemetry. The **optional**
  `hub-bridge` sidecar is the one place privilege is concentrated: in its default
  (docker) mode it holds a docker socket, which is root-equivalent on the host, so
  it is opt-in, requires a shared key on every call, enforces its own allowlist,
  sits on a private network and publishes no port. See
  [SECURITY.md](../SECURITY.md) and [hub-bridge/README.md](../hub-bridge/README.md).

## Related reading

- [SETUP.md](SETUP.md): install and configuration.
- [CONNECT-APP.md](CONNECT-APP.md): HTTPS address and app pairing.
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md): when it doesn't work.
