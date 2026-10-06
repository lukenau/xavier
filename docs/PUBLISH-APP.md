# Publish the app — Expo project, App Store Connect record, updates

There is no public Xavier build. This is the one-time setup that turns this
source tree into your own installable TestFlight build, and the routine for
updating it afterwards. Do it on a machine that holds your own Apple and Expo
credentials; this repository ships no credentials of any kind.

You need an Apple Developer Program membership ($99/year) and an Expo account.

## Names and identifiers (fork checklist)

Everything here belongs to whoever **builds** the app, not to this repository.
`app/app.json` ships neutral placeholders; `app/app.config.js` overrides them from
the environment, so no one's Expo account, bundle id, or project id travels with
a fork:

| Environment variable | Sets | Without it |
|---|---|---|
| `EXPO_OWNER` | `expo.owner` | EAS uses the account you log in with |
| `IOS_BUNDLE_IDENTIFIER` | `expo.ios.bundleIdentifier` | the placeholder `me.example.xavier` |
| `EAS_PROJECT_ID` | `expo.extra.eas.projectId`, and the over-the-air update URL (`https://u.expo.dev/<id>`) | no update URL, so no over-the-air updates, and no push token, so no notifications |

| Thing | Value | Where |
|---|---|---|
| Display name (home screen) | **Xavier** | `app/app.json` → `expo.name` |
| App Store name | your choice, e.g. **Xavier: Private AI Hub** | set in App Store Connect |
| Slug / EAS project | **xavier** | `app/app.json` → `expo.slug` |

The bundle identifier follows reverse-DNS on a domain or handle you control.
`me.example.xavier` is a **placeholder, not a value to copy**. Pick your own
before the first upload; it is **permanent after that**: Apple will not let you
reuse or rename it.

Supply the three variables for every build **and** every update, in one of two
ways:

- **Shell exports**, before each command:

  ```bash
  export EXPO_OWNER=your-expo-username
  export IOS_BUNDLE_IDENTIFIER=com.yourdomain.xavier
  export EAS_PROJECT_ID=<the id eas init prints in step 1>
  ```

- **EAS project environment variables**, set once in the Expo dashboard (or with
  `eas env:create`) for the `production` environment, which is the one
  `scripts/ota-publish.sh` publishes with. The script still checks that the
  variables are exported in your shell before it starts, so for updates export
  them as well.

Do **not** put them in a build profile's `env` block in `app/eas.json`. Those
values exist only while EAS builds, not when you publish an update, so the update
would be built from a different app config, land on a different runtime, and
never reach the build. `app/eas.json` is also hashed into the runtime, so editing
it later has the same effect. Nothing here needs a change to a tracked file, so a
later `git pull` never hands you someone else's identity.

---

## 1. Create the Expo project

```bash
cd app
npx eas-cli login              # Expo account; or export EXPO_TOKEN=... first
npx eas-cli init               # creates the project, prints its project id
```

Use the id it prints as `EAS_PROJECT_ID`. If `eas init` offers to write the id
into `app.json`, you can decline: the variable sets both the project id and the
update URL, and a project id written only into `app.json` gives you a build
without over-the-air updates.

If the project belongs to an Expo organisation rather than your personal
account, set `EXPO_OWNER` to that organisation so the build targets the right
account.

## 2. Apple Developer — App ID

In <https://developer.apple.com/account/resources/identifiers>:

1. **+** → App IDs → App.
2. Bundle ID (explicit): the one you picked above.
3. Capabilities: enable **Push Notifications** (the hub sends push through Expo)
   and leave the rest default. Face ID needs no capability; it uses the
   `NSFaceIDUsageDescription` already in `app.json`.
4. Give Expo an Apple push key: run `npx eas-cli credentials -p ios` in `app/`,
   pick the production profile, and set up a push key. Builds from this
   repository never prompt for one, and without it no notification arrives.

## 3. App Store Connect — the app record

In <https://appstoreconnect.apple.com> → My Apps → **+** → New App:

- **Platform**: iOS
- **Name**: your choice (it must be unique across the App Store; have a fallback
  ready)
- **Primary language**: English (U.S.)
- **Bundle ID**: pick the one from step 2
- **SKU**: anything you like, e.g. `xavier-hub` (internal only)

Copy the **Apple ID** it assigns, a number such as `1234567890`. That is the
`ascAppId` for submitting.

