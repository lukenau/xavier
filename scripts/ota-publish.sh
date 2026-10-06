#!/usr/bin/env bash
# Publish a JS-only over-the-air update for the iOS app, and prove an installed build
# will receive it.
#
#   scripts/ota-publish.sh [--ref <git-ref>] [--message <text>] [--skip-tests] [--check]
#
# An update reaches a phone only when all three of these hold, and each one has failed
# silently before:
#   1. it is built from committed source, not a working copy with stray edits;
#   2. its runtime version (a fingerprint of the native config and the installed native
#      modules) equals the installed build's;
#   3. the build's channel is linked to the branch the update is published to.
# This script checks all three, then asks the update server for an update exactly as the
# newest build on the channel would, and exits non-zero unless the answer is the update it
# just published. --check stops before publishing.
#
# Needs EXPO_TOKEN, EXPO_OWNER, IOS_BUNDLE_IDENTIFIER and EAS_PROJECT_ID in the environment
# (docs/PUBLISH-APP.md). Between a native build and its updates, never run `expo prebuild`
# or `npx expo install --fix`, and never edit app/app.json, app/eas.json or app/package*.json:
# each one moves the runtime, and this script will then refuse to publish.
set -euo pipefail

REF=HEAD MESSAGE="" SKIP_TESTS=0 CHECK_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF=$2; shift 2 ;;
    --message) MESSAGE=$2; shift 2 ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --check) CHECK_ONLY=1; shift ;;
    *) echo "ota-publish: unknown argument: $1" >&2; exit 2 ;;
  esac
done

fail() { echo "ota-publish: $*" >&2; exit 1; }
for v in EXPO_TOKEN EXPO_OWNER IOS_BUNDLE_IDENTIFIER EAS_PROJECT_ID; do
  [ -n "${!v:-}" ] || { echo "ota-publish: $v is not set (see docs/PUBLISH-APP.md)" >&2; exit 2; }
done

