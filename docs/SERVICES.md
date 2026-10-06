# Services: every optional subservice you can wire into the hub

Xavier is the hub server, the app, and a Hermes plugin. It bundles **none** of
the services below. The code that talks to each one ships in this repository;
the service itself is yours to run or skip. Every setting is blank or harmless
by default, blank is the supported "off" state, and the hub starts with all of
them unset. Panels that depend on a service you have not configured show a 503
or an empty card rather than crash.

Each entry lists what it unlocks, the environment variables the server reads,
what you need to get, and a block you can paste into `.env` (gitignored; never
put secrets in a tracked file). **To apply a change to `.env`, re-run
`./install.sh`**, or `./install.sh --restart`, which recreates the container with
the current `.env`. Check the result with `./install.sh --status`.

This page covers what the **server** wires through environment variables. Tools
the **agent** can reach (mail, search, browsers, payments, and the general
pattern for adding a tool) are covered in **[CONNECTORS.md](CONNECTORS.md)**.

Credentials for any of these live outside the repository: in your `.env`
(gitignored), with the provider, or in your own shell environment. None of them
are ever committed here.

## Start with nothing

The minimum install is the hub with every service setting left blank:

```ini
# .env, server basics only
HUB_PUBLIC_BASE=http://localhost:8090
HUB_ORIGIN=http://localhost:8090
```

That gives you a private dashboard (health, files, and a calendar if you point
`HUB_CALENDAR` at a file later) and an empty chat tab. Chat has nothing behind it
until you connect Hermes, so it holds no conversations. This is a supported way
to run the hub, not a broken one: reads work, writes are gated by Face ID once
you pair a phone, and every missing service is an honest empty panel.

## Agent runtime

### Hermes Agent and the hub-platform plugin

The agent that answers chat, runs your scheduled jobs and holds your memory is
**[Hermes Agent](https://hermes-agent.nousresearch.com/docs)** by Nous Research.
The hub talks to it in both directions:

- the hub calls Hermes at `HERMES_API_BASE`: its session API for the agent
  roster and session transcripts (authenticated with `HERMES_API_KEY`), and the
  plugin's event endpoint for chat sends and approvals (authenticated with the
  shared platform key);
- Hermes calls the hub's `/api/platform/hub/*` routes through the
  **hub-platform plugin** to deliver replies, media, its command list and
  automation runs, carrying the same shared platform key.

Install the plugin into Hermes and provision the shared key as described in
**[hermes-plugin/hub-platform/README.md](../hermes-plugin/hub-platform/README.md)**.
Without Hermes and the plugin, the hub is a dashboard with an empty chat tab;
with them, chat gets an assistant and the automations, memory and session panels
fill in.

```ini
HERMES_API_BASE=http://<gateway address>:8642   # Hermes's API server, as the hub container sees it
HERMES_API_KEY=                                 # the gateway's API_SERVER_KEY
HERMES_AGENT_ID=hermes
HERMES_AGENT_NAME=Xavier
HUB_PLATFORM_KEY_FILE=/data/hub-platform/HUB_PLATFORM_KEY
```

Requires: a running Hermes whose API server the hub container can reach at
`HERMES_API_BASE`, with the plugin installed. Both directions are plain HTTP with
a bearer key as their only authentication, so keep the hub and Hermes on
loopback or a private network. The id and name are labels the hub shows for the
agent. The platform key is read from the file at
`HUB_PLATFORM_KEY_FILE`, never from an environment variable; unprovisioned, the
platform routes answer that the key is missing rather than accepting
unauthenticated calls. Anyone holding that key can deliver messages into chat as
the agent, so keep the file readable only by the hub and Hermes.

### hub-bridge sidecar

A helper that runs a fixed, allowlisted set of Hermes CLI commands (config, cron,
skills, plugins, MCP servers, memory, doctor, spend, and the device-code Connectors
login) on the hub's behalf, so the hub container itself never holds a docker socket
or other privileged access. **It ships in this repository, in `hub-bridge/`**, and
is **opt-in and authenticated** — the default install does not start it. Full
detail, including the risk, is in **[hub-bridge/README.md](../hub-bridge/README.md)**
and **[../SECURITY.md](../SECURITY.md)**.

