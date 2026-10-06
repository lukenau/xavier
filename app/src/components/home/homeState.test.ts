import {
  attentionChips,
  shadowBlurRadius,
  briefCardView,
  decisionsBannerView,
  discordSession,
  fmtWhen,
  formatClock,
  formatHeaderDate,
  healthDot,
  healthStaleness,
  stakesOf,
  STALE_AFTER_S,
} from './homeState';
import type { AgentSession, BackupStatus, Decision, HealthSummary, MyPage, Service } from '../../lib/types';

// The date/time assertions below pin the PWA's own
// `toLocaleTimeString([], …)` / `toLocaleDateString([], …)` output. They are
// only meaningful under this suite's default locale, so that is asserted
// first: a different default would be an environment change worth failing on
// rather than silently reinterpreting.
test('the suite runs under the locale these formatter expectations were written for', () => {
  expect(Intl.DateTimeFormat().resolvedOptions().locale).toBe('en-US');
});

const NOW = Date.parse('2026-09-10T18:00:00Z');

function health(over: Partial<HealthSummary> = {}): HealthSummary {
  return {
    updated_at: new Date(NOW - 60_000).toISOString(),
    overall: 'green',
    services: [],
    ...over,
  };
}

const service = (name: string, status: Service['status']): Service =>
  ({ name, status }) as Service;

describe('health staleness (Header.tsx:15-19,32-40)', () => {
  test('measures the feed age in seconds', () => {
    expect(healthStaleness(health(), NOW)).toBe(60);
  });

  test('no updated_at is null, not zero', () => {
    expect(healthStaleness(health({ updated_at: null }), NOW)).toBeNull();
    expect(healthStaleness(undefined, NOW)).toBeNull();
  });

  test('an unparseable timestamp is null rather than NaN', () => {
    expect(healthStaleness(health({ updated_at: 'not a date' }), NOW)).toBeNull();
  });

  test('a fresh green feed is green, glowing, and labelled', () => {
    expect(healthDot(health(), NOW)).toEqual({
      token: 'status-up',
      stale: false,
      label: 'health green',
      glow: true,
    });
  });

  test('amber and red map to their own tokens and never glow', () => {
    expect(healthDot(health({ overall: 'amber' }), NOW)).toMatchObject({
      token: 'status-warn',
      glow: false,
      label: 'health amber',
    });
    expect(healthDot(health({ overall: 'red' }), NOW)).toMatchObject({
      token: 'status-down',
      glow: false,
    });
  });

  test('past 15 minutes the dot goes grey whatever the feed claims', () => {
    const stale = health({ updated_at: new Date(NOW - (STALE_AFTER_S + 1) * 1000).toISOString() });
    expect(healthDot(stale, NOW)).toEqual({
      token: 'fg-4',
      stale: true,
      label: 'health feed stale',
      glow: false,
    });
    // …and exactly at the threshold it is still trusted.
    const edge = health({ updated_at: new Date(NOW - STALE_AFTER_S * 1000).toISOString() });
    expect(healthDot(edge, NOW).stale).toBe(false);
  });

  test('no health at all is stale, not a green default', () => {
    expect(healthDot(undefined, NOW)).toMatchObject({ token: 'fg-4', stale: true });
  });
});

describe('the wordmark glow radius (Header.tsx)', () => {
  // Real token values quoted as parser input: the colour is the part this
  // function must ignore, which is why it is here at all.
  test('reads the blur out of a shadow token, so it follows a token change', () => {
    expect(shadowBlurRadius('0 0 10px rgba(240, 171, 94, 0.34)')).toBe(10); // theme-exempt: --glow-text, dark
    expect(shadowBlurRadius('0 0 0 2.5px rgba(240, 171, 94, 0.34)')).toBe(0); // theme-exempt: --glow-accent, light
    expect(shadowBlurRadius('0 10px 28px rgba(0, 0, 0, 0.4)')).toBe(28); // theme-exempt: --shadow-menu
  });

  test('`none` — the light-scheme value — and junk mean no shadow at all', () => {
    expect(shadowBlurRadius('none')).toBeNull();
    expect(shadowBlurRadius('')).toBeNull();
    expect(shadowBlurRadius('inset 0 0 4px red')).toBeNull();
  });
});

