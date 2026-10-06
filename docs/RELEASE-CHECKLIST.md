# Release checklist

Items to complete before submitting your own build to TestFlight or the App
Store. This captures the findings of the October 2026 compliance review so
nothing is forgotten. None of this is legal advice; it is an operational
checklist, not a legal opinion.

## 1. Bundle identifier

Confirm the bundle identifier in `app/app.json` (`expo.ios.bundleIdentifier`).
It ships as the placeholder `me.example.xavier` and is overridden from the
environment by `app/app.config.js` (`IOS_BUNDLE_IDENTIFIER`) — see
[PUBLISH-APP.md](PUBLISH-APP.md). App Store Connect rejects an id you do not
control, so make sure the build you upload carries a reverse-domain you own.
Keep it stable for the life of the app: changing it later creates a new app
identity, breaking TestFlight groups, purchases, and push configuration.

## 2. EAS project id and submit credentials

- `app/app.config.js` sets `expo.extra.eas.projectId`, and the over-the-air
  update URL, from `EAS_PROJECT_ID`. Publishing under your own Expo account
  means running `eas init` and exporting the id it produces for that account.
- The Expo owner likewise comes from `EXPO_OWNER`; EAS uses the account you log
  in with, unless the project belongs to an organisation.
- Supply all three identity variables as shell exports or EAS project
  environment variables, never in `eas.json`; see
  [PUBLISH-APP.md](PUBLISH-APP.md#names-and-identifiers-fork-checklist).
- `app/eas.json` ships a placeholder `ascAppId`. Fill in the submit block before
  your first build (`eas.json` is part of the runtime fingerprint). Never commit
  the App Store Connect API key file.

## 3. Export compliance (`usesNonExemptEncryption`)

`usesNonExemptEncryption: false` in `app.json` is correct for this app: its
cryptography is Apple-OS-provided (HTTPS/TLS, Secure Enclave P-256 for the
device keys, Face ID for local authentication) and is used for
authentication, not for app-level payload encryption. Keep the setting as is.
Revisit it if app-level payload encryption is ever added.

## 4. TestFlight mechanics

- Internal testers (up to 100 App Store Connect users) need no review and can
  test as soon as the build finishes processing.
- The first build distributed to an external group goes through Beta App
  Review; after that, subsequent builds are usually approved quickly.
- Builds expire 90 days after upload and must be replaced for testing to
  continue.
- You may not compensate testers in any form for external TestFlight testing.

## 5. Trademark knock-out search

Before you publish under any name, run your own knock-out search: the USPTO,
EUIPO and UKIPO registers (TMview covers several at once) and the domains you
want. Apple enforces name uniqueness on the App Store and can force a rename
after launch regardless of trademark rights, so hold a fallback name before you
submit metadata.

## 6. Keep the store listing clean

Do **not** put "Muse", any other company's trademark, or the comparison from
[COMPARISON.md](COMPARISON.md) into the app name, subtitle, keywords, or
screenshots. App Store Review Guideline
[**2.3.7**](https://developer.apple.com/app-store/review/guidelines/#2.3.7) says
not to pack metadata with trademarked terms or popular app names to game the
system, and that subtitles should not reference other apps. The comparison
belongs in the repository and in prose.
As it stands `app.json` sets the display name "Xavier" and ships no keywords or
subtitle, so the metadata is clean — keep it that way.

## 7. App Store Connect — DSA trader status

The EU Digital Services Act makes App Store Connect show a **trader-status**
banner that applies **account-wide**, not per app. Left unaddressed it leads to
the app's removal from the EU storefront. It is a legal declaration about the
account holder, so it has to be answered in App Store Connect by the account
holder; it cannot be set from the repository.

## 8. App Privacy details

App Store Connect asks what data the app collects. Answer for your own build,
and account for the paths in [PRIVACY.md](PRIVACY.md): push notifications carry
thread titles and the start of replies through Expo and Apple, and a build with
over-the-air updates sends a per-install client id to EAS Update on every
launch and, after a crash, up to 1,024 characters of the last fatal error
message. The app has no analytics or crash-reporting SDK of its own.

## 9. Legal disclaimer

Nothing in this checklist is legal advice. It records practical pre-submission
steps from a compliance review. Consult a lawyer for questions about
licensing, trademarks, or export compliance — in particular before any
commercial or EU/UK use of the name (section 5).
