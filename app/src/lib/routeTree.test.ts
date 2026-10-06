// KNOWN_ROUTES is what +native-intent will let a deep link reach; the route
// files are what expo-router can actually render. Every route file must be
// accounted for by EXACTLY one of KNOWN_ROUTES (externally deep-linkable) or
// INTERNAL_ONLY_ROUTES (in-app router.push only — deliberately excluded from
// KNOWN_ROUTES, e.g. because it renders an untrusted param and an external
// caller must never get to supply one). Nothing enforces either half at
// runtime: a route file in neither list is simply unreachable by link (dead,
// not dangerous); an entry in KNOWN_ROUTES without a file sends a link to a
// route with no tab trigger; and — the property this file exists to hold the
// line on — a route file that quietly reappears in KNOWN_ROUTES after being
// deliberately moved to INTERNAL_ONLY_ROUTES (or a new sensitive route added
// straight to KNOWN_ROUTES instead) would silently reopen a closed door.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { INTERNAL_ONLY_ROUTES, KNOWN_ROUTES, resolveDeepLink } from './deepLinks';

const APP_DIR = resolve(__dirname, '../../app');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** expo-router's file → URL rules, for the subset of them this tree uses. */
function routePath(file: string): string | null {
  const rel = relative(APP_DIR, file).split(sep).join('/');
  const withoutExt = rel.replace(/\.(t|j)sx?$/, '');
  const segments = withoutExt.split('/');
  const leaf = segments[segments.length - 1];
  // _layout is a layout, +native-intent / +not-found / +html are conventions.
  if (leaf.startsWith('_') || leaf.startsWith('+')) return null;
  const visible = segments.filter((s) => !/^\(.*\)$/.test(s));
  if (visible[visible.length - 1] === 'index') visible.pop();
  return `/${visible.join('/')}`.replace(/\/$/, '') || '/';
}

test('every route file is accounted for — reachable by deep link, or explicitly internal-only', () => {
  const paths = walk(APP_DIR)
    .map(routePath)
    .filter((p): p is string => p !== null)
    .sort();
  expect(paths).toEqual([...KNOWN_ROUTES, ...INTERNAL_ONLY_ROUTES].sort());
});

test('INTERNAL_ONLY_ROUTES are real route files that KNOWN_ROUTES does not also claim', () => {
  const files = walk(APP_DIR).map(routePath).filter((p): p is string => p !== null);
  for (const path of INTERNAL_ONLY_ROUTES) {
    expect(files).toContain(path);
    expect(KNOWN_ROUTES).not.toContain(path);
  }
});

test('an internal-only route is unreachable from an external deep link', () => {
  // The actual security property: a crafted hub://sheet?uri=… (or any other
  // scheme/hash spelling) must land on Home like any other unroutable path,
  // never on the internal-only screen.
  for (const path of INTERNAL_ONLY_ROUTES) {
    expect(resolveDeepLink(`hub://${path.slice(1)}?uri=https://attacker.example/x`)).toBe('/');
    expect(resolveDeepLink(`#${path}`)).toBe('/');
  }
});

test('the one dynamic route file and its KNOWN_ROUTES pattern are the same string', () => {
  // Task 18. expo-router turns `app/(home)/config/g/[groupId].tsx` into the pattern
  // `/config/g/[groupId]`, and KNOWN_ROUTES stores patterns (routeMatches in
  // deepLinks.ts expands them) — so the two halves agree only if the FILE
  // name and the LIST entry are byte-identical. Renaming the param on either
  // side alone breaks deep-linking to the group pages silently; the equality
  // test above would still pass if BOTH were renamed, which is the point:
  // this one names the file so the pair cannot drift apart unnoticed.
  const files = walk(APP_DIR).map(routePath).filter((p): p is string => p !== null);
  const dynamicFiles = files.filter((p) => p.includes('['));
  expect(dynamicFiles).toEqual(['/config/g/[groupId]']);
  expect(KNOWN_ROUTES.filter((r) => r.includes('['))).toEqual(dynamicFiles);
  // And the pattern is reachable in practice, not just present in the list.
  expect(resolveDeepLink('hub://config/g/model')).toBe('/config/g/model');
});

test('the four tab stacks each have a layout, a root screen and a not-found', () => {
  const files = walk(APP_DIR).map((f) => relative(APP_DIR, f).split(sep).join('/'));
  for (const tab of ['(home)', 'ops', 'chat', 'automations']) {
    expect(files).toContain(`${tab}/_layout.tsx`);
    expect(files).toContain(`${tab}/index.tsx`);
    // Without it, an in-app push to a bad href in this stack falls through to
    // the auto-generated root +not-found, which has no tab trigger.
    expect(files).toContain(`${tab}/+not-found.tsx`);
  }
});

test('the brief route is a thin re-export, so its body stays under jest\'s testMatch', () => {
  // app/** is outside `testMatch: src/**`, so anything living in a route file
  // is untestable on this host — which, with no simulator, means unverifiable.
  // Decisions set the precedent; the brief follows it.
  const route = readFileSync(join(APP_DIR, '(home)/brief.tsx'), 'utf8');
  expect(route).toContain('src/components/brief/BriefScreen');
  expect(route).toMatch(/export \{ default \}/);
});

test('both Feed routes render one shared body, not two screens', () => {
  // the user's decision: Feed is reached from Home and from Ops. Two route files
  // are structurally required (each must sit on its own stack); two screens
  // are not, and would drift.
  const SHARED = 'src/components/feed/FeedScreen';
  for (const route of ['(home)/feed.tsx', 'ops/feed.tsx']) {
    expect(readFileSync(join(APP_DIR, route), 'utf8')).toContain(SHARED);
  }
});

test('every tab trigger names a real top-level route, and vice versa', () => {
  // NativeTabs matches triggers to routes by name and renders nothing for a
  // trigger whose name has no route — a silent missing tab. Group parens are
  // part of the route name and therefore part of the trigger name.
  const layout = readFileSync(join(APP_DIR, '_layout.tsx'), 'utf8');
  const triggers = [...layout.matchAll(/<NativeTabs\.Trigger\s+name="([^"]+)"/g)].map((m) => m[1]);
  const tabRoutes = readdirSync(APP_DIR).filter((name) =>
    statSync(join(APP_DIR, name)).isDirectory(),
  );
  expect(triggers).toHaveLength(4);
  expect([...triggers].sort()).toEqual([...tabRoutes].sort());
  // Order is the tab-bar order the user picked: Home / Ops / Chat /
  // Automations. Trading left the bar and the repo; Config left it on
  // 2026-09-29 and is a push on Home.
  expect(triggers).toEqual(['(home)', 'ops', 'chat', 'automations']);
});

test('the tab labels are the PWA\'s, including the one abbreviation', () => {
  const layout = readFileSync(join(APP_DIR, '_layout.tsx'), 'utf8');
  const labels = [...layout.matchAll(/<NativeTabs\.Trigger\.Label>([^<]+)</g)].map((m) => m[1]);
  // TabBar.tsx:4-12 labels, minus Feed and Money which stopped being tabs, and
  // Term, which moved into Ops (2026-09-16) and made room for Chat, and
  // Config, which moved behind Home's gear (2026-09-29) for Automations.
  expect(labels).toEqual(['Home', 'Ops', 'Chat', 'Automations']);
});

test('the calendar route is a thin re-export, so its body stays under jest\'s testMatch', () => {
  const route = readFileSync(join(APP_DIR, '(home)/calendar.tsx'), 'utf8');
  expect(route).toContain('src/components/calendar/CalendarScreen');
});
