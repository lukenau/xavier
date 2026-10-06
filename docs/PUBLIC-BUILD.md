# Public-safe and personal builds

The app includes surfaces that only make sense for the person who owns the
server: an Ops section with a live terminal, money and spend views, and a health
(Oura) row. If you hand a build to other people, you probably do not want any of
that inside it. This guide shows how to produce two iOS builds from the same
codebase:

- **A. Personal build**: everything, for you.
- **B. Public-safe build**: the same app with personal features stripped, for
  TestFlight testers.

None of this is in the tree today. It is a recipe: the files and changes below
are what you would add. Both builds come from one repository, one branch, one
set of source files.

---

## 1. The mechanism

| Approach | How it works | Downside |
|---|---|---|
| Two bundle ids only | Each build uses a different `IOS_BUNDLE_IDENTIFIER` | Only changes native identity. The JS bundle is identical, so personal screens still ship, under another bundle id. |
| An `APP_VARIANT` variable read by `app.config.js` | One variable selects the app name and a runtime feature flag; the identity variables you already use select the bundle id and EAS project | One more variable to keep set |

**Use the `APP_VARIANT` approach.** A bundle-id-only split changes what the
binary is called, not what it contains. The JS bundle itself has to differ, and
the flag has to reach both the native config (the name) and the runtime code
(which tabs and routes exist).

### How two apps install side by side

iOS identifies an app by its bundle identifier, not its name. Give the personal
build one bundle id (say `me.example.xavier`) and the public-safe build another
(`me.example.xavier.beta`); both are placeholders for ids on a domain you own.
Different bundle ids mean both can be installed on the same phone at once, with
separate icons, storage and pairing. The display name ("Xavier" vs
"Xavier Beta") only affects what shows under the icon.

### Two EAS projects or one?

You need two bundle ids either way, which means two App Store Connect records
either way. Expo-side:

| Option | Pros | Cons |
|---|---|---|
| **Two EAS projects** (recommended) | Separate dashboards, build lists, update channels and runtimes; an update meant for one variant can never reach the other | Two projects to create; two project ids to keep track of |
| One EAS project, two bundle ids | One dashboard | Both variants share update channels and build history, so it is easy to push a JS update built with the wrong flag to the wrong audience |

Recommendation: **two EAS projects**, one `EAS_PROJECT_ID` per variant. The point
of the public-safe build is that mistakes in it do not reach your data; keeping
the projects separate puts that principle in the tooling too.

---

## 2. File changes

### 2.1 Extend `app/app.config.js`

`app.config.js` already takes the owner, bundle id and project id from
`EXPO_OWNER`, `IOS_BUNDLE_IDENTIFIER` and `EAS_PROJECT_ID`. Add the variant on
top, for the display name and the runtime flag:

```js
// inside module.exports.expo, alongside the existing overrides:
const variant = process.env.APP_VARIANT === 'beta' ? 'beta' : 'personal';
// ...
name: variant === 'beta' ? 'Xavier Beta' : base.name,
extra: {
  ...base.extra,
  // (keep the existing projectId override here)
  variant, // read at runtime by src/lib/features.ts
},
```

Notes:

- `APP_VARIANT` is read when the config is evaluated: on your machine, on EAS's
  build servers, and again whenever you publish an update. It must be set the
  same way every time, so set it as a **shell export** or as an **EAS project
  environment variable**, not in a build profile's `env` block in `eas.json`
  (that block exists only while EAS builds, so an update would be built with
  the default variant and miss the build). See
  [PUBLISH-APP.md](PUBLISH-APP.md#names-and-identifiers-fork-checklist).
- The runtime code does not read `process.env` directly (Metro inlines env vars
  unreliably across contexts). It reads the value baked into `extra.variant`
  through `expo-constants`.

### 2.2 Add a feature flag module

Create `app/src/lib/features.ts`:

```ts
import Constants from 'expo-constants';

/** 'personal' keeps everything; 'beta' strips personal surfaces. */
export const APP_VARIANT =
  (Constants.expoConfig?.extra as { variant?: string } | undefined)?.variant === 'beta'
    ? 'beta'
    : 'personal';

export const PERSONAL_FEATURES_ENABLED = APP_VARIANT === 'personal';
```

### 2.3 Gate the personal routes

The tab bar is defined in `app/app/_layout.tsx`. Wrap the personal tabs (Ops at
least) in the flag. Hiding a tab is not enough, though: expo-router registers
every file under `app/app/` as a reachable route, so deep links and
`router.push` calls can still get there. Guard the route files themselves (the
screens under `app/app/ops/`, and, if you consider them personal,
`app/app/(home)/finance.tsx`, `oura.tsx` and `decisions.tsx`):

```tsx
import { Redirect } from 'expo-router';
import { PERSONAL_FEATURES_ENABLED } from '../../src/lib/features';

export default function OpsScreen() {
  if (!PERSONAL_FEATURES_ENABLED) {
    return <Redirect href="/" />;
  }
  // ...existing screen...
}
```

Also gate the entry points that navigate to personal routes: the terminal
button in the home header, and the money, spend and health rows on the home
screen, so a beta build neither shows them nor polls their endpoints.

For a harder guarantee, make the personal route files vanish from the bundle:
in `metro.config.js`, when `process.env.APP_VARIANT === 'beta'`, alias each
personal route to a one-line stub that returns the redirect above. The screen
code is then not in the JS bundle at all. It is more setup and easier to get
subtly wrong, so start with the per-screen guard.

### 2.4 Keep the App Store Connect ids separate

Each variant gets its own App Store Connect record and its own submit profile in
`app/eas.json`, filled in before that variant's first build (`eas.json` is part
of the runtime fingerprint, so do not edit it between a build and its updates):

