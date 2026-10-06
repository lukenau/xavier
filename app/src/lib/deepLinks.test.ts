import {
  DEEP_LINK_ALIASES,
  INTERNAL_ONLY_ROUTES,
  KNOWN_ROUTES,
  UNKNOWN_FALLBACK,
  normalizeDeepLinkPath,
  resolveDeepLink,
  routeMatches,
} from './deepLinks';

describe('normalizeDeepLinkPath', () => {
  test('strips the scheme in both authority spellings', () => {
    expect(normalizeDeepLinkPath('hub://feed')).toBe('/feed');
    expect(normalizeDeepLinkPath('hub:///feed')).toBe('/feed');
    expect(normalizeDeepLinkPath('/feed')).toBe('/feed');
  });

  test('strips the PWA hash prefix', () => {
    expect(normalizeDeepLinkPath('#/ops/cost')).toBe('/ops/cost');
    expect(normalizeDeepLinkPath('hub://#/ops/cost')).toBe('/ops/cost');
    expect(normalizeDeepLinkPath('hub:///#/ops/cost')).toBe('/ops/cost');
  });

  test('trailing slashes and a bare scheme collapse to the root', () => {
    expect(normalizeDeepLinkPath('hub://')).toBe('/');
    expect(normalizeDeepLinkPath('hub:///')).toBe('/');
    expect(normalizeDeepLinkPath('/ops/')).toBe('/ops');
  });

  test('the query string survives', () => {
    expect(normalizeDeepLinkPath('hub://ops/cost?window=7d')).toBe('/ops/cost?window=7d');
  });
});

describe('resolveDeepLink', () => {
  test('every PWA hash route that has a native twin passes straight through', () => {
    // docs/inventory/shell.md §2.2 route table, minus the three aliased below.
    const identical = [
      '/',
      '/feed',
      '/finance',
      '/decisions',
      '/chat',
      '/ops',
      '/ops/cost',
      '/config',
      // docs/inventory/config.md §1.1 — the config sub-pages keep their PWA
      // hash paths byte for byte.
      '/config/system',
      '/config/memory',
      '/config/security',
      '/config/advisor',
      '/config/routing',
      '/config/pages',
      '/config/connectors',
    ];
    for (const path of identical) {
      expect(resolveDeepLink(`hub://${path.slice(1)}`)).toBe(path);
      expect(resolveDeepLink(`#${path}`)).toBe(path);
    }
  });

  test('the /cost bookmark alias still opens Cost', () => {
    // App.tsx:85-86 — the alias exists so old bookmarks and PWA shortcuts work.
    expect(resolveDeepLink('hub://cost')).toBe('/ops/cost');
    expect(resolveDeepLink('#/cost')).toBe('/ops/cost');
  });

  test('/files opens the Files push on the Ops stack', () => {
    expect(resolveDeepLink('hub://files')).toBe('/ops/files');
  });

  test('the /terminal bookmark alias still opens Terminal, now under Ops', () => {
    // Terminal left the tab bar 2026-09-16 — the alias keeps hub:// links,
    // the PWA's /terminal path, and anything Hermes emits still resolving.
    expect(resolveDeepLink('hub://terminal')).toBe('/ops/terminal');
    expect(resolveDeepLink('#/terminal')).toBe('/ops/terminal');
  });

  test('/oura is a native-only addition (no PWA hash-route twin) that still resolves', () => {
    // The PWA's /oura/ is a plain <a> that leaves the SPA entirely
    // (docs/inventory/assets.md §9.1), never a wouter hash route. It still
    // needs a KNOWN_ROUTES entry so an in-app `router.push` target (and any
    // future deep link to it) is reachable — see routeTree.test.ts. Unlike
    // /sheet (below), /oura takes no untrusted param, so there is nothing to
    // gain by keeping it off the external-deep-link list.
    expect(resolveDeepLink('hub://oura')).toBe('/oura');
  });

  test('/brief is externally reachable — a push notification is how it opens', () => {
    // The native daily-brief screen (spec §7 "Route registration"). It is the
    // one route a Task 13 push notification taps through to, so it belongs in
    // KNOWN_ROUTES; and unlike /sheet it renders no param from the URL — the
    // date it shows comes from the server — so there is nothing to withhold.
    expect(KNOWN_ROUTES).toContain('/brief');
    expect(resolveDeepLink('hub://brief')).toBe('/brief');
    expect(resolveDeepLink('#/brief')).toBe('/brief');
    expect(resolveDeepLink('hub://brief/')).toBe('/brief');
  });

  test('/calendar is reachable by link: it renders nothing from the URL', () => {
    expect(KNOWN_ROUTES).toContain('/calendar');
    expect(resolveDeepLink('hub://calendar')).toBe('/calendar');
  });

  test('/brief does not become a prefix match for anything below it', () => {
    // The whitelist is segment-exact. `/brief/<anything>` has no route file and
    // must land on Home rather than on the brief screen with junk in the path.
    expect(resolveDeepLink('hub://brief/2026-09-16')).toBe(UNKNOWN_FALLBACK);
    expect(resolveDeepLink('hub://briefing-2026-09-16')).toBe(UNKNOWN_FALLBACK);
  });

  test('/sheet (the brief reader) is a real route that is deliberately NOT externally deep-linkable', () => {
    // SECURITY: /sheet renders an arbitrary `uri` search param inside a
    // chrome-less WebView (see webViewPolicy.ts's resolveBriefUri and
    // app/(home)/sheet.tsx). It is reached in-app only via openBrief(),
    // which router.push()es directly and bypasses this whole module — so
    // /sheet has no reason to ever be in KNOWN_ROUTES, and every spelling of
    // a crafted hub://sheet?uri=… deep link must land on Home instead.
    expect(INTERNAL_ONLY_ROUTES).toContain('/sheet');
    expect(KNOWN_ROUTES).not.toContain('/sheet');
    expect(resolveDeepLink('hub://sheet')).toBe(UNKNOWN_FALLBACK);
    expect(resolveDeepLink('hub://sheet?uri=https://attacker.example/login&title=Hub')).toBe(
      UNKNOWN_FALLBACK,
    );
    expect(resolveDeepLink('#/sheet?uri=javascript:alert(1)')).toBe(UNKNOWN_FALLBACK);
  });

  test('an alias keeps its query string', () => {
    expect(resolveDeepLink('hub://cost?window=mtd')).toBe('/ops/cost?window=mtd');
  });

  test('an unroutable link lands on Home, never on a route with no tab trigger', () => {
    // SHELL-02: the PWA's catch-all renders Home. Natively the stakes are
    // higher — NativeTabs throws when the focused route has no trigger, and
    // expo-router's auto-injected +not-found is exactly such a route.
    expect(resolveDeepLink('hub://nope')).toBe(UNKNOWN_FALLBACK);
    expect(resolveDeepLink('#/services')).toBe(UNKNOWN_FALLBACK);
    expect(resolveDeepLink('hub://config/nope')).toBe(UNKNOWN_FALLBACK);
    expect(resolveDeepLink('hub://+not-found')).toBe(UNKNOWN_FALLBACK);
  });

  test('the config sheets are route files that are deliberately NOT externally deep-linkable', () => {
    // Each stands in for an in-page <Sheet> the PWA renders inside another
    // page — no PWA route, no link to keep working — and /config/device-code
    // POSTs /api/connectors/{id}/connect on mount, so an external caller must
    // never be able to open it. /config/pair is where the one-time enrol code
    // that mints this app's WRITE credential is typed; it must be reachable
    // only by a deliberate tap inside Config.
    for (const path of ['/config/gateway', '/config/connector', '/config/device-code', '/config/pair']) {
      expect(INTERNAL_ONLY_ROUTES).toContain(path);
      expect(KNOWN_ROUTES).not.toContain(path);
      expect(resolveDeepLink(`hub://${path.slice(1)}?id=nous`)).toBe(UNKNOWN_FALLBACK);
    }
  });

  test('every alias target is itself routable', () => {
    for (const target of Object.values(DEEP_LINK_ALIASES)) {
      expect(KNOWN_ROUTES).toContain(target);
    }
  });

  test('no alias shadows a real route', () => {
    for (const source of Object.keys(DEEP_LINK_ALIASES)) {
      expect(KNOWN_ROUTES).not.toContain(source);
    }
  });
});

