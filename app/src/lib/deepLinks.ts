// Deep-link path resolution for `hub://` (app.json `scheme`), consumed by
// app/+native-intent.ts.
//
// The PWA addresses every screen as a hash route (`https://…/#/ops/cost`);
// expo-router addresses them as real paths. The native route tree was laid out
// so the two agree on almost every path (docs/inventory/shell.md §2.2). Two
// PWA paths live under a different tab's stack here and are rewritten so old
// bookmarks, PWA shortcuts and anything Hermes emits keep working.

/** PWA path → native path. The left side is what a stale link says. */
export const DEEP_LINK_ALIASES: Readonly<Record<string, string>> = {
  // App.tsx:85-86 — "Cost left the tab bar 2026-08-08; this alias keeps old
  // bookmarks and PWA shortcuts working." Canonical in both apps is /ops/cost.
  '/cost': '/ops/cost',
  // Files is a top-level PWA route entered from the Ops NavCard row
  // (Ops.tsx:880); natively it is a push on the Ops stack, so it gains /ops.
  '/files': '/ops/files',
  // Terminal left the tab bar 2026-09-16; alias keeps hub:// links, the PWA's
  // /terminal path, and anything Hermes emits still resolving.
  '/terminal': '/ops/terminal',
};

/**
 * Every path an external deep link may resolve to, written as expo-router
 * route PATTERNS: a `[param]` segment matches any single non-empty segment
 * (`routeMatches` below), every other segment is literal. Task 18 introduced
 * the one dynamic entry, `/config/g/[groupId]`.
 *
 * A closed whitelist rather than a pass-through, and it is the only thing that
 * keeps a crafted deep link off expo-router's auto-generated root
 * `+not-found`. That route is generated whether or not the file exists
 * (getRoutes.js:53-65), so it is a NativeTabs child with no trigger; focusing
 * it throws in dev and silently shows tab 0 in release
 * (NativeBottomTabsNavigator.js:103-107). Sending unroutable links to Home
 * instead also reproduces SHELL-02 ("unknown hash renders Home").
 *
 * In-app `router.push` bypasses this list entirely — a per-stack
 * `+not-found.tsx` redirect covers that path instead.
 *
 * NOT the same thing as "every route file" — see `INTERNAL_ONLY_ROUTES`
 * below for route files that must stay OUT of this list on purpose.
 *
 * **Every task that adds a route file must add its path either here or to
 * `INTERNAL_ONLY_ROUTES`** (and to deepLinks.test.ts / routeTree.test.ts),
 * or `routeTree.test.ts` fails the build.
 */
export const KNOWN_ROUTES: readonly string[] = [
  '/',
  '/feed',
  '/finance',
  '/decisions',
  '/chat',
  // The Automations tab root. Its job and run screens are param-driven and
  // stay internal-only below.
  '/automations',
  '/ops',
  '/ops/cost',
  '/ops/files',
  '/ops/feed',
  '/ops/terminal',
  '/config',
  // Config sub-pages, all PWA hash routes of their own
  // (docs/inventory/config.md §1.1) — same paths, so old links keep working.
  '/config/system',
  '/config/memory',
  '/config/security',
  '/config/advisor',
  '/config/routing',
  '/config/pages',
  '/config/connectors',
  // The route tree's ONLY dynamic segment: the PWA's `/config/g/:groupId`
  // full-settings editor. `groupId` is a group KEY, never rendered as
  // markup or a URL — an unknown one falls through to the page's own
  // "Nothing here" panel — so unlike /sheet there is nothing to gain by
  // keeping it off this list.
  '/config/g/[groupId]',
  '/oura',
  // Task 13's push notification opens this, so it must be reachable from an
  // external link — KNOWN_ROUTES, not INTERNAL_ONLY_ROUTES. It takes no
  // untrusted param (the date comes from the server, not the URL), so there is
  // nothing to gain by keeping it off the list.
  '/brief',
  // The calendar, pushed from Home. Native-only like /brief, and like it takes
  // nothing from the URL: the day it opens on is today.
  '/calendar',
];

/**
 * Route files that exist under `app/` and ARE valid in-app `router.push`
 * targets, but must NEVER be resolvable from an external deep link (a
 * `hub://…` URL, a future push notification, a Universal Link) —
 * `resolveDeepLink` below only ever returns a `KNOWN_ROUTES` member, so
 * simply leaving a path out of that list is what closes the door; this list
 * exists so `routeTree.test.ts` can still assert every route FILE is
 * accounted for (reachable-by-link, or explicitly internal-only) instead of
 * silently tolerating an unclassified route.
 *
 * `/sheet` (the brief reader, `app/(home)/sheet.tsx`) is the first entry and
 * the reason this list exists: it renders a `uri` search param inside
 * BriefWebView. `resolveBriefUri` (webViewPolicy.ts) is the actual
 * validation gate and the route re-checks it regardless of how the route was
 * reached — this list is defence-in-depth, not the only guard — but an
 * external caller should never get to try in the first place. In-app code
 * reaches `/sheet` ONLY via `openBrief()` (src/components/briefs/openBrief.ts),
 * which `router.push`es directly and — same as always — bypasses
 * `KNOWN_ROUTES` entirely (see that doc comment above).
 *
 * **Every task that adds a route file not meant to be externally
 * deep-linkable must add its path here** (and to deepLinks.test.ts /
 * routeTree.test.ts), or `routeTree.test.ts` fails the build.
 */
