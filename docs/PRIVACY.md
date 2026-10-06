# Privacy

This page describes what the software in this repository does with data. It is
written about the code, so you can check every claim against the source. It is
not a privacy policy for any service, because this project does not operate a
service. See the end of the page for what that means if you offer one.

## What leaves your machine

There is no Xavier cloud and no account system. The server has no telemetry,
analytics or phone-home: it reports nothing about usage, crashes or versions to
the project or to anyone else. The app contains no analytics or crash-reporting
SDK (you can confirm that in `app/package.json`).

Data leaves only to services you turn on. Each one is something you enable by
setting a key or an address, or by allowing it on the phone; blank means off.
These are the paths that exist in the code:

| You turn on | What goes out | Where it goes |
|---|---|---|
| **The agent**: Hermes, with the hub-platform plugin (`HERMES_API_BASE`) | Every message you send in chat, and the attachments you add, go to Hermes. Hermes then sends each prompt with the context it adds (conversation history, memory, tool results, file contents it read) to its model provider | Hermes runs where you install it, usually the same machine. The model provider is whatever Hermes is configured for: OpenRouter and, through it, the model's own provider, or another provider |
| **Live voice** (`DEEPGRAM_API_KEY`) | While a Live session is open: the raw microphone audio, streamed the whole time the session runs (muted stretches are sent as silence), and the text of everything Live says out loud, which is Xavier's replies and its short acknowledgements. The words you said come back as text | `api.deepgram.com` (Deepgram). The audio goes from the phone to your server, and your server streams it on to Deepgram; the phone never talks to Deepgram itself |
| **Push notifications** (you allow them in the app) | To get a push token, the app asks Expo's servers for one. After that, for each finished reply the server sends the thread title (up to 48 characters) and the first ~140 characters of the reply; for an automation, its job name and the first ~140 characters of its report. Your push token goes with each message | `exp.host` (Expo's push service), which delivers through Apple's push service |
| **Over-the-air updates** (a build made with `EAS_PROJECT_ID`) | On launch the app asks for new JavaScript, sending its platform, runtime version, update channel and a random per-install client id, and after a crash up to 1,024 characters of the last fatal error message. Like any request, it also carries your IP address | `u.expo.dev`, the EAS Update service, for the project of whoever built the app |
| **Hosted memory or search** connected to Hermes (for example Supermemory or Exa) | Whatever Hermes stores or queries there: memories, search terms, documents | That provider |
| **An OpenRouter key on the hub** (`OPENROUTER_API_KEY`, `OPENROUTER_MGMT_KEY`) | The key itself, to read your credit balance, key usage and activity. The hub never sends prompts this way | `openrouter.ai` |
| **A Discord approvals bot** (token file) | Notices about iMessage drafts waiting for you, including the contact name and the draft text | `discord.com`, to a channel you control |
| **An iMessage MCP server** (`IMESSAGE_MCP_URL`) | The draft text and contact name | An address you choose, usually your own Mac |
| **The hub-bridge sidecar** (`HUB_BRIDGE_URL`) | Fixed Hermes CLI commands for the config, cron and skills panels. For the spend panel it also fetches OpenRouter's model price list about once a day, from the agent's side with the agent's `OPENROUTER_API_KEY`, and caches it as `.openrouter-prices.json` in the agent's data directory | An address you choose, usually the same machine; the price list comes from `openrouter.ai` |

The app itself also loads product photos in shopping cards straight from the
web address the agent gives, and opens links you tap.

So the practical answer is that your conversations **do** leave your machine:
Hermes sends them to the model provider on the way to an answer. That leg is
governed by the provider's terms, not by this software. If that matters to you,
choose the provider in Hermes with that in mind. With OpenRouter, your account's
privacy settings can also restrict routing to endpoints with a zero-data-retention
policy (a toggle for each model group); that is a setting on your OpenRouter
account, not something this repository configures.

With Live voice on, your voice leaves too. The phone streams the microphone audio
to your server for as long as a Live session is open, and your server streams it
on to Deepgram, which turns it into text and speaks the replies. That leg is
governed by Deepgram's terms. Without a `DEEPGRAM_API_KEY` nothing goes to
Deepgram: the server ends the session at once and the Live page says voice is
not set up.

About app builds: whoever builds the app chooses its over-the-air update project
(`EAS_PROJECT_ID`) and its default server address. If you install a build
someone else made, its update checks go to their EAS project, its push tokens
are issued under their Expo project, and it can receive new JavaScript they
publish. If you build the app yourself, all three point at you. An unconfigured
build points at a placeholder server (`https://hub.example.com`) that leads
nowhere, and there is no hidden fallback to any other server. The built-in demo
(**Explore demo**, or `demo` as the server address) makes no network requests
of its own: its fictional data is bundled with the app and what you change stays
on the phone. The launch-time update check above still happens in a build that has one.

