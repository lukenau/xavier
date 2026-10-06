# Contributing

Thanks for helping improve Xavier. Keep changes small, testable, and consistent
with the existing style: the docs and code aim to be practical and terse, with
no marketing voice. Sign every commit (`git commit -s`); see the
[root CONTRIBUTING.md](../CONTRIBUTING.md).

## Project layout

```
xavier/
├── install.sh              one-command bootstrap (bash; GNU and BSD/macOS)
├── docker-compose.yml      the server service definition
├── .env.example            the settings install.sh starts from
├── server/                 hub-api (FastAPI, Python 3.12)
├── app/                    the Xavier iOS app (Expo / React Native, TypeScript)
├── hermes-plugin/          the hub-platform plugin for Hermes
├── scripts/                mesh setup, over-the-air publishing, the publish gate
├── docs/                   user-facing documentation
└── assets/img/             diagrams and screenshots used by the docs
```

## Development setup

**Server** (Docker path, what the installer uses):

```bash
git clone https://github.com/<your-username>/xavier.git
cd xavier
./install.sh
curl -fsS http://127.0.0.1:8090/api/healthz
```

Iterate with rebuilds:

```bash
docker compose up -d --build   # rebuild + restart after server/ changes
docker compose logs -f hub-api # watch logs
```

Run the server tests with `server/run_tests.sh`, which runs each test file in
its own process.

**App** (needs Node 22; iOS builds need macOS + Xcode, or EAS):

```bash
cd app
npm install
npm run web        # or ios / android
npm run typecheck  # tsc --noEmit
npm test
```

Add native modules with `npx expo install <pkg>` so SDK pins resolve correctly.
Any change to native modules, `app/app.json`, `app/eas.json` or
`app/package*.json` changes the app's runtime: it needs a new native build, and
over-the-air updates cannot carry it (see
[PUBLISH-APP.md](PUBLISH-APP.md#over-the-air-updates)).

## Ground rules

- **`.env` and `data/` never get committed.** They are gitignored; keep it that
  way. Never paste tokens, logs, or addresses containing real credentials into
  issues or PRs; redact first.
- **Document configuration where people look for it.** If you add or rename an
  environment variable the server reads, update `.env.example` and
  [SERVICES.md](SERVICES.md) in the same PR.
- **Server changes must keep the security posture**: loopback-by-default
  publishing, the `Host` allowlist, the Face ID device-key write gate, the
  explicit POST allowlist, the chat and terminal session gates, and the
  single-worker constraint (the WebAuthn challenge cache is in-process). A new
  read that serves personal data must either be gated or be listed in the
  unauthenticated surface in [SECURITY.md](../SECURITY.md). A PR that weakens
  any of this needs a very good reason.
- **Docs are part of the product.** If a change alters behaviour a user can
  observe (ports, env vars, endpoints, install steps, what leaves the machine),
  update the relevant page under `docs/`.
- **Bash portability matters** for `install.sh`: it must work with GNU and
  BSD/macOS `sed`. Test on both if you touch it.

## Sending a change

1. Fork, create a branch, make the change.
2. Verify: the server boots (`./install.sh`), healthz returns 200, the server
   tests pass, and, for app changes, `npm run typecheck` and `npm test` pass.
3. Open a PR with a short description of what changed and why, plus the
   verification you ran.

## Reporting bugs

Open a GitHub issue with: exact command(s), full output, `docker compose ps`,
and the last ~50 log lines (`./install.sh --logs`). Redact tokens and personal
details.

## Reporting security issues

Please do **not** open a public issue for a vulnerability. Follow the
responsible-disclosure process in [SECURITY.md](../SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the MIT
license covering this project (see [LICENSE](../LICENSE)). Third-party component
licenses are tracked in [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).
