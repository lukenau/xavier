# `server/` — hub-api

The FastAPI backend of Xavier, called "the hub" in the docs. It serves the app's
read surface, streams chat and terminal traffic, talks to Hermes, and puts an
authentication gate in front of every write: a WebAuthn (Face ID / Touch ID)
passkey, or a Secure-Enclave device key paired to a phone. Chat and the terminal
also need a session cookie minted by that gate. Most other reads have no
credential and are meant to be reached only over a private network; see
[../SECURITY.md](../SECURITY.md).

It is one piece of the repository. Run and configure it from the repository root
with `./install.sh`; the sections below describe the service itself.

## How it runs

- **Container, one worker.** `docker-compose.yml` builds this directory and runs
  `uvicorn app:app`. The container listens on **8090** and, by default, the host
  publishes it on `127.0.0.1:8090`: loopback only, so nothing is reachable off
  the machine until you add a mesh such as `tailscale serve` (see
  [../docs/CONNECT-APP.md](../docs/CONNECT-APP.md)).
- **Single worker is load-bearing.** The WebAuthn challenge cache and the chat
  and terminal sessions are in-process, so a challenge minted by one worker must
  be verified by the same one. Do not raise the worker count.
- **Non-root.** The container runs as `HUB_UID` (default `1000`) and writes its
  database, uploads and key stores under the mounted data dir (`/data`).
- **Only `requirements.txt`** is installed in the image; `requirements-dev.txt`
  is for the tests.

## Configuration

Everything is environment-driven from `.env` (copied from `.env.example` by
`install.sh`; re-run `./install.sh` to apply changes). The keys that matter most
here:

- `HUB_ORIGIN`: **required for passkeys.** The exact origin a browser uses to
  reach the hub (`https://<machine>.<tailnet>.ts.net`, or `http://localhost:8090`
  for a local-only install). WebAuthn binds credentials to it, so it must match
  the browser's address bar. If it is blank the server refuses passkey setup with
  an error naming this variable. A comma-separated list is accepted; the first
  entry is the one WebAuthn uses.
- `HUB_RP_ID`: the relying-party host name passkeys are scoped to. Derived from
  `HUB_ORIGIN` when left blank.
- `HUB_PUBLIC_BASE`: the URL the server advertises to clients (used in
  notification links).
- `HUB_ALLOWED_HOSTS`: the host names the server answers to; other `Host`
  headers are refused, which blocks DNS rebinding.
- `HUB_BIND` / `HUB_PORT`: host-side publish address and port.
- `HUB_DATA_DIR`: the host directory persisted into the container at `/data`.
- `HERMES_API_BASE` / `HERMES_API_KEY` and `HUB_PLATFORM_KEY_FILE`: the
  connection to Hermes and the shared key its hub-platform plugin uses (see
  [../hermes-plugin/hub-platform/README.md](../hermes-plugin/hub-platform/README.md)).
- `HUB_BRIDGE_URL`: base URL of the hub-bridge sidecar (opt-in, in
  [`../hub-bridge/`](../hub-bridge/README.md)), which runs Hermes CLI commands so
  this container never needs a docker socket. Empty disables those surfaces.
- `HUB_TTYD_SOCK` / `HUB_TMUXD_SOCK`: host unix sockets for the terminal (ttyd)
  and the shell picker (hub-tmuxd), both daemons you run on the host (see `host/`). Unix
  sockets, not TCP ports: reachable only by a process that can open the socket
  file.

Every other setting is in [../docs/SERVICES.md](../docs/SERVICES.md).

## Files