export const INTERNAL_ONLY_ROUTES: readonly string[] = [
  '/sheet',
  // The config sheets. Each is a native form-sheet ROUTE standing in for an
  // in-page <Sheet> component the PWA renders inside another page — none of
  // them is a PWA route, so none has a link to keep working — and each is
  // param-driven (`action`, `id`, `name`). Reached in-app by router.push only.
  '/config/gateway',
  '/config/connector',
  '/config/device-code',
  // Task 21's Face-ID pairing sheet. Same reasoning as the three above (no PWA
  // route, no link to keep working), plus one of its own: it is where a
  // one-time enrol code is typed to mint this app's write credential, so the
  // only way to reach it is a deliberate tap inside Config -> Security.
  '/config/pair',
  // The runtime server-address setting. No PWA twin (the PWA is its own
  // origin) and nothing to deep-link to; it re-points every request and
  // websocket in the app, so reaching it is a deliberate in-app tap only.
  '/config/server',
  // The thread transcript. A static route (`/chat/thread`), not
  // `/chat/[threadId]` — same shape as `/sheet` above and for the same
  // reason: `threadId` rides as a search param instead of a dynamic segment,
  // so it never becomes a second entry in routeTree.test.ts's one-dynamic-
  // route assertion. No push-notification consumer exists yet to deep-link a
  // specific thread from outside the app, so there's nothing to gain from
  // making this externally reachable today.
  '/chat/thread',
  // One automation and one run. Same shape and reasoning as `/chat/thread`:
  // `jobId` / `runId` ride as search params, and the run screen is reached
  // from a notification tap by an in-app `router.push` (src/lib/push.ts),
  // which never passes through this whitelist.
  '/automations/job',
  '/automations/run',
  // Live voice and its settings sheet. Both are reached by a deliberate tap
  // inside the app (the Home card, then the settings button) and neither is a
  // PWA route with a link to keep working. `/live` stays off KNOWN_ROUTES even
  // though it takes no untrusted param: it is a live-mic page (it does not
  // start on its own; the tap on the dots does), and nothing outside the app
  // has any business opening it. `/live-settings` is a native form-sheet
  // route standing in for an in-page sheet, the same class as `/sheet` and the
  // config sheets above.
  '/live',
  '/live-settings',
];

/** Where an unroutable link lands — the PWA's catch-all route (App.tsx:99-101). */
export const UNKNOWN_FALLBACK = '/';

function splitQuery(value: string): [string, string] {
  const cut = value.indexOf('?');
  return cut === -1 ? [value, ''] : [value.slice(0, cut), value.slice(cut)];
}

/**
 * Normalizes an incoming system path to a router path: strips the `hub://`
 * scheme (and the empty authority `hub:///…` leaves behind), the PWA's `#`
 * hash prefix and any trailing slash, and guarantees a leading `/`.
 */
export function normalizeDeepLinkPath(path: string): string {
  const withoutScheme = path.replace(/^[a-zA-Z][\w+.-]*:\/\//, '');
  const withoutHash = withoutScheme.replace(/^\/?#/, '');
  const [rawPath, query] = splitQuery(withoutHash);
  const trimmed = rawPath.replace(/\/+$/, '');
  return (trimmed.startsWith('/') ? trimmed : `/${trimmed}`) + query;
}

/** An expo-router dynamic segment: `[groupId]`, never `[...rest]` (this tree
 * has no catch-all route, and one would need different matching). */
const DYNAMIC_SEGMENT = /^\[[^/[\]]+\]$/;

/**
 * Does a concrete pathname match one `KNOWN_ROUTES` pattern?
 *
 * Segment count must be equal and every literal segment must match exactly; a
 * `[param]` segment matches any single NON-EMPTY segment. So `/config/g/model`
 * matches `/config/g/[groupId]`, while `/config/g`, `/config/g/` (normalized
 * to `/config/g`) and `/config/g/model/extra` do not — a wildcard must not
 * become a prefix match, which is how a whitelist quietly stops being one.
 */
export function routeMatches(pattern: string, pathname: string): boolean {
  if (!pattern.includes('[')) return pattern === pathname;
  const patternSegments = pattern.split('/');
  const pathSegments = pathname.split('/');
  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every((segment, i) =>
    DYNAMIC_SEGMENT.test(segment) ? pathSegments[i].length > 0 : segment === pathSegments[i],
  );
}

/** The body of `+native-intent`'s `redirectSystemPath`. */
export function resolveDeepLink(path: string): string {
  const normalized = normalizeDeepLinkPath(path);
  const [pathname, query] = splitQuery(normalized);
  const target = DEEP_LINK_ALIASES[pathname] ?? pathname;
  const routable = KNOWN_ROUTES.some((pattern) => routeMatches(pattern, target));
  return routable ? target + query : UNKNOWN_FALLBACK;
}