The hub sends commands to `/run` (reads) and `/run-write` (writes), authenticating
every call with a shared bearer key. The bridge checks that key in constant time
and re-validates each command against its own read/write allowlist, so the hub and
the bridge are two independent gates.

```ini
HUB_BRIDGE_URL=http://hub-bridge:8091
HUB_BRIDGE_TIMEOUT_S=35
HERMES_CONTAINER=hermes          # the agent container (docker exec mode)
HUB_BRIDGE_KEY_FILE=/data/hub-bridge/HUB_BRIDGE_KEY
```

Enable it with the opt-in compose profile:

```bash
./install.sh                         # mints the shared key at <data>/hub-bridge/HUB_BRIDGE_KEY
docker compose --profile bridge up -d
```

Or, if Hermes is installed directly on a machine rather than in a container, run
`bridge.py` on that machine with `BRIDGE_EXEC=local`, which needs no docker socket.
The Compose profile is docker mode only (see the bridge's README).

Requires: the shared key (install.sh mints it), and — in docker mode — access to
`/var/run/docker.sock`, which is **root-equivalent on the host**; that is why the
sidecar is opt-in and sits on a private network with no published port.
`HUB_BRIDGE_TIMEOUT_S` is the hub's client timeout; the default sits just above the
bridge's own 30-second exec timeout. An empty `HUB_BRIDGE_URL` disables every
bridge-backed panel.

## Model access

Models are configured in Hermes, not in the hub. The hub only reads your
OpenRouter account, if you want its numbers in the app.

### OpenRouter key

The cost views show your [OpenRouter](https://openrouter.ai) credit balance and
key usage from this key. The hub never sends a prompt through it. Leave it blank
and those views stay empty.

```ini
OPENROUTER_API_KEY=sk-or-...
```

Requires: an OpenRouter account and key. Usage is billed to your account by
OpenRouter.

### OpenRouter management key

Per-model, per-day activity from OpenRouter's activity endpoint, which answers
only to a management key. Without it the spend view shows credits alone.

```ini
OPENROUTER_MGMT_KEY=
```

Requires: a management key from your OpenRouter dashboard (a separate key type
from the one above).

## Messages

### iMessage (MCP)

Have the agent draft iMessages for you to approve. A draft is created on your
Mac by an iMessage MCP server that you run there (not part of this repository);
nothing is sent until you approve it, with Face ID in the app or, if you set up
Discord approvals, from Discord (below). Drafts expire after
about 15 minutes. Creating a draft through `POST /api/chat/imessage/draft` needs
the chat session cookie or the plugin's shared key.

```ini
IMESSAGE_MCP_URL=http://your-mac-host:8400/mcp
IMESSAGE_MCP_TOKEN=
IMESSAGE_QUEUE_DIR=/data/hub/queue/imessage-drafts
```

Requires: an iMessage MCP server running on your Mac and reachable from the hub.
The token comes from `IMESSAGE_MCP_TOKEN` or, failing that, from the file
`/data/hub/secrets/imessage-token` (that path is overridable with
`IMESSAGE_TOKEN_FILE`). Without a token, the draft routes report the integration
as unconfigured. When the Mac is asleep, drafts wait in `IMESSAGE_QUEUE_DIR`.
Nothing in this repository drains that folder: send the draft again once the Mac
is awake, or point a job of your own at it.

### Discord notices and approvals

The hub can post a notice to a [Discord](https://discord.com) channel you
control when an iMessage draft is waiting for you, including the contact and the
draft text, with Approve and Deny buttons. Only the Discord account in
`HUB_APPROVER_DISCORD_ID` can press them, and each button carries the draft's
signature. Each draft also has a signed approval link
(`/api/imessage/approve/{id}`): anyone holding it can send that one draft, so
keep the channel private. The hub posts through Discord's API and needs no
inbound connection.

```ini
HUB_APPROVALS_CHANNEL=
HUB_APPROVER_DISCORD_ID=
```

Requires: a Discord bot invited to your server, with its token in the file
`/data/hub/secrets/discord-approvals-token` (that path is overridable with
`HUB_DISCORD_APPROVALS_TOKEN`). Set the channel id and your Discord user id in
the two variables above. Dormant until the token file exists.

### Telegram topic routing (the Routing page)

```ini
HUB_TOPICS_CONFIG=/data/hub/config/telegram-topics.json
HUB_TOPICS_LIVE=/data/hub/config/telegram-topics.live.json
```

The Routing page sets which Telegram chat and topic each automation reports to.
It reads `HUB_TOPICS_CONFIG` and, behind Face ID, writes it back marked
`pending_sync`. The page compares it with `HUB_TOPICS_LIVE`, a snapshot of what
is actually live, and flags any drift.

Requires: a job of your own that applies the file to your Hermes cron jobs'
delivery targets, writes the live snapshot, and clears `pending_sync`. Nothing in
this repository does that. Until the config file exists, the page reports that
it has not been written yet.

## Voice

### Live voice (Deepgram)

Hands-free voice conversations with Xavier from the app's Live page. The phone
streams its microphone to the hub over the `/api/live` socket, and the hub
streams that audio to [Deepgram](https://deepgram.com): Flux speech-to-text
decides when you have finished a turn, the turn goes into a chat thread like a
typed message, and Flux text-to-speech speaks the reply back as Hermes writes
it. The socket needs the Face ID chat session and refuses a browser `Origin`
that is not this hub.

```ini
DEEPGRAM_API_KEY=
```

Requires: a Deepgram account and an API key, and Hermes with the hub-platform
plugin for the replies (a spoken turn Hermes does not take is kept in the
thread, and Live says so). Usage is billed to your Deepgram account. The microphone
streams for as long as a session is open, not just while you speak, so
speech-to-text minutes run for the whole session; a session ends itself after
four quiet minutes. The audio and every spoken reply pass through Deepgram (see
[PRIVACY.md](PRIVACY.md)). Without the key, Live never contacts Deepgram: the
socket ends the session at once and the app says voice is not set up. To check
a key against the real service, run `server/scripts/live_probe.py` with it in
the environment.

Talking over a turn that is still running asks Hermes to redirect it, which the
plugin passes on as the message's busy mode. Stock Hermes ignores a per-message
mode and applies its own `display.busy_input_mode`, so on a stock gateway a
spoken interruption is queued, steered or interrupted as that setting says (see
[FEATURES.md](FEATURES.md)).

## Notifications

### Push notifications (Expo)

The hub pushes a finished chat reply or an automation's report to your phone,
through Expo's push service. Each notification carries the thread title (or job
name) and the first ~140 characters of the text; that content passes through
Expo and Apple. A phone registers its Expo push token through a Face-ID-gated
route, with the challenge bound to the token, so a captured proof cannot
redirect your notifications.

```ini
HUB_PUSH_TOKENS=/data/hub/data/push_tokens.json
```

Requires: the Apple push key in your Expo project's credentials (builds from this
repository never prompt for it, so set it up once with
`npx eas-cli credentials -p ios`), and the app registering its token, which it offers
from the brief screen. The token file path has a working default; registered
tokens are never returned by the listing.

## Machine control

### Terminal (ttyd)

A real, writable shell on the hub's machine, as the user you install it for,
proxied to [ttyd](https://github.com/tsl0922/ttyd) over a unix socket. The proxy
forwards HTTP and websocket traffic only after a Face ID unlock has issued a
short-lived session cookie, and refuses a websocket whose `Origin` is not this
hub. ttyd itself comes from your package manager; the
[host kit](../host/README.md) runs it as a systemd unit on Linux (on macOS, a LaunchAgent you load by hand)
with the socket in `/run/xavier`, a directory only that user and the hub's group
can enter, and never on TCP.

```ini
HUB_TTYD_SOCK=/run/xavier/ttyd.sock
HUB_TTYD_BASE=/terminal
```

Requires: `sudo host/install.sh`, and `host/compose.host.yml` enabled in `.env`
(it mounts `/run/xavier` read-only, adds the hub to the socket group and sets both
socket variables). Read the risk section of [host/README.md](../host/README.md)
first: anything that can open the socket has the shell without Face ID. An empty
`HUB_TTYD_SOCK` (the default) disables the terminal.

### hub-tmuxd

The shell picker: list, start and stop Claude Code sessions in
[tmux](https://github.com/tmux/tmux), and resume past ones, through hub-tmuxd
([host/hub-tmuxd](../host/hub-tmuxd/tmuxd.py), installed by the same host kit).
Reading the lists needs the terminal session cookie; every spawn and kill is a
Face ID gated write. hub-tmuxd runs only the configured Claude Code binary, with
no permission-bypass flag unless you opt in, in directories under
`XAVIER_CWD_ROOTS` (your home by default); it stops only the `claude-*` sessions
it owns, and its resume list carries titles and ids, not directories or prompts.

```ini
HUB_TMUXD_SOCK=/run/xavier/tmuxd.sock
```

Requires: the host kit, as above; its settings live in `/etc/xavier/tmuxd.conf`.
Without it (the default is empty) the picker answers 503 and shows an error line.

## Storage and paths

### File browser roots

A read-only, multi-root file browser. Traversal and symlink escapes are
rejected; dotfiles and credential-looking files are never served. These reads
are not authenticated, so configure only directories you are happy for anything
on your network to read.

```ini
# Replace the whole root registry (one "id:label:/abs/path" per root):
HUB_FS_ROOTS=sites:Sites:/data/sites;code:Code:/data/code
# Or, without HUB_FS_ROOTS, add the standard roots one at a time:
HUB_FS_SITES=
HUB_FS_CODE=
HUB_FS_HUB_CONFIG=
HUB_FS_LAUNCH_AGENTS=
```

Requires: nothing. No folder is served until you name one: set `HUB_FS_ROOTS`, or
any of the four per-root variables, to directories the hub can see (under
Docker, folders below `/data`). `HUB_FS_ROOTS`, when set, replaces the per-root
variables entirely.

### Chat store

Chat history, sessions, and uploaded media live in files you can relocate.
Self-contained; nothing external is required.

```ini
HUB_CHAT_DB=/data/hub/chat/chat.db
HUB_CHAT_SESSIONS_FILE=/data/hub/chat/sessions.json
HUB_CHAT_MEDIA_DIR=/data/hub/chat/media
```

Requires: nothing. The defaults are fine; set these only when you want the store
somewhere else (a mounted volume, for example).

### Dashboard feeds

Several panels are filesystem-as-API: something on your side writes a file, the
hub serves it, and a missing or stale file shows as an honest empty state. The
jobs that write these files are yours; none ship in this repository.

```ini
HUB_CALENDAR=/data/hub/calendar.json
HUB_FINANCE_SNAPSHOT=/data/sites/finance/snapshot.json
HUB_BRIEFING_RULES=/data/hub/data/briefing_rules.json
HUB_DECISIONS_DIR=/data/hub/decisions
HUB_INBOX_DIR=/data/hub-inbox
```

- `HUB_CALENDAR`: a calendar snapshot the calendar views read; a sync-request
  file sits next to it for a host job to act on.
- `HUB_FINANCE_SNAPSHOT`: a snapshot file the app can display; the hub only
  serves it and never talks to any provider itself.
- `HUB_BRIEFING_RULES`: the briefing rules file the hub reads and writes when
  you edit rules in the app. The daily brief itself is read from
  `briefing-YYYY-MM-DD/brief.json` under `MY_PAGES_ROOT`.
- `HUB_DECISIONS_DIR`: one JSON file per decision; agents write cards, you
  answer with Face ID, and every answer appends to a ledger in the same
  directory.
- `HUB_INBOX_DIR`: cards any agent can drop as JSON files, shown on the feed.

All five have working defaults and need no configuration to run standalone.

### Weather widget data

The app's weather widget draws JSON in a fixed shape. This repository does not
bundle a weather provider; it includes an example connector,
`scripts/weatherkit.py`, which calls
[Apple WeatherKit](https://developer.apple.com/weatherkit/) and prints exactly
the JSON the widget expects. Hermes can run it and hand the output to the
plugin's widget tool, and the app draws it as a weather card in chat. As a free
alternative with no key, [Open-Meteo](https://open-meteo.com) serves the same
kind of forecast data, and a short script can reshape it the same way. No hub
variables are involved.

## Security

### Host allowlist

```ini
HUB_ALLOWED_HOSTS=
```

Extra host names the server answers to, as a comma list. It always answers to
the host in `HUB_ORIGIN` and to `localhost`, `127.0.0.1` and `::1`; a request for
any other host gets a 421 (a WebSocket is closed), which blocks DNS rebinding
from web pages you visit. Add a name here only if you reach the hub by one that
is not in `HUB_ORIGIN`, such as a container name another service uses.

### Passkeys (WebAuthn)

The passkey ceremony that can unlock chat and the terminal and authorise writes,
alongside the phone's device key. Self-contained. Nothing in this repository
enrols a passkey: the app pairs a device key instead (next section), so these
settings matter only for a browser client of your own.

```ini
# The exact origin the browser uses; required.
HUB_ORIGIN=https://hub.example.com
HUB_RP_ID=hub.example.com            # optional; derived from HUB_ORIGIN
HUB_RP_NAME=Hub
HUB_PASSKEYS=/path/to/passkeys.json
```

Requires: nothing external. `HUB_ORIGIN` must be the exact origin a browser uses
to reach the hub; passkeys are bound to it, and with it left blank the server
refuses passkey setup with an error naming the variable instead of failing
inside the browser. `HUB_RP_ID` defaults to that origin's host name; set it only
when it must differ. The passkey store path has a working default. Passkey
enrolment is open only while no credential of any kind exists; after that a new
passkey needs an assertion from an existing one.

### Device keys and enrolment

Write-capable device keys held in the phone's Secure Enclave, trusted only after
the phone presents a one-time, single-use, expiring enrolment code from
`./install.sh --pair`.

```ini
HUB_DEVICEKEYS=/path/to/devicekeys.json
HUB_ENROLL_CODE_TTL_S=120
HUB_ENROLL_CODE_MAX_ATTEMPTS=5
```

Requires: nothing external. The TTL (seconds a minted code lives) and the attempt
limit have working defaults; raise the TTL only if codes keep expiring before you
type them. None of this authenticates reads; the network boundary does, so keep
the hub off the public internet. See [SECURITY.md](../SECURITY.md).

### Keeping secrets out of `.env`

The hub reads its settings from `.env` through Docker Compose. A password
manager can render that file for you from a template (1Password's `op inject`,
for example), which keeps the source of truth in your vault, but the rendered
file is still on disk, so give it the same care: mode 600, out of version
control, backed up securely.

## Not built yet

- **Home Assistant control.** `server/ha_actions.py` has a passkey-gated
  challenge and an apply that only logs what it would do; `HA_LIVE_APPLY=true`
  makes the apply return 501, because the live path is not written. Nothing in
  the app proposes Home Assistant actions yet.
- **Cloud browser card.** The app has a card for live cloud-browser sessions,
  but this server does not implement the route it reads
  (`/api/browser/sessions`), so the card stays hidden.

## Adding services later

Every service above is additive and independent. You can wire them in one at a
time, in any order, long after the first install: put the values in `.env`,
re-run `./install.sh`, and confirm with `./install.sh --status` and the relevant
panel. Removing a service (blank the settings, re-run) returns its panels to
their empty state.
