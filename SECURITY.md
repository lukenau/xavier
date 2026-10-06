# Security

Read this before you let anything but `localhost` reach the server.

## The model, honestly

The Xavier server ("the hub") has no user accounts and no login. Most of what it
serves is protected by one thing: whether a client can reach the port at all.
On top of that, chat, the terminal and most writes need Face ID on a phone you
paired; the writes that do not are listed under
[Other ways in](#other-ways-in). In full:

| Layer | What it does | What it does not do |
|---|---|---|
| **Loopback bind** (`HUB_BIND=127.0.0.1`) | Only the machine it runs on can reach the port | Nothing, once you bind wider |
| **Private mesh** (Tailscale, WireGuard, Headscale) | Encrypts traffic and limits reachability to your devices | Identify individual users |
| **Host allowlist** | Answers only to the host names in `HUB_ORIGIN`, `localhost`/`127.0.0.1`/`::1`, and any in `HUB_ALLOWED_HOSTS`; anything else gets a 421. This blocks DNS rebinding from a web page you visit | Stop a client that can reach the port and sends an allowed host name |
| **Chat session** (cookie minted by Face ID) | Gates chat threads, messages, attachments, the live chat socket and the automations list | Gate the other reads |
| **Terminal session** (cookie minted by Face ID) | Gates the `/terminal` proxy and the tmux session lists | Gate the other reads |
| **Device key or passkey signature** | Authorises each write, bound to its exact payload | Gate reads |

**Consequence:** anything that can reach the port can read everything in the next
section, including the agent's full session transcripts. Treat reachability as
authority, and keep the server on a private network.

> **There is no API token and no login.** Nothing per-request authenticates the
> reads in the next section. Do not expose the port and hope something else will
> stop a caller.

## What anyone who can reach the port can read

These `GET` routes carry no credential. Several answer only when the service
behind them is configured (Hermes, the hub-bridge sidecar, a cron job writing a
cache file); otherwise they return an empty state or a 503.

| What it reveals | Routes |
|---|---|
| **Agent sessions and full transcripts**: every session with its preview and cost, and each session's messages, tool calls and reasoning, proxied from Hermes | `/api/sessions`, `/api/sessions/{id}`, `/api/sessions/{id}/messages` |
| **Agent configuration and state**, read through Hermes or the hub-bridge sidecar: the config tree (the bridge redacts secret-shaped leaves before they leave the agent container — see `hub-bridge/`), skills, plugins, MCP servers, connected accounts, memory status, messaging-pairing requests, scheduled jobs with their run logs and costs, the task board, a doctor report | `/api/agents`, `/api/vitals`, `/api/config`, `/api/config/full`, `/api/advisor`, `/api/skills`, `/api/plugins`, `/api/mcp`, `/api/connectors`, `/api/connectors/{provider}/oauth-status`, `/api/memory`, `/api/pairing`, `/api/doctor`, `/api/cron`, `/api/cron/costs`, `/api/cron/logs`, `/api/kanban` |
| **Spend**: model spend over time, OpenRouter credit balance, recurring costs | `/api/spend/summary`, `/api/spend/timeseries`, `/api/cost/openrouter`, `/api/cost/recurring` |
| **Your data feeds**: calendar events, the daily brief and its standing rules, decision cards, the feed, a finance snapshot if you write one, pages you publish, activity and schedules, message-routing config | `/api/calendar`, `/api/brief`, `/api/briefing/rules.json`, `/api/decisions`, `/api/feed`, `/api/finance`, `/api/my-pages`, `/my-pages/*`, `/api/activity`, `/api/schedules`, `/api/config/topics` |
| **Files** under the roots you configure (dotfiles and credential-looking files are refused; each read is capped at 256 KB) | `/api/files/roots`, `/api/files/browse`, `/api/files/read` |
| **Operations**: health checks, backup status, the access report | `/api/health`, `/api/healthz`, `/api/backups`, `/api/audit` |
| **Enrolment state**: whether a passkey or phone is paired, with labels and dates, never key material or push tokens | `/api/passkey/status`, `/api/devicekey/status`, `/api/push/devices` |
| **Counters**: the automations badge count, a static model list | `/api/automations/badge`, `/api/chat/models` |

This list was taken from the route table in `server/app.py` and its routers. If
you add a route, assume it is unauthenticated unless it says otherwise.

## What needs Face ID

- **Chat.** Everything under `/api/chat/` (threads, messages, attachments, sends,
  the "needs you" inbox, automations, and the `/api/chat/ws` socket) needs the
  `hub_chat_session` cookie, apart from the unlock routes themselves
  (`/api/chat/challenge`, `/session`, `/logout`) and the static model list. The
  cookie is minted by a fresh device-key or passkey assertion and lasts an hour
  by default (`HUB_CHAT_SESSION_TTL_S`).
- **The terminal.** The `/terminal` proxy to ttyd and the tmux session lists
  (`/api/tmux/*`) need the `hub_term_session` cookie, minted the same way. The
  terminal's websocket also refuses an `Origin` that is not this hub (see
  [the terminal and Claude Code shells](#the-terminal-and-claude-code-shells)).
- **Writes.** Every state-changing call through `/api/action/*` (config, cron,
  tmux spawn and kill, device-key administration), decision answers and chat
  approvals (either of which can send an iMessage draft), routing config,
  briefing rules, push registration and connector logins needs a fresh signature
  bound to that exact payload. A connector login's device code can then be read
  only with a token returned to the device that started it, because whoever
  approves that code decides whose account the agent logs into. Device-key administration (minting a code, revoking a phone)
  accepts a passkey only. With no signer enrolled, the server refuses with a 412
  before any proof is checked.
- **Home Assistant** routes (`/api/ha/*`) accept a passkey only, and they do not
  control anything yet: applies are logged as a dry run, and a live apply
  returns 501.

## Other ways in

Some routes are reachable without Face ID by design. Each one, and what guards it:

- **The Hermes plugin's routes** (`/api/platform/hub/*`) take a shared bearer key
  read from `HUB_PLATFORM_KEY_FILE`. Whoever holds that key can deliver messages
  into chat as the agent and sync automations. Keep the file readable only by the
  hub and Hermes.
- **Pairing a phone** (`POST /api/devicekey/register`) needs a one-time enrolment
  code. Codes are minted by `./install.sh --pair` on the server, over a local
  unix socket and **without any ceremony**: shell access to the server is
  treated as full trust, because it could rewrite the key store anyway. A
  passkey-gated action can also mint one (`devicekey.enroll_code`). Codes are
  single-use, expire after 120 seconds, and only one is live at a time.
- **Passkey enrolment** is open only while the server has **no credential at
  all**: no passkey and no paired phone. Once either exists, adding a passkey
  needs a fresh assertion from an existing passkey or paired phone (purpose
  `register_reauth`). So pair your phone, or enrol your first passkey, before
  you let anything else reach the server.
- **iMessage drafts** are created through `POST /api/chat/imessage/draft`, which
  needs the chat session cookie or the plugin's shared key. A draft is only sent
  once you approve it: with Face ID in the app, or, if you set up Discord
  approvals, with the Discord button (only the approver account you configure
  can press it). Each draft also gets a signed approval link
  (`/api/imessage/approve/{id}`). That link is a bearer capability: anyone
  holding it can send that one draft, so share it only through a private channel.
- **Brief item actions** (`/api/briefing/dismiss.json`, `useful.json`,
  `note.json`) need a per-item token, but the token ships inside the brief, so
  anyone who can read the brief can use it. The older form route
  `/api/briefing/dismiss` takes no token at all. Both only hide or annotate your
  own brief cards.
- **Calendar sync** (`POST /api/calendar/sync`) is ungated. It only asks the host
  to run a sync sooner, and a repeat while one is pending changes nothing.

A few more POST routes take a bearer token held by a component you run (the
iMessage draft mirror, for one). Any POST outside the server's allowlist
(`POST_ALLOWLIST_PREFIXES` in `server/app.py`) is refused with a 405, as is
every method other than `GET` and `POST`.

## Writes, and their limits

Sensitive writes require a **device key**: a P-256 signature from a key held in
the phone's Secure Enclave (`server/devicekeys.py`), or a WebAuthn passkey
assertion (`server/webauthn_gate.py`). Each challenge is bound to a hash of the
exact request, so a signature for one change cannot be replayed against another.

Honest limitations:

- A valid signature proves possession of the Enclave key, not that Face ID
  actually matched. Normally iOS only lets the Enclave sign after a live Face ID
  match, but this server cannot verify that. A jailbroken handset with an
  unlocked Enclave is inside the gate.
- A passkey cannot be revoked through the API yet; edit `passkeys.json` (or
  `HUB_PASSKEYS`) by hand to remove one. Removing a device key does not end a
  chat or terminal session it already holds; that lasts until it expires.
- Hermes and ttyd are separate programs this repository does not ship; their
  security is outside what this code can attest to. The **hub-bridge** sidecar
  does ship here (`hub-bridge/`): its key check and read/write allowlist are
  auditable, but its core privilege is not — see the next section. So does
  **hub-tmuxd**, with the units that run it and ttyd (`host/`); see
  [the terminal and Claude Code shells](#the-terminal-and-claude-code-shells).

## The hub-bridge sidecar

The optional `hub-bridge` sidecar runs a fixed, allowlisted set of Hermes CLI
commands so the hub never needs privileged access itself. It is **opt-in** (the
`bridge` compose profile; the default install never starts it). Full detail is in
[hub-bridge/README.md](hub-bridge/README.md); the security essentials:

- **It is authenticated.** Every endpoint except `/healthz` requires a shared
  bearer key, compared in constant time against `HUB_BRIDGE_KEY_FILE` (mode 0600,
  minted by `install.sh` beside the platform key). The hub sends the same key. With
  no key configured the bridge **fails closed** — every request is refused. This
  is a second gate behind the hub's Face ID: a caller that reaches the bridge's
  port directly still needs the key *and* an allowlisted command.
- **The docker socket is root-equivalent.** In the default (docker) exec mode the
  bridge holds `/var/run/docker.sock` to `docker exec` into the agent container.
  Anyone who can use that socket controls the Docker daemon and thus the host.
  That is why the bridge is opt-in, runs on a **private network**, **publishes no
  host port**, and must be kept off any shared or public network. If Hermes runs
  directly on a machine, prefer running the bridge there with `BRIDGE_EXEC=local`,
  which needs no socket (the Compose profile always mounts it).
- **The allowlist is strict and split.** Reads (`/run`) and writes (`/run-write`)
  are disjoint; each command is matched to an exact subcommand with per-argument
  regex checks; shell metacharacters, option injection and path traversal are
  rejected; and `config set` additionally refuses secret-shaped and environment
  (`UPPER_SNAKE`) keys, so a direct bridge caller cannot write a credential even if
  it bypassed the hub. No shell is used on the command path.

## The terminal and Claude Code shells

The terminal is a **real, writable shell on the hub's machine**, as the user the
host kit runs it for, and the shell picker starts Claude Code there. Both are
opt-in ([host/README.md](host/README.md)). The programs behind them, ttyd and
hub-tmuxd, have no login of their own: the hub opens them only after a Face ID
unlock, and the filesystem decides who else can.

- **Unix sockets, never TCP.** Both sockets live in `/run/xavier` (mode 0750) as
  0660 files owned by the shell's user and the `xavier-hub` group. The hub
  container joins that group and mounts the directory read-only. **Anything that
  can open those sockets has the shell without Face ID**: never mount the
  directory into another container, an agent's least of all, and never add anyone
  to the group.
- **The hub is the gate.** Code running in the hub container can open both
  sockets by design, so a compromised hub is a shell on its machine.
- **Cross-site hijacking.** The session cookie is `SameSite=Strict`, but every
  port of the hub's host and every machine in the same tailnet is the same site,
  and websockets are not covered by the same-origin policy. The terminal websocket
  therefore also requires the browser's `Origin` to be this hub.
- **hub-tmuxd** runs only the configured Claude Code binary, with no
  permission-bypass flag unless you set
  `XAVIER_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=1`, in directories inside
  `XAVIER_CWD_ROOTS` (resolved, so `..` and symlinks cannot leave them), with a
  scrubbed environment and a session cap. It stops only its own `claude-*`
  sessions, and its resume list returns titles and ids, never prompts, and no
  directories unless you opt in. Every caller-supplied value is matched against a
  strict pattern before tmux sees it: tmux treats an argument ending in `;` as a
  new command and runs `#(...)` in session names and directories.
- **The shell can do what its user can.** The systemd units block `sudo` and make
  the operating system read-only, but the home directory, with its SSH keys,
  cloud credentials and logins, stays writable and readable. A user in the
  `docker` group is root-equivalent.

## What leaves the machine

There is no telemetry and nothing reports to the project. Data leaves only to
services you turn on: your model provider (through Hermes), Expo and Apple for
push notifications, EAS Update for over-the-air update checks, and any hosted
memory or search you connect. The details, route by route:
[docs/PRIVACY.md](docs/PRIVACY.md).

## Therefore

- **Keep `HUB_BIND=127.0.0.1`.** This is the default and the single most
  important setting.
- **Reach it over a private mesh, not the internet.** Tailscale, Headscale or
  WireGuard; see [docs/MESH.md](docs/MESH.md). `tailscale serve`, never
  `tailscale funnel`.
- **Do not publish it on a public domain.** A reverse proxy with TLS encrypts the
  traffic but leaves the unauthenticated reads open to anyone who finds the
  address, and the app cannot sign in to a proxy that demands its own login.
- **Pair first.** Pair your phone before anything else can reach the server.

## Secrets

- Real credentials belong in `.env` only, which is gitignored; `install.sh`
  creates it with mode 600.
- `scripts/publish-gate.sh` scans for committed keys and tokens, private keys,
  credential files, `.env` files, tailnet addresses and personal contact
  details. Run it before any push.
- Keys the server mints at runtime (device keys, compose tokens, bridge tokens)
  are written to the data directory, never the repository.

## Your responsibilities

- Do **not** set `HUB_BIND=0.0.0.0` on a machine whose network you do not trust.
- Keep `.env` out of version control (it is gitignored) and back it up securely.
- Treat the server's reachability as its password.

None of this is supported. The software is provided **as-is**, with no warranty,
no support commitment and no SLA, by one individual. You are responsible for how
you expose your server, and the consequences of that choice are yours. See
[NOTICE.md](NOTICE.md).

## Supported versions

Xavier is pre-1.0 and moves quickly. There are no release branches; the default
branch is the only thing that gets fixes.

| Version | Supported |
|---|---|
| Latest commit on the default branch (`main`) | Yes |
| Any earlier commit, tag or fork | No |

If you are running anything older, update to `main` first, then report the
problem if it survives.

## If you host this for other people

Pointing other people at your server makes you the operator of their data. What
the server then holds, how to revoke access, and how to delete it on request is
set out in [docs/PRIVACY.md](docs/PRIVACY.md#who-is-responsible) (with retention
under [How long data is kept](docs/PRIVACY.md#how-long-data-is-kept)), and [docs/TESTER-PRIVACY.md](docs/TESTER-PRIVACY.md) is a short notice you can
hand someone you invite.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: **Report a vulnerability** under
the repository's **Security** tab, which reaches the maintainer only. If that
option is not shown, contact the maintainer, **Luke Nau**
([@lukenau](https://github.com/lukenau)). Please do not open a public issue for an
unexploited vulnerability.

**Response expectation.** One person maintains this project, so handling is best
effort and there is no SLA. As a target rather than a promise, the aim is to
acknowledge a report within **5 days** and give a first assessment shortly
after. A fix can still take a while, depending on severity. If a report warrants
a CVE, the maintainer will request one through GitHub's advisory flow and credit
the reporter unless asked not to.

**Safe harbour.** If you research this project in good faith, the maintainer
will not pursue legal action over vulnerabilities disclosed responsibly. That
courtesy does not extend to accessing other people's data or degrading the
service: do neither.
