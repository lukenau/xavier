# Tester privacy notice

A short notice for anyone you point at a server that is not their own. Hand it
over as-is, filled in with your name; the full account of what the code does
with data is in [PRIVACY.md](PRIVACY.md).

**The notice, in full — five points:**

1. **What the server stores about you:** your messages to the agent and any
   images you attach (what you say in Live voice is kept as text, never as
   audio); the public half of your device key and any passkey, which
   authorise your writes; a push token if you turned notifications on; and
   ordinary logs that your device connected and what it did. The agent (Hermes)
   that answers you keeps its own copy of the conversations.
2. **Where it lives, and what travels:** on the machine of whoever runs that
   server. There is no Xavier cloud in the middle. These things do travel:
   everything you say to the agent is sent, with its context, to the AI model
   provider the host chose; if you allow notifications, each thread's title and
   the first ~140 characters of each reply pass through Expo and Apple to reach
   your phone; the app checks the builder's Expo project for updates, with a
   random per-install id; and if you use Live voice, your voice is streamed
   through the server to Deepgram, a speech service, which turns it into text
   and speaks the replies. Anyone who can reach the server's network address can
   read the agent's transcripts, so ask how it has been locked down.
3. **How long:** nothing expires by itself; it stays until it is deleted.
4. **How to get it deleted:** ask whoever runs the server. They can delete your
   messages and the agent's copy of them, remove your device key and clear your
   push token. What the model provider (and, for Live voice, Deepgram) keeps
   is governed by that provider's terms.
5. **Who to contact:** that same person: ____________________. If you installed
   through TestFlight, the app's TestFlight feedback button also reaches them;
   note that TestFlight shares crash reports and any feedback you send with the
   developer, through Apple.

If you run your own hub instead, the answers to points 1, 3, 4 and 5 are "you",
and point 2 still applies: your messages go to the model provider you chose.

---

## Notes for the person hosting

The app has no account and no login, and it contains no analytics or
crash-reporting SDK. It talks to the server address it was given, to Expo when
notifications are allowed, and to EAS Update if the build has over-the-air
updates enabled (after a crash, that check also carries the start of the last
error message).

Chat needs a Face ID session from a paired phone, but every paired phone sees
every thread: there is one shared view, not one per person. And most other reads
are not authenticated at all, the agent's session transcripts included, so
anyone who can reach the server can read those conversations. Keeping it out of
reach is the host's job, not the app's, so it is fair for a tester to ask how it
has been locked down. Keep the circle small and personal; see the
[docs/PRIVACY.md](PRIVACY.md).