## 4. Submit credentials

`app/eas.json` ships with a placeholder `ascAppId`. Fill in the submit block
**before your first build**, because `eas.json` is part of the runtime
fingerprint (see [Over-the-air updates](#over-the-air-updates)):

```json
"ios": {
  "ascApiKeyPath": "./secrets/AuthKey.p8",
  "ascApiKeyId": "<your key id>",
  "ascApiKeyIssuerId": "<your issuer id>",
  "ascAppId": "<the Apple ID from step 3>"
}
```

Generate the key at App Store Connect → Users and Access → Integrations →
App Store Connect API → **+**, role *App Manager*. Download the `.p8` once; put
it in `app/secrets/` and confirm `.gitignore` covers that directory. Never commit
the key file. TestFlight groups are passed at submit time rather than written
into `eas.json`.

## 5. Build and submit

```bash
cd app
npx eas-cli build  --platform ios --profile production
npx eas-cli submit --platform ios --profile production --latest
```

The first build you hand to an **external** TestFlight group goes through Beta
App Review (expect a day or two). **Internal** testers (up to 100 on your App
Store Connect team) need no review. EAS builds run on Expo's servers, so the app
source is uploaded there for the build.

## 6. Testers

See [BETA.md](BETA.md). In short: add them to a TestFlight group, they install,
point the app at a server, and pair with a 6-character enrolment code. Builds
expire after 90 days, so keep a refresh cadence.

---

## Over-the-air updates

A JavaScript-only change can reach installed builds without a new App Store
build, through EAS Update. **The one supported way to publish an update is
`scripts/ota-publish.sh`**:

```bash
export EXPO_TOKEN=...            # plus EXPO_OWNER, IOS_BUNDLE_IDENTIFIER, EAS_PROJECT_ID
scripts/ota-publish.sh --check   # every check, no publish
scripts/ota-publish.sh           # publish HEAD
```

The rules it is built around:

- **Commit first.** The script publishes a commit (`HEAD`, or `--ref <git-ref>`)
  from a clean checkout, never your working copy. Uncommitted edits are not in
  the update.
- **Export the identity.** `EXPO_TOKEN`, `EXPO_OWNER`, `IOS_BUNDLE_IDENTIFIER`
  and `EAS_PROJECT_ID` must be exported in your shell; the script stops if any
  is missing. Never put them in `eas.json`, which is hashed into the runtime.
- **Leave the native layer alone between a build and its updates.** Do not run
  `expo prebuild` or `npx expo install --fix`, and do not edit `app/app.json`,
  `app/eas.json` or `app/package*.json`. Each one moves the runtime fingerprint,
  and an update from a moved tree reaches no installed build. A change that
  needs any of them needs a new build.
- **It refuses on a mismatch, and proves delivery.** The script finds the
  newest finished iOS build on the `production` channel and refuses to publish
  unless this tree's runtime fingerprint matches it. It runs the type-check and
  tests (unless `--skip-tests`), publishes, links the channel to its branch if
  needed, then asks the update server for an update exactly as that build would,
  and exits non-zero unless the answer is the update it just published.

On success the phone downloads the update on its next launch and runs it on the
launch after. If the script fails *after* publishing, run
`eas update:list --branch production` before trying again: a second run
publishes a second update.

Installed builds check for updates on every launch, sending their runtime
version, channel and a per-install client id to `u.expo.dev`, and after a crash
up to 1,024 characters of the last fatal error message. That is part of what
[PRIVACY.md](PRIVACY.md) discloses.

---

## Walls you will hit, in order

1. **`projectId` for the wrong account** → step 1 creates a project in your own
   Expo account; export its id as `EAS_PROJECT_ID`.
2. **Bundle ID you do not control** → step 2; App Store Connect rejects an id
   outside a reverse-domain you own, and it is permanent after the first upload.
3. **Missing compliance answer** → already handled: `usesNonExemptEncryption:
   false` in `app.json` is correct for OS-provided crypto used for auth. See
   [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md).
4. **Name already taken** → have a fallback ready (step 3).
5. **An update that never arrives** → the runtime moved. Run
   `scripts/ota-publish.sh --check` to see the two fingerprints side by side.

## What cannot be done from a server

Creating the Expo project and the App Store Connect record both require signing
in to those accounts, which on a headless box means a manual login (or a vaulted
login you approve). Everything above that does not need a login can be scripted.
