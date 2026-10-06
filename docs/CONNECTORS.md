# Connectors

A hub is only as useful as what its agent can reach. There are two layers, and it
is worth knowing which is which before you start wiring things up.

- **Hub-native**: things the server itself wires up through environment
  variables. These are listed in [SERVICES.md](SERVICES.md) with the exact
  variables, and none of them are bundled.
- **Agent-side**: tools and accounts the *agent* you run alongside the hub
  (Hermes) can use. The hub displays the result; the agent does the reaching.
  This page is about those.

The distinction matters because the hub alone is a dashboard. Everything that
makes it feel alive comes from the agent on the other side of it.

## What a connector is

A connector gives the agent a capability by giving it access to a service:
something to read (mail, a calendar, documents, health data, package tracking),
something to do (draft a message, drive a browser, buy something within limits),
or somewhere to remember (a memory store, a search index). Every one is optional,
and every one is also a data flow: whatever the agent reads from or sends to a
hosted service is handled by that service, under its terms.

The common kinds:

| Kind | What it gives the agent | Usual shape |
|---|---|---|
| Model access | The models themselves | A provider key in Hermes, such as [OpenRouter](https://openrouter.ai) or a provider directly |
| Long-term memory | Facts, preferences and history across sessions, kept outside the model so they survive a model change | A memory API or MCP server |
| Web search | Sources rather than guesses | An API key |
| Mail and calendar | Read, draft and schedule against your own accounts | An MCP server or a CLI over OAuth |
| Messages | Read and draft messages | An MCP server on a machine you own; iMessage drafts are approved in the app |
| Files and documents | Cloud or local files | An API, a CLI, or the hub's own file roots |
| Browser automation | Pages that need a real browser | A local browser, or a hosted browser API |
| Payments | Purchases within limits you set | A wallet or scoped-card CLI |
| Secrets | Keys kept out of plain files | A password manager CLI with a scoped service account |
| Chat apps | Talking to the agent outside the app | A bot token, through Hermes's own messaging platforms |

## The pattern for adding one

Most connectors are one of three shapes:

1. **A CLI on the host.** Install it, give it credentials, and let the agent
   call it. The terminal surface then works with it for free.
2. **An MCP server.** A standard way to expose tools to an agent. Point your
   agent at the server's URL and it gains those tools.
3. **An API key.** The simplest case: a token in your agent's configuration or
   your vault, and the agent can call the API directly.

If it has an API or a CLI, it can be wired up. The agent can usually write the
connector itself.

## Building something that belongs here

If you maintain a service an agent would want to reach, and it has an API or a
CLI, this project is meant to work with it. Open an issue with a link and a
sentence about what it would unlock.

## Where credentials live

None of them live in this repository, and none of them pass through the
maintainer.

- **Preferred:** a password manager with a CLI and a scoped service account, so
  the secret is injected at run time rather than kept in another plain-text
  file.
- **Acceptable:** a `.env` file on the server that is gitignored and readable
  only by the account running the hub.
- **Never:** committed to the repository, pasted into chat, or embedded in the
  app.

If you are handing a build to someone else, remember that a build can carry a
default server address (`expo.extra.apiBase`) and points its over-the-air
update checks at your Expo project: see [BETA.md](BETA.md) and
[SECURITY.md](../SECURITY.md) for what that does and does not mean.

## What is not here, on purpose

Tooling tied to the maintainer's day job is excluded from this project by
policy. If you are adapting this for work use, keep that boundary deliberately:
the value of a personal hub is that it is yours, and mixing an employer's data
into it is how a personal project becomes someone else's problem.

## A note on names

Products and companies named on this page belong to their owners. They are
mentioned descriptively. No affiliation or endorsement is implied in either
direction, and nothing here should be copied into app store metadata.