REPO=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)
SHA=$(git -C "$REPO" rev-parse --verify "$REF^{commit}")
# Beside the repo: on the same filesystem as app/node_modules, so the hard links below work, and
# outside .git, because Jest and Metro skip any path that runs through one.
WORK=$(mktemp -d "$(dirname "$REPO")/ota-publish-tmp.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

echo "→ clean checkout of $(git -C "$REPO" log -1 --format='%h %s' "$SHA")"
git clone --quiet "$REPO" "$WORK/src"
git -C "$WORK/src" checkout --quiet --detach "$SHA"
APP="$WORK/src/app"
cd "$APP"

# The installed modules feed the runtime fingerprint, so they must be exactly what the
# lockfile pins. Reuse the source checkout's tree (hard links, no extra disk) when npm's
# record of what it installed matches this lockfile entry for entry (optional,
# platform-specific packages aside); otherwise install clean.
matches_lockfile() {
  node -e '
    const lock = require("./package-lock.json").packages;
    const got = require("./node_modules/.package-lock.json").packages;
    const bad = Object.keys(lock).filter(k => k && (got[k]
      ? got[k].version !== lock[k].version || got[k].integrity !== lock[k].integrity
      : !lock[k].optional));
    const extra = Object.keys(got).filter(k => !lock[k]);
    process.exit(bad.length || extra.length ? 1 : 0);
  ' 2>/dev/null
}
if [ -d "$REPO/app/node_modules" ] && cp -al "$REPO/app/node_modules" node_modules && matches_lockfile; then
  echo "→ node_modules: hard-linked from $REPO/app (installed tree matches the lockfile)"
else
  rm -rf node_modules
  echo "→ node_modules: npm ci"
  npm ci --no-audit --no-fund --loglevel=error
fi

CHANNEL=$(node -p 'require("./eas.json").build.production.channel')
EAS="npx --yes eas-cli@latest"

echo "→ newest finished iOS build on channel '$CHANNEL'"
$EAS build:list --platform ios --channel "$CHANNEL" --status finished --limit 1 --json \
  --non-interactive >"$WORK/build.json"
read -r BUILD_RUNTIME BUILD_NUMBER BUILD_COMMIT < <(node -e '
  const [b] = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!b) process.exit(3);
  console.log(b.runtime.version, b.appBuildVersion, (b.gitCommitHash || "unknown").slice(0, 9));
' "$WORK/build.json") || fail "no finished iOS build on channel '$CHANNEL' — nothing could receive an update"

LOCAL_RUNTIME=$(npx expo-updates fingerprint:generate --platform ios | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => console.log(JSON.parse(s).hash));')
echo "   build $BUILD_NUMBER (from $BUILD_COMMIT) runtime $BUILD_RUNTIME"
echo "   this tree           runtime $LOCAL_RUNTIME"
[ "$LOCAL_RUNTIME" = "$BUILD_RUNTIME" ] || fail "runtime mismatch: an update from this tree would reach no installed build.
  Publish from the tree build $BUILD_NUMBER was cut from, or cut a new native build from this one."

if [ "$SKIP_TESTS" = 0 ]; then
  echo "→ type-check and tests"
  npx tsc --noEmit
  npm run --silent test:ci -- --silent
fi

$EAS channel:view "$CHANNEL" --json --non-interactive >"$WORK/channel.json"
LINKED=$(node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const names = (c.updateBranches || c.currentPage?.updateBranches || []).map(b => b.name);
  console.log(names.includes(process.argv[2]) ? "yes" : "no");
' "$WORK/channel.json" "$CHANNEL")

if [ "$CHECK_ONLY" = 1 ]; then
  echo "✔ check passed: runtime matches build $BUILD_NUMBER; channel linked to branch '$CHANNEL': $LINKED"
  exit 0
fi

[ -n "$MESSAGE" ] || MESSAGE=$(git -C "$WORK/src" log -1 --format=%s)
echo "→ publishing to branch '$CHANNEL'"
$EAS update --branch "$CHANNEL" --platform ios --environment production \
  --message "$MESSAGE" --non-interactive --json >"$WORK/update.json"
read -r UPDATE_ID UPDATE_RUNTIME < <(node -e '
  const u = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).find(x => x.platform === "ios");
  console.log(u.id, u.runtimeVersion ?? u.runtime?.version);
' "$WORK/update.json") || fail "published, but could not read the update id from: $(head -c 600 "$WORK/update.json")
  Check \`eas update:list --branch $CHANNEL\` before re-running — a second run publishes a second update."
[ "$UPDATE_RUNTIME" = "$BUILD_RUNTIME" ] || fail "published update $UPDATE_ID has runtime $UPDATE_RUNTIME, not $BUILD_RUNTIME"

if [ "$LINKED" = no ]; then
  echo "→ channel '$CHANNEL' served no branch: linking it to branch '$CHANNEL'"
  $EAS channel:edit "$CHANNEL" --branch "$CHANNEL" --non-interactive >/dev/null
fi

echo "→ asking the update server as build $BUILD_NUMBER would"
for attempt in 1 2 3 4 5 6; do
  code=$(curl -s -o "$WORK/manifest" -w '%{http_code}' \
    -H 'expo-platform: ios' -H "expo-runtime-version: $BUILD_RUNTIME" \
    -H "expo-channel-name: $CHANNEL" -H 'expo-protocol-version: 1' \
    -H 'accept: multipart/mixed' "https://u.expo.dev/$EAS_PROJECT_ID")
  if [ "$code" = 200 ] && grep -q "$UPDATE_ID" "$WORK/manifest"; then
    echo "✔ build $BUILD_NUMBER will download update $UPDATE_ID on its next launch and run it on the launch after"
    exit 0
  fi
  sleep 10
done
fail "published $UPDATE_ID, but the update server answers build $BUILD_NUMBER with HTTP $code: $(head -c 300 "$WORK/manifest")"