```json
{
  "submit": {
    "production": { "ios": { "ascAppId": "<personal app id>" } },
    "beta":       { "ios": { "ascAppId": "<beta app id>" } }
  }
}
```

A beta build profile also needs its own update channel (for example
`"channel": "beta"`) so its updates never reach the personal build.

---

## 3. App Store Connect

Create one app record per bundle id under Apps → **+**: the personal one, and the
public-safe one with its own unique name. Register both bundle ids in your Apple
Developer account first (Identifiers), or they will not appear in the picker.
The public-safe app can stay TestFlight-only for good; a build in TestFlight is
usable by testers whether or not you ever submit it for App Store review.

Then build and submit each variant with its own identity exported:

```bash
export APP_VARIANT=beta EAS_PROJECT_ID=<beta project id> IOS_BUNDLE_IDENTIFIER=me.example.xavier.beta
npx eas-cli build  --profile beta --platform ios
npx eas-cli submit --profile beta --platform ios --latest
```

Internal versus external TestFlight testers, and what testers need, are covered
in [BETA.md](BETA.md). Testers type their own server into
**Config → Server address**; leave `expo.extra.apiBase` unset in a build for
people who run their own servers.

**Updates for a second variant.** `scripts/ota-publish.sh` publishes to the
`production` channel only. Publishing updates to a `beta` channel means
adapting it (or running its steps by hand) with the beta variant's identity
exported; check the runtime fingerprint against the beta build the same way the
script does.

---

## 4. Caveats: what can still leak into a "safe" build

Feature-gating hides screens; it does not guarantee nothing personal is in the
binary. Before handing the beta build out, check these:

- **JS bundle strings.** The Hermes bundle is minified, but string literals
  survive: route names, error messages, accessibility labels, any hard-coded
  path or name. Code inside `if (!PERSONAL_FEATURES_ENABLED)` branches is
  minified but still present; the metro-alias approach in 2.3 is the only way to
  remove it.
- **Assets.** Any image or asset that exists only for a personal feature ships
  in the binary even if it is never shown.
- **Source maps.** EAS uploads source maps of your build to Expo's servers, and
  `npx expo export` writes `.map` files locally. Do not share source maps of the
  beta build; they reconstruct the original source, comments included.
- **Build logs and metadata.** Keep real App Store Connect ids, tokens and key
  files out of anything you publish.

How to check the actual beta bundle:

```bash
# Export the JS bundle as a build would contain it, as plain JavaScript: a
# build ships Hermes bytecode, which grep skips as binary.
APP_VARIANT=beta npx expo export --platform ios --no-bytecode

# Grep it for anything personal. Substitute your own server host name and name
# for the placeholders:
grep -rIiE 'terminal|oura|YOUR_SERVER_HOSTNAME|YOUR_NAME' dist/_expo/static/js/ | head
```

Run the repository checks before any build that leaves your machine:

```bash
cd app && npm run check
cd .. && ./scripts/publish-gate.sh .
```

`publish-gate.sh` scans the repository for secrets, tailnet addresses and
personal contact details, plus any private markers you list in the file named
by `GATE_PRIVATE_PATTERNS`. It does not scan built bundles, so run
both: the gate for the repository, the grep above for the beta artifact. If
either finds the string you meant to strip, fix the gating, rebuild, and check
again before distributing.