| File | Purpose |
|---|---|
| `app.py` | FastAPI app: read endpoints, the write gate (`/api/action/*`), terminal proxy, brief, decisions, push registration, iMessage drafts, request middleware |
| `chat/` | chat store and routes, the Face ID chat session, the chat socket, approvals, automations, push (`notify.py`), and the routes the Hermes plugin calls (`platform.py`) |
| `webauthn_gate.py` | the passkey gate: registration and assertion verification, and the shared challenge cache |
| `devicekeys.py` | the phone's second verifier: Secure-Enclave device keys and their enrolment codes |
| `pair_local.py` / `pair_cli.py` | local (unix-socket) enrolment-code minting for `./install.sh --pair` |
| `ha_actions.py` | Home Assistant challenge and dry-run apply; a live apply returns 501 (not built yet) |
| `files.py` | read-only multi-root file browser |
| `hub_calendar.py` | calendar read surface and sync request |
| `Dockerfile` | container image for this service |
| `requirements.txt` / `requirements-dev.txt` | runtime and test dependencies |
| `run_tests.sh` | runs the suite the way it is designed to run (one process per test file) |

Runtime stores (`passkeys.json`, `devicekeys.json`, the chat database) are
created in the data dir and are never committed.

## Endpoints

**Reads without a credential.** Most `GET` routes, including `/api/health`,
`/api/agents`, `/api/sessions` and each session's full transcript, config, cron,
costs, `/api/calendar`, `/api/brief`, `/api/files/*` and `/api/my-pages`. Anyone
who can reach the port can read them. The complete list, with what each one
reveals, is in [../SECURITY.md](../SECURITY.md).

**Reads behind a Face ID session cookie.** Everything under `/api/chat/`
(threads, messages, media, automations, the socket) needs `hub_chat_session`;
the `/terminal` proxy and `/api/tmux/*` need `hub_term_session`.

**Writes behind a fresh signature** (a WebAuthn assertion or device-key proof
bound to the exact payload):

| Endpoint | Gate |
|---|---|
| `/api/passkey/register/{challenge,options,verify}` | enrol a passkey; open only while no credential exists at all |
| `/api/action/{challenge,apply}` | structured writes: `config.set`, `cron.*`, Hermes messaging pairing, gateway restart and drain, tmux spawn and kill, device-key administration (passkey only) |
| `/api/terminal/{challenge,session}`, `/api/chat/{challenge,session}` | unlock the terminal or chat (sets the session cookie) |
| `/api/chat/approval/{challenge,apply}` | answer approval cards, including iMessage drafts |
| `/api/decisions/{id}/{challenge,answer}` | answer Decision Inbox cards, including iMessage drafts |
| `/api/config/topics`, `/api/briefing/rules.json`, `/api/push/*` | the remaining signed surfaces |
| `/api/ha/{challenge,apply}` | Home Assistant, passkey only; dry run, live apply returns 501 |

**Writes gated another way.** `/api/devicekey/register` (a one-time enrolment
code), `/api/platform/hub/*` (the plugin's shared key), the brief item actions
(a per-item token), `/api/chat/imessage/draft` (the chat session or the
plugin's key), and two ungated requests: `/api/calendar/sync` and
`/api/connectors/{provider}/connect`. A `POST` outside the allowlist
(`POST_ALLOWLIST_PREFIXES` in `app.py`) gets a 405.

## Auth posture

- **Reads:** the network boundary for most; Face ID session cookies for chat,
  the terminal and tmux.
- **Writes:** the network boundary **plus** a per-action WebAuthn passkey
  assertion or a paired device key. Unknown credentials are rejected and every
  anomaly fails closed. The origin a passkey is bound to is set explicitly
  (`HUB_ORIGIN`); it is never derived from the request.
- **No shell parameterization.** The one subprocess allowed is a fixed-argument
  status probe; structured writes are mapped to argv server-side and
  re-validated by the bridge.

Details on the model and its limits: [../SECURITY.md](../SECURITY.md).

## Tests

```bash
./run_tests.sh
```

Each `test_*.py` runs in its own process on purpose: the chat tests set their
environment at module scope before importing `app`, so a single shared `pytest`
invocation would let one module's environment leak into another.