describe('the header date and the app clock', () => {
  test('weekday, month and day — no time', () => {
    expect(formatHeaderDate(new Date(2026, 8, 10, 13, 5))).toBe('Thu, Sep 10');
  });

  test('the clock is 12-hour with a zero-padded minute', () => {
    expect(formatClock(new Date(2026, 8, 10, 13, 5).getTime())).toBe('1:05 PM');
    expect(formatClock(new Date(2026, 8, 10, 0, 30).getTime())).toBe('12:30 AM');
  });
});

describe('decisions banner (Home.tsx:103-145)', () => {
  const decision = (over: Partial<Decision>): Decision =>
    ({ id: 'd', title: 'T', summary: '', options: [], source: 's', created: '', status: 'open', ...over }) as Decision;

  test('an empty queue renders nothing', () => {
    expect(decisionsBannerView([])).toBeNull();
  });

  test('a missing or unknown category never under-alerts', () => {
    expect(stakesOf(decision({ category: undefined }))).toBe('required');
    expect(stakesOf(decision({ category: 'whatever' }))).toBe('required');
    expect(stakesOf(decision({ category: 'frozen' }))).toBe('frozen');
  });

  test('the headline is stakes-honest and singular-aware', () => {
    expect(
      decisionsBannerView([decision({ category: 'required', title: 'A' })])?.headline,
    ).toBe('1 needs your answer');
    expect(
      decisionsBannerView([
        decision({ category: 'required', title: 'A' }),
        decision({ category: 'required', title: 'B' }),
        decision({ category: 'tradeoff' }),
        decision({ category: 'info' }),
        decision({ category: 'frozen' }),
      ])?.headline,
    ).toBe('2 need your answer · 1 your call · 1 for later · 1 frozen');
  });

  test('the subline lists required titles only, two then an ellipsis', () => {
    const view = decisionsBannerView([
      decision({ category: 'required', title: 'A' }),
      decision({ category: 'required', title: 'B' }),
      decision({ category: 'required', title: 'C' }),
      decision({ category: 'tradeoff', title: 'D' }),
    ]);
    expect(view?.subline).toBe('A · B · …');
  });

  test('no required cards leaves the subline empty', () => {
    expect(decisionsBannerView([decision({ category: 'info', title: 'A' })])?.subline).toBe('');
  });
});

describe('brief card (Home.tsx:35-44)', () => {
  const page = (over: Partial<MyPage>): MyPage =>
    ({ slug: 'briefing-2026-09-10', title: 'Daily briefing', mtime: null, kind: 'brief', ...over }) as MyPage;

  test('no brief in the library renders nothing', () => {
    expect(briefCardView(undefined)).toBeNull();
    expect(briefCardView([page({ kind: 'page', slug: 'notes' })])).toBeNull();
  });

  test("today's brief shows when it was generated", () => {
    const at = new Date(2026, 8, 10, 7, 15);
    const view = briefCardView([page({ mtime: at.getTime() / 1000 })], new Date(2026, 8, 10, 9, 0));
    expect(view?.missingToday).toBe(false);
    expect(view?.subline).toBe('generated 7:15 AM');
  });

  test('a brief with no mtime falls back to the plain label', () => {
    expect(briefCardView([page({})], new Date(Date.UTC(2026, 8, 10, 5, 0)))?.subline).toBe('daily brief');
  });

  test("an older brief after 08:00 local says today's has not landed", () => {
    const view = briefCardView(
      [page({ slug: 'briefing-2026-09-09', mtime: 1 })],
      new Date(2026, 8, 10, 8, 0),
    );
    expect(view?.missingToday).toBe(true);
    expect(view?.subline).toBe("latest is 2026-09-09 — today's brief hasn't landed");
  });

  test('before 08:00 local a stale brief is not flagged', () => {
    const view = briefCardView(
      [page({ slug: 'briefing-2026-09-09', mtime: 1 })],
      new Date(2026, 8, 10, 7, 59),
    );
    expect(view?.missingToday).toBe(false);
  });
});

