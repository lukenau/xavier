# hub-platform: the Hermes Agent plugin behind Xavier's chat

The hub server in this repo (`server/`) does not talk to a model itself. Chat,
Automations and agent transcripts go through a [Hermes Agent](https://hermes-agent.nousresearch.com/docs)
gateway, and this plugin is the gateway half of that link. Without it a stock
Hermes gateway has no `hub` platform, answers the hub's events with a `503`, and
chat does nothing.

## What it does

- **Registers a `hub` platform.** Each hub thread is one Hermes session
  (`agent:main:hub:dm:<thread_id>`). Messages from the app arrive as normal turns,
  attached images and files included. A `/skill` typed mid-sentence is expanded
  the way a leading one would be.
- **Sends replies back to the hub.** Final text, images, files, approval cards
  for guarded commands, and `clarify` questions as buttons. Answers come back as
  events and resolve the exact request they belong to.
- **Streams the turn.** Text and reasoning deltas stream as they arrive. Tool
  calls and subagents show up as cards. Arguments and results pass through the
  gateway's own secret redaction and hard length caps before they leave.
- **Adds the `hub_widget` tool.** The agent can draw cards, charts, tables,
  calendars, weather, checklists, timelines, polls, forms and shopping
  cards in the thread. The catalog matches the app's parser
  (`app/src/chat/widget.ts`), and a test fails if the two drift.
- **Feeds Automations.** It posts every scheduled job and every run file from
  `$HERMES_HOME/cron/` to the hub, silent runs included, and files
  `deliver=hub:<thread>` cron output under the job that produced it.
- **Pushes the command catalog.** The app's `/` picker gets the gateway's live
  commands, skills, aliases and plugin commands.
- **Serves subagent transcripts.** When you open a subagent card, the plugin
  reads that child session read-only out of `$HERMES_HOME/state.db`.

It needs only the standard library and makes no outbound calls except to the hub
(`HUB_API_BASE`).

## Tested with

Hermes Agent **0.21.5**. The plugin was developed and is run against a 0.21.5
gateway. On 2026-10-06 it was smoke-tested on the stock `nousresearch/hermes-agent`
image (Hermes 0.21.5: image tag `v2026.9.24`, upstream `f97608f1`), installed exactly
as below. It loaded,
pushed the command catalog, answered the authenticated ping, and carried a real
message from the hub's chat API through the gateway to a model and back into
the thread. It reaches into a few gateway internals that are not a stable API (the
runner's session store, the approval and clarify queues). A gateway upgrade
should be followed by the verify steps below. Older gateways (0.20.x) are
untested.

## Install on a stock Hermes Agent

`$HERMES_HOME` is the gateway's home: `~/.hermes` by default, or whatever
`HERMES_HOME` is set to (the Docker image uses its data volume). Run the
commands below from the repository root.

**1. Copy the plugin.** Use the directory name `hub-platform`, since the plugin
key comes from the path.

```sh
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HERMES_HOME/plugins"
cp -r hermes-plugin/hub-platform "$HERMES_HOME/plugins/hub-platform"
```

**2. Give Hermes the hub's shared key.** `./install.sh` already created it at
`./data/hub-platform/HUB_PLATFORM_KEY` on the host, which is
`/data/hub-platform/HUB_PLATFORM_KEY` in the container (`HUB_PLATFORM_KEY_FILE`
moves it). The hub reads it from that file only, never from its environment.
Copy the same key to Hermes; minting a new one would leave the two sides
mismatched:

```sh
printf 'HUB_PLATFORM_KEY=%s\n' "$(cat ./data/hub-platform/HUB_PLATFORM_KEY)" >> "$HERMES_HOME/.env"
```

Running the hub without `install.sh`? Create the file first, readable by the hub
container's user (`HUB_UID`):
`mkdir -p ./data/hub-platform && (umask 077; openssl rand -hex 32 > ./data/hub-platform/HUB_PLATFORM_KEY)`.

**3. Gateway environment** (`$HERMES_HOME/.env`):

```ini
# The gateway API server is what the hub calls (POST /api/platforms/hub/events).
# Stock Hermes starts it only when this key is set; generate a strong one.
API_SERVER_KEY=<openssl rand -hex 32>
# API_SERVER_HOST=127.0.0.1     # default; see "Network" below
# API_SERVER_PORT=8642          # default

HUB_API_BASE=http://127.0.0.1:8090   # where the hub server listens
HUB_PLATFORM_KEY=<the key from step 2>

# Every hub message reaches the gateway as one fixed user. Authorise it:
HUB_ALLOWED_USERS=hub-user           # must equal HUB_USER_ID (default hub-user)
HUB_USER_NAME=Your Name              # the name the agent addresses; default "User"

# Recommended: the default thread for cron jobs that deliver to plain `hub`.
# Without it, stock Hermes answers your first message with a "No home channel is
# set for Hub" notice instead of a reply.
HUB_HOME_CHANNEL=ops
```

If Hermes runs in Docker, `127.0.0.1` is the Hermes container itself, not the hub.
Attach Hermes to the hub's Compose network (`<checkout folder>_bridge`, so
`xavier_bridge` by default), set `HUB_API_BASE=http://hub-api:8090`, and add
`hub-api` to the hub's `HUB_ALLOWED_HOSTS`; any other host name gets a 421.

**4. Gateway config** (`$HERMES_HOME/config.yaml`). Merge these into your
existing top-level blocks; don't append a second `plugins:` or `platforms:` key.
`hermes plugins enable hub-platform` writes the `plugins.enabled` entry for you.

```yaml
platforms:
  hub:
    enabled: true

plugins:
  enabled:
    - hub-platform
  stream_reasoning_deltas: true    # without it, reasoning never streams to the app

display:
  platforms:
    hub:                           # the app renders its own streaming, cards and progress
      streaming: false
      interim_assistant_messages: false
      tool_progress: "off"         # quoted: bare off is a YAML boolean
      long_running_notifications: false

# Optional. If you pin a toolset list for hub, keep `hub` in it (that toolset is
# hub_widget) and `clarify` (questions as buttons). Mirror what your other chat
# platforms get, for example:
platform_toolsets:
  hub: [hub, clarify, web, file, terminal, memory, session_search, skills,
        todo, delegation, cronjob, vision]
```

**5. Hub environment** (the hub's `.env`):

```ini
HERMES_API_BASE=http://<gateway address>:8642   # the gateway API server, as the hub container sees it
HERMES_API_KEY=<the gateway's API_SERVER_KEY>   # used for the hub's other gateway reads
```

**6. Restart the gateway** with `hermes gateway restart`, or however you run it.

### Network

Both directions are plain HTTP, and the bearer key is their only
authentication. Keep the gateway and the hub on loopback or a private network.
Each side must reach the other: the gateway reaches `HUB_API_BASE`, and the hub
reaches `HERMES_API_BASE`. If the hub runs in Docker and the gateway runs on the
host, `127.0.0.1` inside the container is not the host. In that case, point
`HERMES_API_BASE` at an address the container can route to, and bind the
gateway API server there (`API_SERVER_HOST`), never on a public interface.
Stock Hermes logs a warning when its API server listens beyond loopback while
the terminal backend is `local`. It is right to. Keep that network private, and
consider `terminal.backend: docker` or a narrow `platform_toolsets.hub`.

## Verify

```sh
# 1. The plugin loaded. About 20 s after start the gateway logs
#    "hub-platform: pushed N commands to hub-api" in $HERMES_HOME/logs/
#    (a Docker container's stdout shows warnings only). The table truncates
#    names unless the terminal is wide.
COLUMNS=200 hermes plugins list | grep hub-platform

# 2. The events route answers with the shared key, and refuses without it.
curl -s -X POST http://127.0.0.1:8642/api/platforms/hub/events \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"kind":"ping"}'
# -> {"ok": true, "connected": true, "queue": {...}}
# 401: the keys differ, or the gateway has none. 503 platform_unavailable:
# the hub platform is not enabled or not connected.
```

Then send a message from the app. The reply should stream into the thread.
`$HERMES_HOME/hub-platform/observer.jsonl` records every hook the plugin saw.
Records with `"forwarded": true` were sent to the hub, and the gateway log says
`hub-platform delivery … failed` (at most once a minute) when the hub is
unreachable.

The tests run on any Python 3 with no dependencies. With the server's
requirements installed they also check every request body against the
server's own models:

```sh
python3 -m unittest discover -s hermes-plugin/hub-platform -p 'test_*.py'
```

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `HUB_API_BASE` | `http://127.0.0.1:8090` | Where the hub server listens |
| `HUB_PLATFORM_KEY_FILE` | unset | A key file, re-read on every request (rotate without a restart). Wins over `HUB_PLATFORM_KEY` |
| `HUB_PLATFORM_KEY` | unset | The shared key. If neither is set: `$HERMES_HOME/hub-platform/HUB_PLATFORM_KEY` |
| `HUB_USER_ID` / `HUB_USER_NAME` | `hub-user` / `User` | The gateway user every hub message comes from |
| `HUB_ALLOWED_USERS` / `HUB_ALLOW_ALL_USERS` | unset | The `hub` platform's allowlist, like `TELEGRAM_ALLOWED_USERS`. Unset falls through to `GATEWAY_ALLOWED_USERS` and pairing |
| `HUB_HOME_CHANNEL` | unset | Default thread for `deliver=hub` cron jobs |
| `HUB_CRON_DIR` | `$HERMES_HOME/cron` | Jobs and run files fed to Automations |
| `HERMES_STATE_DB` | `$HERMES_HOME/state.db` | Read-only, for subagent transcripts |
| `HUB_PLATFORM_OBSERVER_DIR` | `$HERMES_HOME/hub-platform` | Observer log (rotates at `HUB_PLATFORM_OBSERVER_MAX_BYTES`, 5 MiB, one backup) |
| `HUB_CATALOG_PUSH_DELAY_S`, `HUB_CRON_FEED_POLL_S`, `HUB_CRON_FEED_START_DELAY_S`, `HUB_PLATFORM_STREAM_FLUSH_CHARS` | 20, 30, 25, 48 | Timing and batching |

## Known limits

- **Single user.** Every hub message reaches the gateway as one user
  (`HUB_USER_ID`). The hub authenticates people; the gateway authenticates the
  hub.
- **Queue / Steer / Redirect.** The app sends the composer's chip with each
  message, but stock Hermes applies `display.busy_input_mode` to every message
  and ignores a per-message choice. Honouring the chip takes a gateway patch
  that is not part of this repo.
- **Files the agent sends.** The hub's media route currently takes images only.
  A document arrives as a file chip that names where it was saved on the
  gateway host, not as a download.
- **What leaves the gateway.** The plugin sends the hub every Hub turn's text,
  reasoning, tool calls (redacted, bounded) and subagent summaries, plus the
  output of every scheduled job, including jobs that never message anyone.
- **The observer log** writes one small line per hook call on every platform,
  not just the hub, capped at about 10 MB.
- **No `flow` widget.** The plugin can describe diagrams, but the app in this
  repo has no parser for them, so the tool does not offer one.

## License

MIT. See [`LICENSE`](../../LICENSE) at the repository root.
