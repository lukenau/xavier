# Hub demo mode

Run the Xavier app with **zero personal data**. A stub "hub-bridge" answers
every CLI/gateway call with canned, entirely fictional data, and a seed script
writes every cache/store file the app reads. Nothing here touches the real hub
(ports 8090/8091), the real data dirs, Docker, or the network beyond loopback.

```
demo/
  bridge.py        stub hub-bridge + fake Hermes gateway (127.0.0.1:8096)
  seed.py          writes all fake caches/stores under demo/data (DEMO_ROOT)
  start-demo.sh    seeds, starts bridge + hub-api, waits for readiness
  stop-demo.sh     takes a running demo down
  README.md        this file
```

## Run it

Needs Python 3.10 or newer with the server's dependencies, and `curl`. The script
uses `server/.venv` when it exists, so the simplest setup is:

```bash
cd <repo>
python3 -m venv server/.venv && server/.venv/bin/pip install -r server/requirements.txt
./demo/start-demo.sh          # seeds, starts both, waits, keeps running
# Ctrl-C stops both processes
```

Then point the app at `http://127.0.0.1:8095` (hub-api). That works from the iOS
Simulator on the same Mac; a phone needs an `https` address
([CONNECT-APP.md](../docs/CONNECT-APP.md)). Or just curl:

```bash
curl -s http://127.0.0.1:8095/api/health
curl -s http://127.0.0.1:8095/api/brief
curl -s http://127.0.0.1:8095/api/cron
```

Override the root with `DEMO_ROOT=/path/to/hub-demo ./demo/start-demo.sh`. The API
binds `127.0.0.1:8095` (the stub bridge `127.0.0.1:8096`); nothing is exposed
off-box. Like the real server, it answers only to `localhost`, `127.0.0.1` and the
hostname in `HUB_ORIGIN` (plus any in `HUB_ALLOWED_HOSTS`).

## What the demo shows

`seed.py` writes fictional content for every read surface, and `bridge.py`
serves fictional CLI output for the bridge-backed ones:

- **Home** — health strip (5 up / 1 degraded), agent roster, activity, feed
  (brief + cron runs + inbox cards + status line), vitals.
- **Brief** — a rendered `briefing-<today>/index.html` with dismissable
  `<!--dz:…-->` cards plus a matching `brief.json` (buckets now/today/week/
  background) for the native app. Serve-time dismiss filtering works end to end.
- **Ops** — cron board (4 jobs, incl. paused + no-agent), cron costs, cron logs,
  kanban columns + tasks.
- **Cost** — spend summary/timeseries (fake dollars) from a five-model ledger with
  a believable week, plus recurring subscriptions.
- **System** — config (curated + full tree), advisor preset, skills, plugins,
  MCP servers, connectors, doctor, memory, pairing.
- **Chat** — 5 fictional threads in a real `chat.db` built with `ChatStore`:
  "Trip planning with Xavier", "Home projects", "Demo hub tour", "Widget gallery"
  (nearly every widget kind this app draws, all but the clarify prompt, grouped
  with lead-ins) and
  "Ordering a demo pitcher" (the shopping kinds — product, basket, receipt, plus a
  single-use card request drawn with the card + button_row widgets — inside a real
  back-and-forth). Seeded turns carry a `run_id`, as the gateway's do.
- **Automations** — the four cron jobs and a few days of their runs, fed through
  the server's own `AutomationStore` as the plugin's sync would. The
  healthcheck's newest run is a warning, so one job needs you and the tab
  carries a badge; the paused backup job's failure is background.
- **Calendar** — a two-week snapshot at `HUB_CALENDAR` (events + fresh sync
  slices, so `stale_slices` is 0). Days are `HUB_TZ` days (UTC unless you set it).
- **Ops → Claude shells** — served by a stub host shell manager inside `bridge.py`
  (HTTP over `$DEMO_TMUXD_SOCK`, pointed at by `HUB_TMUXD_SOCK`): 3 fictional
  sessions across 2 hosts, with working kill/spawn, once the terminal is unlocked
  (the shell list needs the terminal session, like the shell itself). hub-tmuxd is
  a host daemon (the opt-in `host/` kit) the demo does not run, so without the
  stub those reads answer 503.
- **Decisions / Finance / Files** — seeded cards, snapshot, and a browsable
  demo root.

## The app's built-in demo

The iOS app has a demo mode of its own (`app/src/demo/`) that needs no server at
all. Its data is this seed: `app/scripts/demo-fixtures.py` builds the seed into a
temporary directory, runs the server in-process against it, and records what
every read the app makes returns, into `app/src/demo/fixtures.json`. Re-run it
after changing the seed:

```bash
server/.venv/bin/python app/scripts/demo-fixtures.py
```

The app demo leaves out the shopping thread, and lets writes succeed in memory
instead of refusing them.

## What is deliberately locked

Unless you export `HUB_ORIGIN`, the demo has **no origin, no passkey and no device
key**, so every write path refuses — the intended demo posture:

- Enrolment surfaces (`POST /api/passkey/register/options`, …) → **503
  `webauthn_unconfigured`**.
