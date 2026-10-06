# Changelog

All notable changes to Xavier are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- **Live voice chat.** A Live page, opened from a card on Home, for hands-free
  conversation with Xavier. The phone streams its microphone to the hub
  (`/api/live`), the hub streams it to Deepgram's Flux speech-to-text, each
  finished turn goes into a pinned "Live" thread like a typed message, and the
  reply is spoken back through Flux text-to-speech as Hermes writes it, with a
  short acknowledgement while Xavier works. Needs `DEEPGRAM_API_KEY` on the server;
  without it the page says voice is not set up. See
  [docs/FEATURES.md](docs/FEATURES.md#live-voice-chat) and
  [docs/SERVICES.md](docs/SERVICES.md#live-voice-deepgram).
- A native audio module (`app/modules/live-audio`) that runs Live on Apple's
  voice processing, so you can talk over a reply. The `react-native-audio-api`
  engine stays as a fallback without echo cancellation, switchable over the air
  (`app/src/lib/live/aec.ts`). Both are native code, so Live needs a new app
  build rather than an over-the-air update.
- On the native engine, a Mic Mode button on the Live page opens iOS's picker,
  where Voice Isolation keeps other voices out; a build whose native module
  predates it shows no button.
- `LIVE_VP_BYPASS` in `app/src/lib/live/aec.ts`, an over-the-air A/B switch that
  bypasses voice processing to hear whether it changes how Xavier sounds. It
  ships off.
- Each committed Live turn's log line carries an echo score: how much of it
  matched what Live said in the last 10 seconds.
- Live no longer takes Xavier's own voice for a turn when some of a loud
  speaker leaks past echo cancellation: speech that starts during a reply, or
  just after it, is dropped if it mostly repeats what he just said, and
  mid-reply an interruption takes two real words or a stop word.
- On the native engine, the audio session asks for 48 kHz before it activates,
  so that turning voice processing on does not renegotiate the route and
  restart the engine, which threw away what the echo canceller had learned.
  Voice processing's automatic gain is off: it raised the leftover echo after a
  pause. Each reply logs the mic level while Xavier spoke against the level
  while he was quiet.

### Changed

- The terminal's WebSocket `Origin` check now guards the Live socket too
  (`_ws_origin_ok` in `server/app.py`).
- `websockets` is a direct server requirement; it used to arrive only through
  `uvicorn[standard]`.
- The iOS Face ID and microphone purpose strings name Xavier.
- The body of `POST /api/chat/threads/{id}/send` moved into a helper that the
  Live socket shares; typed sends behave as before.

## 0.1.0 — first public release

The first public cut of the repository. Everything below ships in it.

### The server (`server/`)

- A self-hosted FastAPI server ("the hub") that runs in Docker, publishes on
  `127.0.0.1:8090` by default, and keeps everything it stores in one data
  directory.
- A one-command installer (`./install.sh`) that checks prerequisites, creates
  `.env` with mode 600, builds and starts the server, and waits for its health
  check, with subcommands for start, stop, restart, update, logs, status,
  pairing and uninstall.
- Phone pairing with a one-time six-character code minted on the server
  (`./install.sh --pair`), over a local unix socket.
- A write gate on state-changing calls: the server issues a challenge, the
  phone signs it with a key held in its Secure Enclave (or a passkey signs it),
  and the change is applied only after verification. SECURITY.md lists the few
  writes that use another credential, or none.
- Face ID sessions in front of chat and the terminal, and a `Host` allowlist
  (`HUB_ALLOWED_HOSTS`) against DNS rebinding. Most other reads are protected by
  the network boundary alone; [SECURITY.md](SECURITY.md) lists them.
- Durable chat threads, approvals, automations, the daily brief reader, a
  calendar snapshot reader, a read-only file browser, a decision inbox, push
  notifications through Expo, iMessage drafts approved with Face ID, and the
  routes the Hermes plugin talks to.

### The app (`app/`)

- A native iOS app built with Expo and React Native: chat with streamed
  replies, stopping a running turn, photo attachments, approval cards, and
  native widgets (cards, metrics, charts, tables, checklists, calendars,
  timelines, weather, shopping cards, and more).
- Automations, the daily brief, calendar views, Ops and System panels, and a
  terminal over xterm.js with a tmux shell picker (these two need ttyd and
  hub-tmuxd on the host; the `host/` kit sets them up).
- A runtime server field (**Config → Server address**) and pairing under
  **Config → Security**.
- Build identity from the environment (`EXPO_OWNER`, `IOS_BUNDLE_IDENTIFIER`,
  `EAS_PROJECT_ID`), and over-the-air updates through `scripts/ota-publish.sh`,
  which refuses to publish on a runtime mismatch and verifies delivery.

### The Hermes plugin (`hermes-plugin/hub-platform/`)

- The hub-platform plugin for Hermes Agent, which carries chat, automation
  sync and transcripts between Hermes and the hub.

### Optional sidecars

- `hub-bridge/`: an opt-in, key-authenticated sidecar that runs an allowlisted
  set of Hermes CLI commands for the config, cron, skills and other agent panels.
- `host/`: a kit that sets up the terminal (ttyd) and the Claude Code shell
  manager (hub-tmuxd) on your host, with private sockets and hardened systemd
  units.

### Documentation

- Setup, per-host install guides, connecting the app, mesh options, services,
  features, privacy, security, publishing your own build, and troubleshooting.

### Not yet built

- Home Assistant control (the apply route returns 501), interactive button,
  poll and form replies in chat, and a public app build. See the Roadmap in
  [docs/FEATURES.md](docs/FEATURES.md).
