import type { FeedItem, FeedKind } from '../../lib/types';
import {
  emptyTitle,
  externalFeedHref,
  FILTERS,
  filterItems,
  isOpenable,
  KIND_SYMBOL,
  kindToneToken,
  runToneToken,
  secondLine,
} from './feedModel';

function item(over: Partial<FeedItem> & { kind: FeedKind }): FeedItem {
  return { id: over.kind, ts: 1_700_000_000, title: 'x', ...over };
}

describe('filter chips', () => {
  const items = (['brief', 'run', 'alert', 'report', 'status'] as FeedKind[]).map((k) =>
    item({ kind: k }),
  );

  test('the chip row is exactly All / Briefs / Runs / Alerts', () => {
    expect(FILTERS.map((f) => f.id)).toEqual(['all', 'brief', 'run', 'alert']);
    expect(FILTERS.map((f) => f.label)).toEqual(['All', 'Briefs', 'Runs', 'Alerts']);
  });

  test('report and status have no chip, so All is the only place they appear', () => {
    expect(filterItems(items, 'all')).toHaveLength(5);
    for (const chip of FILTERS.slice(1)) {
      const shown = filterItems(items, chip.id).map((i) => i.kind);
      expect(shown).not.toContain('report');
      expect(shown).not.toContain('status');
    }
  });

  test('a chip keeps only its own kind', () => {
    expect(filterItems(items, 'run').map((i) => i.kind)).toEqual(['run']);
  });

  test('empty copy literal-pluralises, "No runs" included', () => {
    expect(emptyTitle('all')).toBe('Nothing yet');
    expect(emptyTitle('brief')).toBe('No briefs');
    expect(emptyTitle('run')).toBe('No runs');
    expect(emptyTitle('alert')).toBe('No alerts');
  });
});

describe('isOpenable', () => {
  test('a brief needs a link; its summary is not enough', () => {
    expect(isOpenable(item({ kind: 'brief', link: '/my-pages/b/' }))).toBe(true);
    expect(isOpenable(item({ kind: 'brief', summary: 'text' }))).toBe(false);
  });

  test('a run needs its output; its link is not enough', () => {
    expect(isOpenable(item({ kind: 'run', summary: 'log' }))).toBe(true);
    expect(isOpenable(item({ kind: 'run', link: '/x' }))).toBe(false);
  });

  test('every other kind takes either', () => {
    expect(isOpenable(item({ kind: 'alert', link: '/' }))).toBe(true);
    expect(isOpenable(item({ kind: 'alert', summary: 's' }))).toBe(true);
    expect(isOpenable(item({ kind: 'report' }))).toBe(false);
  });
});

describe('tones', () => {
  test.each([
    [null, 'fg-4'],
    ['failed', 'status-down'],
    ['ERROR', 'status-down'],
    ['silent', 'fg-4'],
    ['ok', 'status-up'],
  ] as const)('runTone(%s) = %s', (status, token) => {
    expect(runToneToken(status)).toBe(token);
  });

  test('high priority and alerts win over the brief accent', () => {
    expect(kindToneToken(item({ kind: 'brief', priority: 'high' }))).toBe('status-warn');
    expect(kindToneToken(item({ kind: 'alert' }))).toBe('status-warn');
    expect(kindToneToken(item({ kind: 'brief' }))).toBe('accent');
    expect(kindToneToken(item({ kind: 'run' }))).toBe('fg-3');
  });

  test('every FeedKind has a glyph', () => {
    expect(Object.keys(KIND_SYMBOL).sort()).toEqual(
      ['alert', 'brief', 'report', 'run', 'status'].sort(),
    );
  });
});

describe('secondLine', () => {
  test('a run shows its status, colour-coded, never its output', () => {
    expect(secondLine(item({ kind: 'run', status: 'failed', summary: 'stack trace' }))).toEqual({
      text: 'failed',
      tone: 'status-down',
    });
  });

  test('a run with output but no status says "no status"', () => {
    expect(secondLine(item({ kind: 'run', summary: 'log' }))).toEqual({
      text: 'no status',
      tone: 'fg-4',
    });
  });

  test('everything else shows its summary', () => {
    expect(secondLine(item({ kind: 'alert', summary: 'low balance' }))).toEqual({
      text: 'low balance',
      tone: 'fg-3',
    });
  });

  test('nothing to say, no line', () => {
    expect(secondLine(item({ kind: 'report' }))).toBeNull();
  });
});

describe('externalFeedHref — the "open link →" resolver', () => {
  const ORIGIN = 'https://hub.example.com';

  test('resolves an origin-relative link, including the live alert cards\' bare "/"', () => {
    expect(externalFeedHref('/', ORIGIN)).toBe(`${ORIGIN}/`);
    expect(externalFeedHref('/my-pages/x/', ORIGIN)).toBe(`${ORIGIN}/my-pages/x/`);
  });

  test('keeps the PWA\'s scheme-only rule: an off-host https link is allowed', () => {
    // Deliberate, and the one place it differs from resolveBriefUri: this URL
    // is handed to the system browser, not mounted in a WebView.
    expect(externalFeedHref('https://status.example.com/x', ORIGIN)).toBe(
      'https://status.example.com/x',
    );
    expect(externalFeedHref('http://plain.example.com/', ORIGIN)).toBe('http://plain.example.com/');
  });

  test('rejects every non-http(s) scheme and the empty cases', () => {
    expect(externalFeedHref('javascript:alert(1)', ORIGIN)).toBeNull();
    expect(externalFeedHref('data:text/html,<b>x', ORIGIN)).toBeNull();
    expect(externalFeedHref('file:///etc/passwd', ORIGIN)).toBeNull();
    expect(externalFeedHref(null, ORIGIN)).toBeNull();
    expect(externalFeedHref('', ORIGIN)).toBeNull();
  });
});
