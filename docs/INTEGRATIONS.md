# Integrations: what ships here vs what you must already run

Xavier is the **hub server, the app, and a Hermes plugin**. It contains the code
that *talks to* several optional services, but it bundles **none** of the
services themselves. Everything external is yours to run, or to skip: the hub
works without it.

`hub-api` starts with every integration unset. Panels that depend on a service
you have not configured show a 503 or an empty card rather than crash.

## What ships in this repository

- `server/`: the hub (FastAPI), with the client code for every integration below.
- `app/`: the iOS app.
- `hermes-plugin/hub-platform/`: the plugin you install into Hermes so chat,
  automations and transcripts reach the hub
  ([README](../hermes-plugin/hub-platform/README.md)).
- `scripts/`: mesh setup, over-the-air publishing, an example WeatherKit
  connector, and the publish gate.

## What you run yourself

| Piece | What it unlocks | Without it |
|---|---|---|
| **Hermes Agent** (Nous Research), with the plugin | Chat answers, automations, session transcripts, memory status | An empty chat tab and empty agent panels |
| **hub-bridge** sidecar (`hub-bridge/`, opt-in) | The config, cron, skills, plugins, MCP, memory, doctor and spend panels, and settings changes from the app | Those panels show an empty state |
| **ttyd** and **hub-tmuxd** on the host (`host/` kit) | The terminal and the shell picker | The terminal is unavailable; the picker shows an error line |
| Your own cron jobs or scripts | Health and backup status, the calendar snapshot, the daily brief, decision cards | Those panels show an empty state |
| An iMessage MCP server on your Mac | iMessage drafts you approve in the app | No drafts |
| A Deepgram account (`DEEPGRAM_API_KEY`) | Live voice: speech-to-text and the spoken replies | The Live page says voice is not set up |

The full catalogue, with the exact environment variables the server reads, what
each service requires, and a copy-pasteable `.env` block for each, is in
**[SERVICES.md](SERVICES.md)**.

The big one is Hermes. The hub is deliberately a *thin, unprivileged* service: it
holds no docker socket. It calls Hermes directly over HTTP for chat and
transcripts, and asks the hub-bridge sidecar to run Hermes CLI commands for the
config, cron and skills panels. That sidecar ships in this repository as an
opt-in piece (`hub-bridge/`), so you can audit its allowlist yourself; see
[SERVICES.md](SERVICES.md#hub-bridge-sidecar). Without Hermes, treat the hub as a
private dashboard rather than an assistant. That standalone mode is a supported
configuration, not a degraded one (see "Start with nothing" in SERVICES.md).

## Configuring any integration

1. Put the value in `.env` (never in a tracked file; `.env` is gitignored).
2. Apply it: re-run `./install.sh`, or `./install.sh --restart`, which recreates
   the container with the new `.env`.
3. Confirm: `./install.sh --status`, then open the relevant panel in the app.

Leave a setting blank to disable that integration entirely. A blank value is the
supported "off" state, not an error.
