import {
  browserCardView,
  domainOf,
  fmtDuration,
  pathOf,
  recentRowText,
  RECENT_FRESH_MS,
} from './browserState';
import type { BrowserSessionLive, BrowserSessionRecent, BrowserSessions } from '../../lib/types';

const NOW = Date.parse('2026-09-10T18:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const live = (over: Partial<BrowserSessionLive> = {}): BrowserSessionLive => ({
  id: 'live-1',
  started_at: iso(120_000),
  region: null,
  live_url: 'https://connect.browserbase.com/devtools/x',
  current_url: 'https://www.nytimes.com/section/world',
  pages: [],
  ...over,
});

const recent = (over: Partial<BrowserSessionRecent> = {}): BrowserSessionRecent => ({
  id: 'past-1',
  status: 'COMPLETED',
  started_at: iso(3600_000),
  ended_at: iso(1800_000),
  duration_s: 240,
  pages: ['https://example.com/a'],
  ...over,
});

const sessions = (over: Partial<BrowserSessions> = {}): BrowserSessions => ({
  running: [],
  recent: [],
  updated_at: '',
  ...over,
});

describe('URL display (BrowserCard.tsx:22-38)', () => {
  test('the domain drops www and the scheme', () => {
    expect(domainOf('https://www.nytimes.com/section/world')).toBe('nytimes.com');
    expect(domainOf('http://localhost:8090/api')).toBe('localhost');
  });

  test('anything unparseable falls back to the raw string, as the PWA try/catch does', () => {
    expect(domainOf('not a url')).toBe('not a url');
    expect(domainOf('')).toBe('');
  });

  test('the path is blank at the root and truncated past 34 characters', () => {
    expect(pathOf('https://example.com')).toBe('');
    expect(pathOf('https://example.com/')).toBe('');
    expect(pathOf('https://example.com/a/b?q=1#x')).toBe('/a/b');
    const long = `https://example.com/${'p'.repeat(40)}`;
    expect(pathOf(long)).toHaveLength(34);
    expect(pathOf(long).endsWith('…')).toBe(true);
    expect(pathOf('nonsense')).toBe('');
  });

  test('durations switch from seconds to minutes at 90s', () => {
    expect(fmtDuration(null)).toBe('');
    expect(fmtDuration(89)).toBe('89s');
    expect(fmtDuration(90)).toBe('2m');
    expect(fmtDuration(240)).toBe('4m');
  });
});

describe('card presence (BrowserCard.tsx:136-142)', () => {
  test('no payload at all — no key, unreachable, or still loading — renders nothing', () => {
    expect(browserCardView(null, NOW)).toBeNull();
    expect(browserCardView(undefined, NOW)).toBeNull();
  });

  test('a session that ended more than two hours ago is gone', () => {
    // Literal two hours, not RECENT_FRESH_MS: a test written against the
    // constant moves with it and guards nothing.
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    expect(RECENT_FRESH_MS).toBe(TWO_HOURS);
    const stale = sessions({ recent: [recent({ ended_at: iso(TWO_HOURS + 1000) })] });
    expect(browserCardView(stale, NOW)).toBeNull();
    const fresh = sessions({ recent: [recent({ ended_at: iso(TWO_HOURS - 1000) })] });
    expect(browserCardView(fresh, NOW)).not.toBeNull();
  });

  test('a recent session with no end time cannot keep the card alive on its own', () => {
    expect(browserCardView(sessions({ recent: [recent({ ended_at: null })] }), NOW)).toBeNull();
  });

  test('a running session names the site and offers the live view', () => {
    const view = browserCardView(sessions({ running: [live()] }), NOW);
    expect(view?.title).toBe('browsing nytimes.com — watch live');
    expect(view?.subline).toBe('started 2m ago');
    expect(view?.sheetTitle).toBe('Live browser');
  });

  test('a running session with no current URL still says it is browsing', () => {
    const view = browserCardView(sessions({ running: [live({ current_url: null })] }), NOW);
    expect(view?.title).toBe('browsing now — watch live');
  });

  test('a finished session reads as history', () => {
    const view = browserCardView(sessions({ recent: [recent()] }), NOW);
    expect(view?.title).toBe('browsed example.com 30m ago');
    expect(view?.subline).toBe('session history →');
    expect(view?.sheetTitle).toBe('Browsing history');
  });

  test('a finished session with no itinerary keeps the PWA double space (OQ-11)', () => {
    const view = browserCardView(sessions({ recent: [recent({ pages: [] })] }), NOW);
    expect(view?.title).toBe('browsed  30m ago');
  });

  test('a live session outranks a fresh recent one', () => {
    const view = browserCardView(sessions({ running: [live()], recent: [recent()] }), NOW);
    expect(view?.sheetTitle).toBe('Live browser');
  });
});

describe('past-session rows (BrowserCard.tsx:100-113)', () => {
  test('the summary counts the extra pages', () => {
    expect(
      recentRowText(recent({ pages: ['https://a.com/1', 'https://b.com/2', 'https://c.com'] }), NOW).summary,
    ).toBe('a.com +2');
    expect(recentRowText(recent(), NOW).summary).toBe('example.com');
  });

  test('with no pages it falls back to the lowercased status', () => {
    expect(recentRowText(recent({ pages: [], status: 'TIMED_OUT' }), NOW).summary).toBe('timed_out');
    expect(recentRowText(recent({ pages: [], status: null }), NOW).summary).toBe('');
  });

  test('the meta line is when it started plus how long it ran', () => {
    expect(recentRowText(recent(), NOW).meta).toBe('1h ago · 4m');
    expect(recentRowText(recent({ duration_s: null }), NOW).meta).toBe('1h ago');
  });
});