describe('pages shelf timestamps (PagesShelf.tsx:9-15)', () => {
  test('no mtime prints nothing', () => {
    expect(fmtWhen(null)).toBe('');
  });

  test('under a day old shows the clock, older shows the date', () => {
    const ms = new Date(2026, 8, 10, 14, 30).getTime();
    expect(fmtWhen(ms / 1000, ms + 3600_000)).toBe('2:30 PM');
    expect(fmtWhen(ms / 1000, ms + 86_400_000 + 1)).toBe('Sep 10');
  });
});

describe('discord row', () => {
  const session = (source: string): AgentSession => ({ source }) as AgentSession;

  test('picks the first discord session and nothing else', () => {
    expect(discordSession([session('cli'), session('discord'), session('discord')])?.source).toBe('discord');
    expect(discordSession([session('cli')])).toBeUndefined();
    expect(discordSession(undefined)).toBeUndefined();
  });
});

describe('attention chips (Home.tsx:173-197)', () => {
  const backups = (ts: string | undefined, rel = '3d ago'): BackupStatus =>
    ({ rel_time: rel, ...(ts ? { latest: { ts } } : {}) }) as BackupStatus;

  test('silence is the healthy state', () => {
    expect(
      attentionChips({
        health: health({ services: [service('hub', 'up')] }),
        backups: backups(new Date(NOW - 3600_000).toISOString()),
        failedRuns: 0,
        now: NOW,
      }),
    ).toEqual([]);
  });

  test('failed runs come first and link to the feed', () => {
    const chips = attentionChips({ health: health(), backups: undefined, failedRuns: 1, now: NOW });
    expect(chips[0]).toEqual({ label: '1 failed run', href: '/feed' });
    expect(
      attentionChips({ health: health(), backups: undefined, failedRuns: 2, now: NOW })[0].label,
    ).toBe('2 failed runs');
  });

  test('a stale feed reports its age in hours, then days', () => {
    const hours = attentionChips({
      health: health({ updated_at: new Date(NOW - 3 * 3600_000).toISOString() }),
      backups: undefined,
      failedRuns: 0,
      now: NOW,
    });
    expect(hours).toEqual([{ label: 'health feed stale 3h', href: '/ops' }]);
    const days = attentionChips({
      health: health({ updated_at: new Date(NOW - 50 * 3600_000).toISOString() }),
      backups: undefined,
      failedRuns: 0,
      now: NOW,
    });
    expect(days).toEqual([{ label: 'health feed stale 2d', href: '/ops' }]);
  });

  test('a null age is NOT a chip, though the header dot goes grey for it', () => {
    expect(
      attentionChips({ health: health({ updated_at: null }), backups: undefined, failedRuns: 0, now: NOW }),
    ).toEqual([]);
    expect(healthDot(health({ updated_at: null }), NOW).stale).toBe(true);
  });

  test('down services are named, but only while the feed is fresh', () => {
    expect(
      attentionChips({
        health: health({ services: [service('hub-api', 'down'), service('trader', 'down')] }),
        backups: undefined,
        failedRuns: 0,
        now: NOW,
      }),
    ).toEqual([{ label: 'down: hub-api, trader', href: '/ops' }]);
    const stale = attentionChips({
      health: health({
        updated_at: new Date(NOW - 3 * 3600_000).toISOString(),
        services: [service('hub-api', 'down')],
      }),
      backups: undefined,
      failedRuns: 0,
      now: NOW,
    });
    expect(stale.map((c) => c.label)).toEqual(['health feed stale 3h']);
  });

  test('a backup older than 48h is a chip with nowhere to go', () => {
    const old = attentionChips({
      health: health(),
      backups: backups(new Date(NOW - 49 * 3600_000).toISOString(), '2d ago'),
      failedRuns: 0,
      now: NOW,
    });
    expect(old).toEqual([{ label: 'last backup 2d ago' }]);
    expect(old[0].href).toBeUndefined();
    const fresh = attentionChips({
      health: health(),
      backups: backups(new Date(NOW - 47 * 3600_000).toISOString()),
      failedRuns: 0,
      now: NOW,
    });
    expect(fresh).toEqual([]);
  });
});
