# Xavier — the iOS app (Expo / React Native)

The client half of Xavier. **Xavier** is both the app's name (what shows on the
home screen) and the assistant it is built around; "the hub" is the server it
talks to (`server/`, run with `./install.sh`). The app pairs with a hub you run
yourself and gives you a native iOS app for it: chat, hands-free Live voice,
automations, the daily brief, the calendar, and the ops views your server
exposes.

There is no public build: you build and sign the app yourself. See
[`../docs/PUBLISH-APP.md`](../docs/PUBLISH-APP.md).

## Develop

```bash
cd app
npm install
npm run typecheck     # tsc --noEmit
npm test              # npm run check, then jest (jest-expo preset)
npx expo start        # dev client
```

Point the app at your server in **Config → Server address** (an `https://`
address; `http://` is accepted only for `localhost`), then pair the phone with a
one-time enrolment code from `./install.sh --pair`. A build can also carry a
default address in `expo.extra.apiBase`. See
[`../docs/CONNECT-APP.md`](../docs/CONNECT-APP.md).

## Build & ship

The build identity comes from the environment, never from a tracked file:
`EXPO_OWNER`, `IOS_BUNDLE_IDENTIFIER` and `EAS_PROJECT_ID`, read by
`app.config.js`. Export them in your shell or set them as EAS project
environment variables; do not put them in `eas.json`. `eas.json` holds the
build and submit profiles, with a placeholder `ascAppId` to fill in before your
first build.

```bash
npx eas-cli build  --profile production --platform ios
npx eas-cli submit --profile production --platform ios --latest
```

JavaScript-only changes reach installed builds as over-the-air updates, through
`../scripts/ota-publish.sh` only. Commit first, keep the identity exported, and
never run `expo prebuild` or `npx expo install --fix`, or edit `app.json`,
`eas.json` or `package*.json`, between a build and its updates. The full routine
is in [`../docs/PUBLISH-APP.md`](../docs/PUBLISH-APP.md#over-the-air-updates).

For a second build with personal features stripped out (a "public-safe" variant
you can hand to testers while keeping the personal build for yourself), see
[`../docs/PUBLIC-BUILD.md`](../docs/PUBLIC-BUILD.md).

### Web (optional, unsupported)

The same app also exports to a static web bundle, for development. It cannot
pair, chat or write, and it is not a PWA; see
[`../docs/CONNECT-APP.md`](../docs/CONNECT-APP.md) for what it is and isn't.

```bash
npm run build:web    # → dist/  (single-page app; serve from the site root)
npm run check:web    # scan the artifact for leaked identifiers and secrets
```

## Layout

| Path | What |
|---|---|
| `app/` | Expo Router routes (home, chat, calendar, automations, ops…) |
| `src/` | components, lib, chat rendering, terminal, theme |
| `modules/` | local native modules: `paste-control`, and `live-audio` (Live voice's echo-cancelled audio engine) |
| `assets/` | icons, fonts, the Xavier character art |
