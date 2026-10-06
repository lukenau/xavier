// Machine-specific app identity lives in the environment, not in this repo.
//
// `app.json` ships neutral placeholders so a stranger who forks this repo does
// not inherit the author's Expo account, bundle identifier, or project id. A
// build supplies the real values at config-eval time (shell exports, or EAS
// project environment variables; never eas.json, which is hashed into the
// runtime) through these three variables:
//
//   EXPO_OWNER              Expo account/organisation that owns the project
//   IOS_BUNDLE_IDENTIFIER   permanent App Store bundle id (reverse-DNS)
//   EAS_PROJECT_ID          from `eas init` for your own Expo account
//
// Unset variables fall through to the placeholders in app.json. See
// docs/PUBLISH-APP.md → "Names and identifiers" for the fork checklist.
//
// `updates.url` is derived from the project id for the same reason: it is the
// endpoint EAS Update serves a build's JS from, and it must carry the owner's
// project id, not a placeholder. With it set, a JS-only change reaches an
// installed build over the air instead of costing a full App Store build.
const base = require('./app.json').expo;

const owner = process.env.EXPO_OWNER;
const bundleIdentifier = process.env.IOS_BUNDLE_IDENTIFIER;
const projectId = process.env.EAS_PROJECT_ID;

module.exports = {
  expo: {
    ...base,
    ...(owner ? { owner } : {}),
    ...(projectId ? { updates: { url: `https://u.expo.dev/${projectId}` } } : {}),
    ios: {
      ...base.ios,
      ...(bundleIdentifier ? { bundleIdentifier } : {}),
    },
    extra: {
      ...base.extra,
      ...(projectId ? { eas: { ...(base.extra && base.extra.eas), projectId } } : {}),
    },
  },
};
