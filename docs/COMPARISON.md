# How this compares to hosted personal agents

Xavier is the **self-hosted** side of a personal agent: the server and its data
live on a machine you control, the app is yours to build, the agent (Hermes) runs
alongside, and the model is whichever provider you configure in Hermes.

One hosted example is Meta's **Muse**, launched 8 September 2026. It is a useful
reference point because its shape is close to this one, and this page is about
one difference in particular: custody.

Nothing here is affiliated with, endorsed by, or sponsored by Meta. Product
names are used descriptively to compare, and they are checked against
[the sources listed below](#sources). If you are the owner of a product named
here and something is wrong or out of date, open an issue.

## The short version

| | Xavier (this project) | Meta Muse (per Meta's pages, 2026-10-06) |
|---|---|---|
| Where the agent and your data live | A machine you control: a VPS, a home server or a Mac | In the cloud, in a dedicated per-user VM |
| Who runs the service | You | Meta |
| The model | Whichever provider you configure in Hermes, which sees each prompt and its context | Muse Spark, Meta's own model |
| Source | MIT, readable and forkable | No public source for the agent or its VM is described |
| Self-hosting | The point of the project | No self-hosted option is described |
| Reaching your own machine | Terminal, files and tmux sessions on your host, over your private mesh (the terminal and tmux need ttyd and hub-tmuxd on your host; the `host/` kit sets them up) | Its own cloud VM has a terminal, files and a browser; with your permission, the Mac app can also work with your files and act in apps on your Mac |
| Cost shape | Your hardware or VPS, your model usage, and Apple's $99/year to build the iPhone app | It is "free for most of what people need", with subscription plans for people who want to do more |

Read that table as a statement about architecture, not about quality. A hosted
product with a large team behind it will beat a solo project on polish, support,
and the number of services it can reach on day one. What you gain here is that
you run the machine that holds your files, history and keys. The model provider
still sees what the agent sends it.

## Why custody is the whole argument

Both designs give an agent a machine with a terminal, a filesystem, and
connectors to your accounts. The question is who else can reach that machine.

- **Hosted (Muse):** Meta's safety write-up says today's architecture isolates
  each user's data from other users and "restricts access to your data by Meta
  personnel through operational policies", and that it "does not prevent Meta
  from accessing data when necessary to support, secure or operate the
  service." Meta has announced Muse Confidential VM, which it says will encrypt
  the whole VM, including a person's data and conversations, "with a key only
  they hold, so not even Meta can access it." Meta says it is coming later this
  year and that a small group of trusted testers already uses it.
- **Self-hosted:** the data at rest sits on a machine you run, reached over a
  private mesh of your own devices in the recommended setup
  ([MESH.md](MESH.md)). If that machine is a rented VPS, the hosting company
  runs the hardware under it, and its terms apply to that disk. The
  conversation itself still leaves the machine: every prompt and its context go
  to the model provider you chose, under that provider's terms, and so does
  anything the agent sends to hosted services you connect. Choosing that
  provider is part of the setup. The other honest trade is that you are the
  operator: patches, backups, and mistakes are yours.

Neither is wrong. They are different answers to "how much do I trust the
operator, and which operators am I trusting."

## Things this project does not have

Stated plainly, because a comparison that only lists advantages is marketing:

- No hosted option, no support contract, no SLA. If it breaks, that is you.
- No public app build. You build and sign the iOS app yourself.
- One maintainer. If they stop, the project stops with them.
- iOS only, today.
- Fewer ready-made connectors than a funded product. See
  [SERVICES.md](SERVICES.md) for what exists and what you bring yourself.
- No mobile onboarding wizard for a non-technical user. Setup involves a
  terminal.

## Sources

Checked 2026-10-06. All are Meta's own pages; its newsroom post links the next
two, and muse.ai is registered to Meta Platforms, Inc.

- Meta, "Introducing Muse" (8 September 2026, updated 30 September):
  <https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/>
  (launch, per-user VM, Muse Spark, free use and subscriptions, the
  Confidential VM and its key)
- Meta AI Research, "How We Built Safety Into Muse" (8 September 2026):
  <https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse>
  (the quotes on Meta's access, connectors, the Confidential VM's testers)
- Meta, "How We Designed Muse": <https://introducing.muse.ai/> (its own
  computer with a file system, a terminal and a browser)
- Meta Help Center, "How Muse works with files and apps in your Mac":
  <https://www.meta.com/help/artificial-intelligence/1126304576638594/>

If any of the above changes, this page is wrong and should be corrected.

## A practical note on naming

Product names belong to their owners. This page uses them nominatively, to
refer to the products themselves. Do not copy this comparison into App Store
listings or metadata. Apple's
[App Store Review Guideline 2.3.7](https://developer.apple.com/app-store/review/guidelines/#2.3.7)
says not to pack metadata with trademarked terms or popular app names to game
the system, and that subtitles should not reference other apps. Keep it in the
repository and in prose.
