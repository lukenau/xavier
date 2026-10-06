import {
  decideBriefNavigation,
  decideLiveViewNavigation,
  decideTrustedNavigation,
  resolveBriefUri,
} from './webViewPolicy';

const ORIGIN = 'https://hub.example.com';

describe('resolveBriefUri', () => {
  // Regression coverage for the sheet.tsx finding: /sheet accepts a `uri`
  // param that, before this fix, reached BriefWebView unvalidated, and even
  // this function only checked the scheme — an off-host https URL passed.

  test('a legitimate same-host /my-pages/… link resolves', () => {
    expect(resolveBriefUri('/my-pages/briefing-2026-09-09/', ORIGIN)).toBe(
      `${ORIGIN}/my-pages/briefing-2026-09-09/`,
    );
    expect(resolveBriefUri(`${ORIGIN}/my-pages/briefing-2026-09-09/`, ORIGIN)).toBe(
      `${ORIGIN}/my-pages/briefing-2026-09-09/`,
    );
  });

  test('rejects an off-host https URL — the attack this function exists to stop', () => {
    // hub://sheet?uri=https://attacker.example/login&title=Hub
    expect(resolveBriefUri('https://attacker.example/login', ORIGIN)).toBeNull();
  });

  test('rejects an off-host http URL too', () => {
    expect(resolveBriefUri('http://example.com/x', ORIGIN)).toBeNull();
  });

  test('rejects a lookalike origin (not merely a startsWith match)', () => {
    expect(resolveBriefUri(`${ORIGIN}.evil.com/my-pages/x`, ORIGIN)).toBeNull();
  });

  test('rejects a javascript: link', () => {
    expect(resolveBriefUri('javascript:alert(1)', ORIGIN)).toBeNull();
  });

  test('rejects a data: link', () => {
    expect(resolveBriefUri('data:text/html,<h1>hi</h1>', ORIGIN)).toBeNull();
  });

  test('rejects null/undefined/empty', () => {
    expect(resolveBriefUri(null, ORIGIN)).toBeNull();
    expect(resolveBriefUri(undefined, ORIGIN)).toBeNull();
    expect(resolveBriefUri('', ORIGIN)).toBeNull();
  });

  test('rejects a genuinely unparsable absolute URL (empty host)', () => {
    expect(resolveBriefUri('https://', ORIGIN)).toBeNull();
  });
});

describe('decideBriefNavigation', () => {
  test('allows same-host /my-pages/* — the brief → sub-page → back path', () => {
    expect(decideBriefNavigation(`${ORIGIN}/my-pages/briefing-2026-09-09/`, ORIGIN)).toBe('allow');
    expect(
      decideBriefNavigation(`${ORIGIN}/my-pages/briefing-2026-09-09/imessage/1.html`, ORIGIN),
    ).toBe('allow');
  });

  test('allows same-host /api/* — the dismiss/snooze POST + its 303 redirect', () => {
    expect(decideBriefNavigation(`${ORIGIN}/api/briefing/dismiss`, ORIGIN)).toBe('allow');
  });

  test('blocks the bare hub origin — never silently load the app shell inside a brief', () => {
    expect(decideBriefNavigation(`${ORIGIN}/`, ORIGIN)).toBe('block');
    expect(decideBriefNavigation(ORIGIN, ORIGIN)).toBe('block');
  });

  test('routes an external jump_url to expo-web-browser (the "external" verdict)', () => {
    expect(decideBriefNavigation('https://github.com/example/hub/pull/1', ORIGIN)).toBe('external');
  });

  test('blocks a non-http(s) scheme outright, never external', () => {
    expect(decideBriefNavigation('javascript:alert(1)', ORIGIN)).toBe('block');
  });

  test('a origin that merely starts with the hub origin string is NOT same-origin', () => {
    // Regression guard for a naive `url.startsWith(origin)` check, which this
    // string would incorrectly pass.
    expect(decideBriefNavigation(`${ORIGIN}.evil.com/my-pages/x`, ORIGIN)).toBe('external');
  });
});

describe('decideTrustedNavigation', () => {
  test('allows any same-origin path, including the page-own back link to /', () => {
    expect(decideTrustedNavigation(`${ORIGIN}/oura/`, ORIGIN)).toBe('allow');
    expect(decideTrustedNavigation(`${ORIGIN}/`, ORIGIN)).toBe('allow');
  });

  test('external http(s) is handed off, non-http(s) is blocked', () => {
    expect(decideTrustedNavigation('https://nature.com/some-paper', ORIGIN)).toBe('external');
    expect(decideTrustedNavigation('javascript:alert(1)', ORIGIN)).toBe('block');
  });

  test('a lookalike origin is not same-origin', () => {
    expect(decideTrustedNavigation(`${ORIGIN}.evil.com/`, ORIGIN)).toBe('external');
  });
});

describe('decideLiveViewNavigation', () => {
  const LIVE = 'https://api.browserbase.com/v1/sessions/abc/debug?token=xyz';

  test('allows exactly the given live_url', () => {
    expect(decideLiveViewNavigation(LIVE, LIVE)).toBe('allow');
  });

  test('blocks everything else, including a near-identical URL', () => {
    expect(decideLiveViewNavigation(`${LIVE}&extra=1`, LIVE)).toBe('block');
    expect(decideLiveViewNavigation('https://example.com', LIVE)).toBe('block');
  });
});