describe('routeMatches — the dynamic segment (Task 18, /config/g/[groupId])', () => {
  const PATTERN = '/config/g/[groupId]';

  test('the pattern is what KNOWN_ROUTES carries, and it is the only dynamic one', () => {
    // routeTree.test.ts ties this literal to the route FILE; this ties it to
    // the matcher. If a second dynamic route ever lands, this assertion is
    // the prompt to check that routeMatches still covers its shape (a
    // catch-all `[...rest]` would need different matching).
    expect(KNOWN_ROUTES).toContain(PATTERN);
    expect(KNOWN_ROUTES.filter((r) => r.includes('['))).toEqual([PATTERN]);
  });

  test('a literal pattern still matches only itself', () => {
    expect(routeMatches('/config', '/config')).toBe(true);
    expect(routeMatches('/config', '/config/system')).toBe(false);
  });

  test('the wildcard matches exactly one non-empty segment', () => {
    expect(routeMatches(PATTERN, '/config/g/model')).toBe(true);
    expect(routeMatches(PATTERN, '/config/g/misc')).toBe(true);
    // A wildcard must never behave as a prefix match, or the whitelist stops
    // being one.
    expect(routeMatches(PATTERN, '/config/g')).toBe(false);
    expect(routeMatches(PATTERN, '/config/g/')).toBe(false);
    expect(routeMatches(PATTERN, '/config/g/model/extra')).toBe(false);
    expect(routeMatches(PATTERN, '/config/x/model')).toBe(false);
  });

  test('every real group id resolves, and keeps its query string', () => {
    for (const id of ['model', 'behavior', 'memory', 'channels', 'tools', 'security', 'gateway', 'misc']) {
      expect(resolveDeepLink(`hub://config/g/${id}`)).toBe(`/config/g/${id}`);
      expect(resolveDeepLink(`#/config/g/${id}`)).toBe(`/config/g/${id}`);
    }
    expect(resolveDeepLink('hub://config/g/model?open=model.default')).toBe('/config/g/model?open=model.default');
  });

  test('an unknown group id still resolves — the PAGE says "Nothing here", the router does not', () => {
    // Parity: the PWA route `/config/g/:groupId` accepts any id and
    // ConfigSectionPage renders its own empty state. Sending it to Home
    // instead would be a different (worse) behaviour.
    expect(resolveDeepLink('hub://config/g/not-a-group')).toBe('/config/g/not-a-group');
  });

  test('the bare parent path is NOT routable — there is no /config/g screen', () => {
    expect(resolveDeepLink('hub://config/g')).toBe(UNKNOWN_FALLBACK);
    expect(resolveDeepLink('hub://config/g/')).toBe(UNKNOWN_FALLBACK);
    expect(resolveDeepLink('hub://config/g/model/extra')).toBe(UNKNOWN_FALLBACK);
  });
});
