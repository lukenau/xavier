# Sharing your build through TestFlight

There is no public Xavier build. If you have built the app yourself
([PUBLISH-APP.md](PUBLISH-APP.md)) and want a few other people to use your build,
TestFlight is how. This page covers what they need, how pairing works, and what
your role as the distributor does and does not give you.

There are two shapes, and the first is the one this project is built for:

- **They run their own server.** Each tester installs the server
  ([SETUP.md](SETUP.md)), gives it an HTTPS address, and pairs their own phone.
  Their data stays with them.
- **They use your server.** Then you are the operator of their data. Read the
  [docs/PRIVACY.md](PRIVACY.md)
  first, and hand them [TESTER-PRIVACY.md](TESTER-PRIVACY.md).

---

## What a tester needs

1. **The app**, from your TestFlight build (see below).
2. **A server with an HTTPS address**: their own, or yours. The app accepts
   `http://` only for `localhost`, so a LAN address will not do; see
   [CONNECT-APP.md](CONNECT-APP.md).
3. **An enrolment code**: a one-time, 6-character code that pairs *their* phone
   with that server, minted by whoever has a shell on it
   (`./install.sh --pair`).
4. **For chat: Hermes with the hub-platform plugin** on that server's side; see
   [hermes-plugin/hub-platform/README.md](../hermes-plugin/hub-platform/README.md).
   Without it the chat tab has nothing behind it.

---

## Why there is a code at all

Writes are gated by a device key held in the phone's Secure Enclave. A phone
cannot vouch for itself: its key is trusted only after it presents a one-time
code that came from the server's own shell (`./install.sh --pair`) or from a
passkey-gated action. Shell access to the server is the authority here, so
whoever has it decides which phones get paired.

The code only governs *writes* and chat. Someone who can merely reach a server
can already read its unauthenticated surface (see
[SECURITY.md](../SECURITY.md)), but cannot pair a phone that can write.

---

## Pairing a device

1. On the server machine, mint a code: run `./install.sh --pair`. It runs inside
   the running server over a local unix socket, so nothing is sent over the
   network and no browser is involved.
2. Read the 6-character code it prints. It is single-use and expires after 120
   seconds (`HUB_ENROLL_CODE_TTL_S`); only one code is ever live, so mint one at
   a time.
3. In the app: **Config → Server address** first, then
   **Config → Security & approvals → Passkeys & Face ID → Face ID device key**, and enter the code. The app
   generates a Secure Enclave key, posts the public half to
   `/api/devicekey/register`, and the phone is trusted.
4. Face ID now authorises writes and unlocks chat on that phone.

To revoke a phone, delete its entry from the server's `devicekeys.json` (or use a
passkey-gated web UI, if you run one; it is not part of this repository). That
removes its ability to *act* and to open new chat sessions, not to *read* the
unauthenticated surface: cut its network access to revoke that.

### Gotchas

- **Codes expire and are single-use.** A stale code fails with the same generic
  error as a wrong one. Mint a fresh code rather than retrying.
- **One live code at a time.** Onboarding several phones is a serial operation.
- **The address must be reachable from the phone over HTTPS.** A tailnet name
  from `tailscale serve` is the easy way.

---

## The server address in your build

Testers type their server into **Config → Server address**; that value wins over
everything else. You can also bake a default into the build with
`expo.extra.apiBase` (see [PUBLIC-BUILD.md](PUBLIC-BUILD.md)). Leave it unset
when testers run their own servers: the unconfigured default is a placeholder
(`https://hub.example.com`) that leads nowhere.

---

## TestFlight

| | Internal testers | External testers |
|---|---|---|
| Who | Up to 100 people on your App Store Connect team | Anyone you invite by email or public link |
| Apple review | Not required | Required for the first build of each version |
| Setup | Add their Apple ID to the team | Create a group, add emails, submit for review |

For a small group, **internal** is the fast path. For a wider one, use
**external** with a public TestFlight link and expect a review pass first.
Apple's reviewers have no server to point the app at, so App Review uses the
built-in demo: **Explore demo** on the first screen, or `demo` as the server
address. Say so in the review notes.
Submitting is an EAS command:

```bash
cd app
npx eas-cli submit --profile production --platform ios --latest
```

Testers redeem the invite in the TestFlight app, then follow the pairing steps
above. Apple build expiry is the clock: a TestFlight build stops working after
90 days, so plan a refresh build before then. Between builds, JavaScript-only
changes can reach testers as over-the-air updates
([PUBLISH-APP.md](PUBLISH-APP.md#over-the-air-updates)).

---

## What a tester can actually reach

The app is only as capable as the server behind it. Out of the box a server
serves health, files, the calendar and the brief from files you provide, and
holds chat history. Chat answers need Hermes with the hub-platform plugin; the
config, cron and skills panels need the hub-bridge sidecar (in this repository,
opt-in); the terminal needs ttyd and hub-tmuxd on the host (the `host/` kit sets them up). Unset,
those panels show an empty state rather than crash, so tell testers which ones
to expect empty. Live voice needs a Deepgram key on the server
(`DEEPGRAM_API_KEY`): without one the Live page says voice is not set up, and
with one the tester's voice goes to Deepgram, so tell them that too.

---

## What reaches you, as the person who built the app

Not their messages: those go to whichever server they pair with, and on to that
server's model provider. But distributing the build does put you in a few paths:

- **Over-the-air updates.** A build made with `EAS_PROJECT_ID` checks your EAS
  project for new JavaScript on every launch, sending its runtime version,
  channel and a random per-install client id, and after a crash up to 1,024
  characters of the last fatal error message. You can also push new JavaScript
  to their phones that way.
- **Push tokens.** The app gets its push token from Expo under your Expo project.
  Notifications themselves are sent by their server, not by you.
- **TestFlight.** Apple shows you your testers' names and emails as invited,
  install and session data, crash reports, and any feedback they send.
- **The app record.** The App Store Connect record, the tester list and the
  Apple Developer relationship are yours.

If you hand a build to people who run their own servers, tell them all of the
above. Someone who would rather not have you in that path can build the app
themselves.
