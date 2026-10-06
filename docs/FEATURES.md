# Features

What Xavier lets you do, and the one-line mechanism behind each claim, checked
against the code in this repository. Each section says what it depends on. Pieces
marked **outside this repo** are programs or jobs you run yourself:

- **Hermes Agent** (Nous Research), the agent runtime, with the **hub-platform
  plugin**. The plugin's source is in this repository
  ([hermes-plugin/hub-platform](../hermes-plugin/hub-platform/README.md)); Hermes
  is not.
- **ttyd**, the terminal server, from your package manager. hub-tmuxd, behind
  the shell picker, and the units that run both ship in this repository
  ([host/](../host/README.md)).

The **hub-bridge** sidecar that runs Hermes CLI commands for the config, cron,
skills, plugins, MCP, memory, doctor and spend panels **ships in this repository**
([hub-bridge/](../hub-bridge/README.md)); it is opt-in and authenticated.
- The cron jobs or scripts that write the files some panels read (health log,
  backup status, calendar snapshot, daily brief).

Anything not yet built is under [Roadmap](#roadmap-not-built-yet) at the end.

## Chat with your assistant, in a native app

**Needs:** Hermes with the hub-platform plugin, and a paired phone.

- **Talk to Xavier, your assistant, from your phone.** You type (or attach
  photos), the message goes to your own server, the server forwards it
  to Hermes through the hub-platform plugin, and the reply streams back into a
  native iOS app built on Expo and React Native (`app/app/chat/`,
  `server/chat/routes.py`, `server/chat/platform.py`).
- **Locked behind Face ID.** Reading or sending chat needs a session cookie that
  only a fresh device-key or passkey assertion can mint: Face ID on a paired
  phone (`server/chat/session.py`).
- **Real threads, not a toy transcript.** Threads are durable and server-side
  (`server/chat/store.py`): pin, rename, archive, unread cursors, and a
  "what needs me" inbox across every thread (`GET /api/chat/attention`).
- **Stop a running turn.** While the assistant is working you can stop the
  turn outright (`POST /api/chat/threads/{id}/stop`, which the plugin turns into
  Hermes's own `/stop`). The composer also offers queue, steer or redirect for a
  message sent mid-turn, but stock Hermes applies its own `busy_input_mode` to
  every message and ignores that choice; honouring it takes a Hermes patch that
  is not in this repository.
- **The assistant can ask before acting.** A clarify widget parks the turn on a
  question; your answer is delivered back to the agent as the tool's own result
  (`POST /api/chat/clarify/{id}`).
- **Approvals where it matters.** Actions that need a human decision arrive as
  approval cards, and your yes/no batch is a Face ID gated write
  (`server/chat/approval.py`). An iMessage draft is sent only after you approve
  it: with Face ID on its approval card or in the Decision Inbox, or from Discord
  if you set up Discord approvals.
- **Photo attachments.** Photos (up to four per message, PNG, JPEG, WebP or GIF)
  upload as media ids before the message that carries them
  (`POST /api/chat/threads/{id}/media`). The server's media route takes images
  only, so other file types cannot be attached yet.

## Live voice chat

**Needs:** Hermes with the hub-platform plugin, a paired phone, and a Deepgram
API key on the server (`DEEPGRAM_API_KEY`). Without the key the Live page says
voice is not set up and nothing is sent to Deepgram.

- **Talk instead of typing.** The Live page, opened from a card on Home, streams
  your microphone over a websocket to your server (`/api/live`,
  `server/live_session.py`), which streams it on to Deepgram's Flux
  speech-to-text (`server/live_deepgram.py`). Flux decides when you have finished
  a turn; the server waits a further second, so a pause mid-sentence does not
  split one turn into two, then sends the turn into the thread exactly like a
  typed message (`send_user_text` in `server/chat/routes.py`). If Hermes does not
  take it, Live says so rather than waiting. The socket needs the Face ID chat
  session.
- **Replies spoken as they are written.** The reply's text streams from the
  thread into Flux text-to-speech and back to the phone as audio, with the words
  on screen as they play. Only reply text is read aloud: never reasoning, tool
  calls or Hermes's busy notices (`server/live_reply.py`). A short
  acknowledgement ("Okay.", "Got it.") plays while Xavier works, and a soft tone
  repeats while he thinks.
- **Talk over him.** On a build with the native audio module
  (`app/modules/live-audio`), Apple's voice processing cancels the speaker's
  echo, so speech that starts during a reply turns it down, a couple of real
  words cut it off, and the rest of that reply stays unsaid; a lone "mm-hm" is
  not taken as a turn. On that engine a button on the page also opens iOS's Mic
  Mode picker, where Voice Isolation keeps other people's voices out. A tap on
  the dots stops the speech and, while Xavier is still working on the reply, the
  turn too (`/stop`, as in chat). On the fallback engine
  (`react-native-audio-api`, chosen in `app/src/lib/live/aec.ts`) there is no
  echo cancellation, so speech that starts while Xavier talks is ignored as his
  own voice. Talking over a turn that is still running asks Hermes to redirect
  it; stock Hermes applies its own `busy_input_mode` instead, as with the
  composer's choice above.
- **One running conversation.** Voice turns land in a pinned "Live" thread that
  is named after the first real thing you say ("Live · …"), so the transcript is
  on the page and in the Chat list (`app/src/chat/liveThread.ts`). "New session"
  starts a fresh thread.
- **Hands-free.** A session keeps running with the screen locked (the build
  carries iOS's background audio mode), pauses for a phone call or Siri, follows
  headphones coming and going, and ends itself after four quiet minutes. Voice,
  speed and expressivity are in the page's settings sheet; a new setting applies
  to the next session.

## Rich custom widgets in chat

A reply is not limited to plain text. The assistant can emit structured `widget`
parts that the app draws as native UI (`app/src/components/chat/widgets/`). The
kinds this build draws:

| Widget | What it renders |
|---|---|
| `card` | A titled card with labelled rows |
| `metric` | A single number with a delta and tone |
| `chart` | A bar or line chart drawn natively |
| `table` | Column-aligned tabular data |
| `progress` | A labelled progress bar |
| `checklist` | A tickable list; ticking persists into the widget so every client reads the same state (`POST /api/chat/threads/{id}/checklist`) |
| `calendar` | A date grid for schedules and ranges |
| `timeline` | A timestamped event log |
| `weather` | Conditions, temperature bars, and forecast strips |
| `link` | A tappable link card |
| `product`, `cart`, `order` | A product card, a basket, and a receipt. Product photos load straight from the URL the agent gives |
| `form` | A form with text, number, and textarea fields. In chat it is display-only: Submit sends nothing yet |
| `button_row` | A row of buttons. These render disabled, because the reply route they would call does not exist yet |
| `poll` | A poll. Also disabled, for the same reason |
| `clarify` | An inline question you answer in place; the thread resumes with your answer |

Widgets the current build cannot draw are not silently dropped: the transcript
shows a one-line "could not draw this" notice (`parseWidget` returning null), so
a message never disappears into a hole.

## Terminal and shells on your own machine

**Needs:** the host kit ([host/](../host/README.md)): ttyd from your package
manager, and hub-tmuxd from this repository, installed as systemd units by
`sudo host/install.sh` on Linux (on macOS, two LaunchAgents you load by hand) and
connected to the hub with
`host/compose.host.yml` (`HUB_TTYD_SOCK`, `HUB_TMUXD_SOCK`). Without it the
terminal stays unavailable and the picker shows an error line. It is a real,
writable shell as your user, behind Face ID; read the kit's risk section first.

- **A real terminal over your mesh.** The terminal (under Ops) unlocks with Face ID, which
  mints a short-lived cookie, and opens a streaming terminal: xterm.js in a
  WebView, over a ttyd WebSocket that your server proxies (`server/app.py`,
  terminal proxy; `app/src/terminal/`). ttyd listens on a unix socket rather than
  a port, in a directory only you and the hub can enter, so nothing extra is
  exposed. Sessions reconnect with backoff, re-lock when they expire, and pause
  output with flow control.
- **List, start and stop tmux sessions.** The shell picker
  (`app/src/terminal/SessionPicker.tsx`) lists tmux sessions from hub-tmuxd;
  reading that list needs the terminal session. Spawn and kill are Face ID gated
  writes (`tmux.spawn`, `tmux.kill`) that the server validates
  (`_validate_tmux_request` in `server/app.py`) and forwards to hub-tmuxd, which
  starts Claude Code in a new `claude-*` tmux session (no permission-bypass flag
  unless you opt in) and hands back an attach command that the terminal offers
  as a tap-to-fill. The API has room for several hosts; the kit's hub-tmuxd
  manages the machine it runs on.
- **Resume a past Claude Code session.** The picker lists recent Claude Code
  transcripts from hub-tmuxd (`GET /api/tmux/history`: titles, ids and times)
  and relaunches one by its session id. hub-tmuxd starts it in the directory the
  transcript was recorded in, and only if that directory is inside the roots you
  allow (`XAVIER_CWD_ROOTS`, your home by default); a transcript already open in
  a running Claude Code is not opened twice.
- **Runbooks instead of memorised commands.** The key bar offers one-tap
  commands in three groups, Host, Docker and Logs
  (`app/src/terminal/Runbooks.tsx`). Tapping one fills the composer for your
  review; nothing executes on tap. They are generic examples, meant to be
  edited to match your machine.

## Automations

**Needs:** Hermes with the hub-platform plugin, which syncs scheduled jobs and
their runs into the hub (`/api/platform/hub/automations/*`).

- **See every scheduled job and what it last said.** The Automations tab lists
  your jobs grouped into "needs you", new, earlier, and quiet, with a per-run
  timeline (`app/app/automations/`, `server/chat/automations.py`). Like chat, it
  needs the Face ID chat session.
- **Runs that repeat themselves get folded.** Jobs whose latest runs failed the
  same way cluster into one row, so ten identical failures read as one problem.
- **Control noise per job.** Set a job to push, stay quiet, or mute, snooze it,
  or mark runs read, individually or all at once.
- **Opening a run opens a thread.** A run's output can be continued as a chat
  conversation; opening it makes sure the thread under it exists.

## Daily brief

**Needs (outside this repo):** something that writes
`briefing-YYYY-MM-DD/brief.json` under `MY_PAGES_ROOT`, usually a scheduled
Hermes job you write. This repository has the reader, not the generator.

- **One page for your morning.** The brief (on Home) renders the day's brief
  (`GET /api/brief`), falling back to the most recent one within five days and
  saying so.
- **Swipe-level control without Face ID.** Dismiss, snooze, or undo an item, mark
  it useful, or attach a note. These writes are gated by a per-item token (an
  HMAC over the date and item id, keyed by `HUB_BRIEF_DISMISS_KEY_FILE`) that the
  brief writer computes, because a swipe should not need Face ID. The token
  travels inside the brief, so it stops only callers who cannot read the brief.
- **Standing rules you can edit.** Adding or removing a rule is a Face ID gated
  write to `HUB_BRIEFING_RULES`; your generator decides what to do with them.

## Calendar

**Needs (outside this repo):** a job that writes a calendar snapshot to
`HUB_CALENDAR` and acts on the sync-request file beside it.

- **Your week at a glance, read-only.** The calendar (on Home) reads the snapshot
  for any range up to 62 days (`GET /api/calendar`, from `server/hub_calendar.py`),
  and marks
  days whose sync is stale.
- **Ask for a fresh sync.** `POST /api/calendar/sync` leaves a request file for
  the host job; a repeat while one is pending changes nothing.

## Files

- **Browse and read files on your server.** The Files surface lists the roots you
  configure and lets you browse and read within them
  (`GET /api/files/roots|browse|read`, `server/files.py`). Traversal and symlink
  escapes are rejected, dotfiles and credential-looking files are never served,
  and reads are capped at 256 KB. These reads are not authenticated, so only
  configure roots you are happy for your network to see.

## Push notifications

**Needs:** notifications allowed on the phone. Delivery goes through Expo's push
service (`exp.host`) and Apple's; the Apple push key lives with your Expo
project's credentials (set it up once with `npx eas-cli credentials -p ios`;
builds from this repository never prompt for it), and the
server holds none.

- **The hub reaches you when something finishes.** A finished chat reply, or an
  automation's report, arrives as a push notification carrying the thread title
  (or job name) and the first ~140 characters of the text (`server/chat/notify.py`).
- **Push respects presence.** The app reports whether you are looking at it, and
  the server uses that (with its own staleness rule) to skip a push you would
  not need.
- **Registration is a Face ID gated write.** The phone's push token is
  registered through the device-key gate, with the challenge bound to the token
  (`POST /api/push/register`), so a captured proof cannot redirect your
  notifications.

## Memory and status, glanceable

- **Memory status at a glance.** The Config area shows which memory provider the
  assistant uses and which memory plugins are installed (`GET /api/memory`), read
  from Hermes
  through the hub-bridge sidecar ([hub-bridge/](../hub-bridge/README.md)).
- **System health, backups, costs, and spend.** The Ops area shows health checks
  and restic backup status (from files your own cron jobs write to
  `HUB_LOG_DIR`), cron run logs and costs, spend summaries and a doctor report
  (through the hub-bridge sidecar), and your OpenRouter credit balance (from
  `OPENROUTER_API_KEY`). Each panel shows an empty state or a 503 when its
  source is not configured, instead of erroring.
- **A Decision Inbox.** Decisions the assistant parks as files in
  `HUB_DECISIONS_DIR` arrive as cards; answering one is a Face ID gated write.

## Privacy and self-hosting

- **Your server holds your data.** Xavier is the server plus the app. You run the
  server on a box you control, reached over a private network or mesh. There is
  no Xavier cloud. What does leave the machine (your model provider, Expo and
  Apple for push, EAS Update, Deepgram for Live voice) is listed in
  [the README](../README.md#privacy--plainly) and [PRIVACY.md](PRIVACY.md).
- **Chat needs Face ID; most other reads need only the network, and that is
  stated plainly.** Anything that can reach the server can read its
  unauthenticated surface, agent transcripts included; see
  [SECURITY.md](../SECURITY.md).
- **Writes fail closed.** State-changing calls go through a challenge, sign,
  apply gate (the few exceptions, and what guards them, are under
  [Other ways in](../SECURITY.md#other-ways-in)): the phone signs with a key held in its Secure Enclave, paired
  through a one-time code minted from the server's shell (`./install.sh --pair`)
  or by a passkey-gated action. With no signer registered, the server refuses
  with a 412 before any proof is checked. A signature proves possession of the
  Enclave key, not that Face ID itself matched.
- **The server is deliberately thin and unprivileged.** It holds no docker
  socket. It calls Hermes directly over HTTP for chat and transcripts, and asks
  the hub-bridge sidecar ([hub-bridge/](../hub-bridge/README.md)) to run a fixed,
  allowlisted set of Hermes CLI commands for the config, cron and skills panels.
  The sidecar holds the privilege instead, authenticates the hub with a shared
  key, and enforces its own read/write allowlist — its source is in this repo, so
  you can audit it.
- **Degrades, never fakes.** Panels backed by services you have not configured
  show an honest empty state rather than invented data.

## Models

- **Models are Hermes's choice.** Which model answers, and through which
  provider, is set in Hermes's configuration. OpenRouter is a common choice
  there, with many models behind one key, billed to your own account.
- **The hub's OpenRouter key is read-only bookkeeping.** `OPENROUTER_API_KEY`
  (and the optional `OPENROUTER_MGMT_KEY`) are used only to show credits, key
  usage and per-model activity in the cost views. The hub never sends a prompt
  through them. Leave them blank and those views stay empty.
- **Change settings from the phone.** The Config area can change Hermes settings
  (`config.set`, a Face ID gated write) through the hub-bridge sidecar.

## Roadmap (not built yet)

- **Home Assistant control.** `server/ha_actions.py` has a passkey-gated
  challenge and an apply that logs what it would do (`HA_LIVE_APPLY=false`). A
  live apply returns 501, nothing in the app proposes Home Assistant actions,
  and no Home Assistant status is shown.
- **Interactive `button_row`, `poll` and `form` replies.** All three render, but
  the routes that would carry a press, a vote or a submission back to the agent
  do not exist yet (see `app/src/components/chat/widgets/index.tsx`).
- **Shells on other machines.** The picker can show several hosts, but the
  kit's hub-tmuxd only manages its own; reaching another machine (over ssh, say)
  is not built.
- **Voice samples in Live settings.** The voice list has no way to hear a voice
  before choosing it; the settings body can show a sample button per voice, but
  nothing plays samples yet, so the button is not shown.