- WebAuthn/device-key-gated write challenges (`/api/action/*`,
  `/api/config/topics`, `/api/decisions/*/answer`, `/api/push/*`,
  `/api/briefing/rules.json`, chat approvals) → **412 `no_passkey`** ("enrol in
  Security first"). `POST /api/platform/hub/*` needs a bearer key that is not
  provisioned → 503.
- **Chat** — reads/writes under `/api/chat/*` are cookie-gated. With nothing
  enrolled, `/api/chat/bootstrap` answers **412 `no_passkey`**: the locked state.
- `/api/tmux/*` → **412 `no_passkey`** while nothing is enrolled (the reads need
  the terminal session cookie); after a terminal unlock, 200 from the stub host
  shell manager. With the stub's socket removed they answer 503, which is what the
  section shows when a real box has no hub-tmuxd running.
- `/api/cost/openrouter` → 404 (no OpenRouter key set).
- `OPENROUTER_API_KEY` / `OPENROUTER_MGMT_KEY` are explicitly unset so no real
  provider call can leak in.

`/api/briefing/dismiss` is ungated by design (it only hides the user's own
cards); a dismiss + undo round-trip is exercised in verification.

## Endpoints served (verified)

| Endpoint | Status | Fake content |
|---|---|---|
| `/api/health` | 200 | 6 fictional services, overall amber |
| `/api/agents` | 200 | Demo Agent, Demo Worker |
| `/api/schedules` | 200 | 3 demo schedules |
| `/api/skills` | 200 | 9 skills, 8 enabled, category tallies |
| `/api/activity` | 200 | 4 demo activity entries |
| `/api/feed` | 200 | brief + cron runs + inbox cards + status line |
| `/api/brief` | 200 | buckets now/today/week/background, 5 items |
| `/api/my-pages` | 200 | briefing + project-board pages |
| `/api/decisions` | 200 | 2 open + 1 answered card |
| `/api/finance` | 200 | demo snapshot |
| `/api/vitals` | 200 | agent up, spend + cron glance |
| `/api/sessions` | 200 | 3 fake sessions (fake gateway) |
| `/api/cron` | 200 | 4 demo jobs |
| `/api/kanban` | 200 | 8 tasks across columns |
| `/api/connectors` | 200 | auth + mcp catalogue |
| `/api/memory` | 200 | demo-memory provider |
| `/api/chat/bootstrap` | 412 | locked (no_passkey) — expected |
| `/api/audit`, `/api/backups` | 200 | access report, restic snapshots |
| `/api/config`, `/api/config/full`, `/api/advisor` | 200 | curated + full tree, preset |
| `/api/plugins`, `/api/mcp`, `/api/doctor`, `/api/pairing` | 200 | demo CLI tables |
| `/api/cron/costs`, `/api/cron/logs` | 200 | demo cost + run archive |
| `/api/spend/summary`, `/api/spend/timeseries`, `/api/cost/recurring` | 200 | fake spend |
| `/api/config/topics` | 200 | demo routing config + drift |
| `/api/files/roots`, `/api/files/browse` | 200 | demo roots |
| `/api/sessions/{id}`, `/api/sessions/{id}/messages` | 200 | fake transcript |
| `/api/push/devices`, `/api/passkey/status`, `/api/devicekey/status` | 200 | demo state |
| `/api/tmux/sessions`, `/api/tmux/history` | 412 | locked; after a terminal unlock, 3 fictional shells, 2 hosts |
| `/api/calendar` | 200 | two-week fictional snapshot, `stale_slices` 0 |
| `/api/cost/openrouter` | 404 | no key configured |

## Environment variables used

Set by `start-demo.sh` (and mirrored as defaults in `seed.py`):

`DEMO_ROOT`, `DEMO_API_HOST`, `DEMO_API_PORT`, `HUB_BRIDGE_URL`,
`HUB_BRIDGE_TIMEOUT_S`, `MY_PAGES_ROOT`, `HUB_LOG_DIR`, `HUB_ROSTER`,
`HUB_ACCESS_REPORT`, `HUB_ACTIVITY`, `HUB_SCHEDULES`, `HUB_SKILLS`,
`HUB_INBOX_DIR`, `HUB_DECISIONS_DIR`, `HUB_FINANCE_SNAPSHOT`,
`HUB_RECURRING_COSTS`, `HUB_MCP_WATCH_LOG`, `HUB_CHAT_DB`,
`HUB_CHAT_MEDIA_DIR`, `HUB_CHAT_SESSIONS_FILE`, `HUB_BRIEFING_DISMISSALS`,
`HUB_BRIEFING_FEEDBACK`, `HUB_BRIEFING_RULES`, `HUB_PUSH_TOKENS`,
`HUB_TOPICS_CONFIG`, `HUB_TOPICS_LIVE`, `HUB_FS_ROOTS`, `HERMES_API_BASE`,
`HERMES_API_KEY`, `HERMES_AGENT_ID`, `HERMES_AGENT_NAME`, `HUB_TZ`.

Passed through from your environment: `HUB_ORIGIN` (unset by default).
Deliberately **unset**: `OPENROUTER_API_KEY`, `OPENROUTER_MGMT_KEY`.