## What is stored, and where

Everything the server knows lives in one directory on the machine running it:
`HUB_DATA_DIR` (default `./data`, mounted at `/data` in the container). The hub
keeps no copy anywhere else. The main things in it:

- Chat history in a SQLite database at `/data/hub/chat/chat.db`, with image
  attachments in a `media/` directory next to it. With the Hermes plugin
  installed this includes what the plugin streams to the hub: each turn's text,
  reasoning and tool calls, within the plugin's size caps, and the output of
  every scheduled job, for the Automations tab. Tool calls and the final reply
  pass through Hermes's secret redaction first; streamed text and reasoning do
  not.
- What you say in Live, as the text of your messages in the same database:
  a spoken turn is stored like a typed one. No audio is stored, on the server
  or the phone; the server only relays it. Live's diagnostics (the kinds of
  audio input and output, the audio format and session settings, the phone's
  volume, mic level, timing, and for each turn a score of how much it matched
  what Xavier had just said; never your words or a device's name) go to the
  server's console log, which Docker keeps beside its other output.
- Device keys (the public halves of the keys that authorise writes) and
  passkeys, in JSON files under `/data/hub`.
- Push tokens, if you enabled push, in `/data/hub/data/push_tokens.json`.
- Server secrets: tokens and keys the server needs, under `/data/hub/secrets`;
  the plugin and bridge keys in `/data/hub-platform` and `/data/hub-bridge`; a
  brief-signing key in `/data/hub/data`; and live chat sessions in
  `/data/hub/chat/sessions.json`.
- Uploaded and inbox files (`HUB_INBOX_DIR`, default `/data/hub-inbox`), brief
  and briefing data, finance snapshots, decisions, and JSON-lines logs, in
  their own subdirectories under `/data`.
- Your `.env` file with any API keys, next to the data directory, readable
  only by you.

Hermes keeps its own copy of every conversation (its sessions and transcripts),
in its own data directory. Deleting something in the hub does not delete it in
Hermes.

On the phone, the app keeps settings and cached server data in the platform's
standard local storage.

## Who can read it

Chat threads, messages and attachments need a Face ID session from a paired
phone. Most other reads do not, and that includes the agent's full session
transcripts, which the hub serves from Hermes. Anyone who can reach the port can
read those. The full list is in [SECURITY.md](../SECURITY.md); the short version
is that the network is the access boundary, so keep the server on a private one.

## Who is responsible

If you run this on your own machine for yourself, you are the only person whose
data is involved, apart from what you send to the providers you chose. There is
no Xavier service in the middle and no account. Your obligations are the
ordinary ones of running your own computer.

If you run it where other people can reach it, for example for testers, family,
or friends, the picture changes. You now hold data about people who are not you:
their messages, their device keys, their push tokens, whatever the features they
use touch. You are the operator of that system. The software will not do this
part for you; these are your duties, not the project's. In practice:

- Tell each person what the server stores about them and where, which providers
  their messages reach, and who you are. The lists above are a starting point.
- Let them see what you hold and have it deleted. Removing their device key,
  deleting their chat threads, clearing their push token and deleting their
  sessions in Hermes cover most of it; deleting their rows and files from the
  data directory covers the rest.
- Keep the network closed. Anyone who can reach the port can read the
  unauthenticated surface in [SECURITY.md](../SECURITY.md), transcripts
  included, and every paired phone sees every thread. It is your job to keep
  uninvited people out of reach.
- Do not quietly widen the circle. A small group of people you know is a
  different situation from an open signup, and different rules can start to
  apply to you. Privacy laws vary by country and by what you are doing; if
  you are hosting for others at any scale, or for money, get advice for your
  own situation.

## How long data is kept

The software expires very little on its own. Chat history, logs, files, and
tokens sit in the data directory until you or a user delete them, or until you
delete the directory. The built-in expiries: device enrolment codes and sign-in
challenges after about two minutes, chat and terminal sessions after an hour,
and automation runs that produced no report after 90 days. If you operate for other people, retention
is whatever you decide it is, so decide it and tell them. Deleting a user means
deleting their data from the data directory and from Hermes; the server will
not resurrect it, and there is no backup unless you made one.

## What this page is not

This is a description of a codebase, written by the person who maintains it.
It is not a privacy policy, and the project is not a company operating a
service. If you offer Xavier to other people, as a beta, a favour, or a
product, you are the one holding their data, and you need your own policy and
your own answers. Nothing on this page transfers that job to the project.
