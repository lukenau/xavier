// briefModel is the whole contract between brief.json and the screen, so it is
// tested against the 2026-09-16 fixture's shape (liveBrief.fixture.ts) rather than
// hand-written two-item objects: 44 items, four buckets, 110 deferred, one
// stale source, 26 carried.
import {
  BRIEF_BUCKETS,
  allItems,
  bucketEmptyCopy,
  bucketView,
  canWrite,
  chipsFor,
  dateLine,
  degradedSources,
  emptyCopy,
  failureKind,
  firstClause,
  heldBackSummary,
  isEmpty,
  isStale,
  linkTarget,
  metaLine,
  originSymbol,
  resolveRelated,
  rowAccessibilityLabel,
  snoozeLabel,
  sourceStrip,
  staleServedLabel,
  terminusLine,
  untilLabel,
  writeFailureCopy,
  type Brief,
  type BriefItem,
  unresolvedSources,
} from './briefModel';
import { LIVE_BRIEF } from './liveBrief.fixture';

function item(over: Partial<BriefItem> = {}): BriefItem {
  return {
    item_id: 'aaaaaaaaaaaa',
    id: 'cal:x',
    title: 'Q4 planning day 1',
    why: 'starts 9:00 AM today — you are the organizer',
    evidence: ['9:00 AM–4:00 PM ET'],
    gate: 'O1',
    source: 'Calendar',
    origin: 'calendar',
    kind: 'event',
    split: 'work',
    when: '2026-09-16T13:00:00Z',
    age_days: 0,
    carried_from: '',
    carry_days: null,
    url: '',
    jump_url: '',
    related: [],
    conflict: false,
    token: 'a'.repeat(24),
    ...over,
  };
}

function brief(over: Partial<Brief> = {}): Brief {
  return {
    date: '2026-09-16',
    generated_at: '2026-09-16T11:20:00Z',
    buckets: { now: [], today: [], week: [], background: [] },
    deferred: [],
    held_back: { total: 0, by_code: {} },
    carried: { count: 0, candidates: 0, from_date: null },
    sources: { email: 'ok', calendar: 'ok' },
    provenance: { git_sha: 'abc1234', deployed_at: '', finished: true, candidates_sha256: '' },
    ...over,
  };
}

describe('the fixture brief round-trips through the model', () => {
  test('44 items across the four buckets, in server order', () => {
    expect(BRIEF_BUCKETS.map((b) => bucketView(LIVE_BRIEF, b).length)).toEqual([2, 20, 20, 2]);
    expect(allItems(LIVE_BRIEF)).toHaveLength(44);
    // Order is the server's — the model never re-sorts. Ranking is triage's job.
    expect(bucketView(LIVE_BRIEF, 'today').map((i) => i.item_id)).toEqual(
      LIVE_BRIEF.buckets.today.map((i) => i.item_id),
    );
  });

  test('every item carries the fields the screen renders', () => {
    for (const i of allItems(LIVE_BRIEF)) {
      expect(i.item_id).toMatch(/^[0-9a-f]{12}$/);
      expect(i.title.length).toBeGreaterThan(0);
      expect(i.why.length).toBeGreaterThan(0);
      expect(i.evidence.length).toBeGreaterThan(0);
      expect(['work', 'personal']).toContain(i.split);
    }
  });

  test('a missing brief is never a crash — every accessor tolerates undefined', () => {
    expect(bucketView(undefined, 'now')).toEqual([]);
    expect(allItems(undefined)).toEqual([]);
    expect(sourceStrip(undefined)).toEqual([]);
    expect(degradedSources(undefined)).toEqual([]);
    expect(heldBackSummary(undefined)).toBe('');
    expect(isEmpty(undefined)).toBe(true);
    expect(terminusLine(undefined)).toBe('');
    expect(staleServedLabel(undefined)).toBeNull();
  });
});

describe('sourceStrip / degradedSources exclude pipeline stages', () => {
  test('the nine real inboxes, never carry or money', () => {
    const names = sourceStrip(LIVE_BRIEF).map((s) => s.name);
    expect(names).toContain('email');
    expect(names).toContain('finance');
    expect(names).not.toContain('carry');
    expect(names).not.toContain('money');
  });

  test('a brief that still publishes stages INSIDE sources gets them filtered too', () => {
    // The pre-split shape: carry sitting among the inboxes. A degraded carry
    // stage is not an input the user can go and check, so it must not be named.
    const legacy = brief({ sources: { email: 'ok', carry: 'stale', money: 'absent', oura: 'ok' } });
    expect(sourceStrip(legacy).map((s) => s.name)).toEqual(['email', 'oura']);
    expect(degradedSources(legacy)).toEqual([]);
  });

  test('the fixture brief names exactly its one degraded input', () => {
    expect(degradedSources(LIVE_BRIEF)).toEqual(['finance']);
  });

  test('isStale is per-item, off the item’s own origin', () => {
    expect(isStale(LIVE_BRIEF, item({ origin: 'finance' }))).toBe(true);
    expect(isStale(LIVE_BRIEF, item({ origin: 'calendar' }))).toBe(false);
    // An origin the brief does not report on at all is not "stale".
    expect(isStale(LIVE_BRIEF, item({ origin: 'nowhere' }))).toBe(false);
  });
});

describe('heldBackSummary', () => {
  test('the fixture brief: total then the three biggest reasons', () => {
    expect(heldBackSummary(LIVE_BRIEF)).toBe(
      '110 held back — 26 nothing to do, 24 already done, 22 no quote to stand on',
    );
  });

  test('nothing held back yields no row at all', () => {
    expect(heldBackSummary(brief())).toBe('');
  });

  test('an unknown code degrades to its own name rather than being dropped', () => {
    expect(heldBackSummary(brief({ held_back: { total: 3, by_code: { WEIRD: 3 } } }))).toBe(
      '3 held back — 3 weird',
    );
  });
});

describe('chipsFor — a chip means "unusual"', () => {
  test('the common row has no chips at all', () => {
    expect(chipsFor(item())).toEqual([]);
  });

  test('carried reads off carry_days, NEVER age_days (Ruling 76)', () => {
    expect(chipsFor(item({ carry_days: 3, age_days: 41 }))).toEqual([
      { label: 'carried 3d', tone: 'meta' },
    ]);
    // A 41-day-old thing the brief first raised today is not "carried 41d".
    expect(chipsFor(item({ carry_days: null, age_days: 41 }))).toEqual([]);
    expect(chipsFor(item({ carry_days: 0, age_days: 41 }))).toEqual([]);
  });

  test('conflict leads, and carries the warn tone', () => {
    expect(chipsFor(item({ conflict: true, carry_days: 2 }))).toEqual([
      { label: 'conflict', tone: 'warn' },
      { label: 'carried 2d', tone: 'meta' },
    ]);
  });

  test('a stale source is NOT a chip — the banner owns that', () => {
    expect(chipsFor(item({ origin: 'finance' }))).toEqual([]);
  });

  test('the chip count is exactly the server’s own carried count', () => {
    // Cross-checks the model against the number triage computed independently
    // (`carried.count`) — if chipsFor ever read age_days instead, this diverges.
    const chipped = allItems(LIVE_BRIEF).filter((i) => chipsFor(i).length > 0);
    expect(chipped).toHaveLength(LIVE_BRIEF.carried.count);
    expect(chipped.length).toBeGreaterThan(0);
  });

  test('DESIGN TENSION, recorded not asserted away: 26 of 44 live rows are carried', () => {
    // Spec §1.3 principle 3 says a chip means "unusual". In the fixture, 59% of
    // rows carry one, which is the density at which a chip stops meaning
    // anything. The model still emits it — the rule is the spec's and Ruling 76
    // makes carry_days the right FIELD — but the threshold question ("show the
    // chip only past N days?") is the user's, not this task's. This test exists so
    // the number is visible rather than discovered on device.
    const carried = allItems(LIVE_BRIEF).filter((i) => (i.carry_days ?? 0) > 0);
    expect(carried.length / allItems(LIVE_BRIEF).length).toBeGreaterThan(0.5);
    // Whatever is decided, the chip must never be driven off age_days.
    const byAge = allItems(LIVE_BRIEF).filter((i) => (i.age_days ?? 0) > 0);
    expect(byAge.length).not.toBe(carried.length);
  });
});

describe('originSymbol / metaLine', () => {
  test.each([
    ['calendar', 'calendar'],
    ['email', 'envelope'],
    ['imessage', 'message'],
    ['capture-sync', 'desktopcomputer'],
    ['packages', 'shippingbox'],
    ['oura', 'bed.double'],
    ['finance', 'dollarsign.circle'],
  ])('%s → %s', (origin, symbol) => {
    expect(originSymbol(origin)).toBe(symbol);
  });

  test('an unknown origin still gets a glyph — a blank reads as a broken row', () => {
    expect(originSymbol('telepathy')).toBe('circle');
    expect(originSymbol('')).toBe('circle');
  });

  test('every origin in the fixture brief has a symbol of its own', () => {
    const origins = [...new Set(allItems(LIVE_BRIEF).map((i) => i.origin))];
    expect(origins.length).toBeGreaterThan(4);
    for (const o of origins) expect(originSymbol(o)).not.toBe('circle');
  });

  test('metaLine is origin · split', () => {
    expect(metaLine(item())).toBe('calendar · work');
    expect(metaLine(item({ origin: 'packages', split: 'personal' }))).toBe('packages · personal');
  });
});

describe('linkTarget — a closed allowlist', () => {
  test('the one hub route, and a stale hub path resolves to null, not a route', () => {
    expect(linkTarget(item({ url: '/oura/' }))).toEqual({
      kind: 'route',
      href: '/oura',
      label: 'Open Oura',
    });
    // A hub path whose route left the tree (deep-linkable surfaces only) is
    // the allowlist returning null, never a dead route push.
    expect(linkTarget(item({ url: '/brief' }))).toBeNull();
  });

  test('a my-pages path goes to the reader route, not the browser', () => {
    expect(linkTarget(item({ url: '/my-pages/briefing-2026-09-16/' }))).toEqual({
      kind: 'page',
      path: '/my-pages/briefing-2026-09-16/',
      label: 'Open page',
    });
  });

  test('GitHub and Jira open externally, from either url or jump_url', () => {
    expect(linkTarget(item({ jump_url: 'https://github.com/acme/w/pull/453' }))).toEqual({
      kind: 'external',
      url: 'https://github.com/acme/w/pull/453',
      label: 'Open on GitHub',
    });
    // The generator folds a source_url into `url`, so the https case shows up
    // there too — both halves must resolve.
    expect(linkTarget(item({ url: 'https://acme.atlassian.net/browse/SD-1106' }))).toEqual({
      kind: 'external',
      url: 'https://acme.atlassian.net/browse/SD-1106',
      label: 'Open in Jira',
    });
  });

  test('any other https host is NOT opened — it falls through to the app path', () => {
    // The security property: the allowlist is closed. An attacker-controlled
    // link in a gathered item must never become a tappable browser launch.
    const evil = item({ origin: 'email', jump_url: 'https://attacker.example/steal' });
    expect(linkTarget(evil)).toEqual({ kind: 'app', url: 'message://', label: 'Open Mail' });
    const evilNoOrigin = item({ origin: 'packages', url: 'https://github.evil.com/x' });
    expect(linkTarget(evilNoOrigin)).toBeNull();
    // A lookalike subdomain is not github.com.
    expect(linkTarget(item({ origin: 'packages', jump_url: 'https://github.com.evil.io/x' }))).toBeNull();
  });

  test('origin app launches are the degraded path, in priority order', () => {
    expect(linkTarget(item({ origin: 'email' }))?.label).toBe('Open Mail');
    expect(linkTarget(item({ origin: 'imessage' }))?.label).toBe('Open Messages');
    expect(linkTarget(item({ origin: 'calendar' }))?.label).toBe('Open Calendar');
  });

  test('an origin with nowhere to go has NO action row', () => {
    expect(linkTarget(item({ origin: 'packages' }))).toBeNull();
    expect(linkTarget(item({ origin: 'capture-sync' }))).toBeNull();
  });

  test('the fixture brief resolves a target for every item, or an honest null', () => {
    // Link coverage is thin by design (§9 gap 2): most items have no source
    // URL, so most resolve to an app launch or to nothing. What must never
    // happen is a THROW or a half-built target.
    for (const i of allItems(LIVE_BRIEF)) {
      const target = linkTarget(i);
      if (target) expect(target.label.length).toBeGreaterThan(0);
    }
    expect(allItems(LIVE_BRIEF).some((i) => linkTarget(i)?.kind === 'route')).toBe(true);
  });
});

describe('resolveRelated drops dangling ids', () => {
  test('only ids that are actually on screen come back', () => {
    const a = item({ item_id: 'aaaaaaaaaaaa', related: ['bbbbbbbbbbbb', 'cccccccccccc'] });
    const b = item({ item_id: 'bbbbbbbbbbbb' });
    const withBoth = brief({ buckets: { now: [a], today: [b], week: [], background: [] } });
    // 'cccccccccccc' was deferred (or dismissed after the brief was minted) —
    // it must not render as a dead row.
    expect(resolveRelated(withBoth, a).map((i) => i.item_id)).toEqual(['bbbbbbbbbbbb']);
  });

  test('an item never relates to itself', () => {
    const a = item({ item_id: 'aaaaaaaaaaaa', related: ['aaaaaaaaaaaa'] });
    expect(resolveRelated(brief({ buckets: { now: [a], today: [], week: [], background: [] } }), a)).toEqual([]);
  });

  test('the fixture brief’s related links all resolve or are dropped, never crash', () => {
    const withRelated = allItems(LIVE_BRIEF).filter((i) => i.related.length > 0);
    expect(withRelated.length).toBeGreaterThan(0);
    for (const i of withRelated) {
      for (const r of resolveRelated(LIVE_BRIEF, i)) {
        expect(allItems(LIVE_BRIEF)).toContainEqual(r);
      }
    }
  });
});

describe('snooze labels', () => {
  const tuesday = new Date(2026, 8, 16); // Wed Sep 16 2026 local

  test('1d is named, not dated', () => {
    expect(snoozeLabel('1d', tuesday)).toBe('tomorrow (Thu)');
  });

  test('3d names the weekday and the span', () => {
    expect(snoozeLabel('3d', tuesday)).toBe('Sat (3 days)');
  });

  test('1w is a date, because a weekday a week out is ambiguous', () => {
    expect(snoozeLabel('1w', tuesday)).toBe('Sep 23');
  });

  test('crossing a month boundary still reads right', () => {
    expect(snoozeLabel('1w', new Date(2026, 8, 28))).toBe('Oct 5');
  });

  test('the server’s own `until` wins over the local computation', () => {
    expect(untilLabel('2026-09-19T12:00:00', '3d', tuesday)).toBe('Sat (3 days)');
    expect(untilLabel('2026-09-23T12:00:00', '1w', tuesday)).toBe('Sep 23');
  });

  test('a missing or unparseable `until` falls back rather than printing NaN', () => {
    expect(untilLabel(undefined, '1d', tuesday)).toBe('tomorrow (Thu)');
    expect(untilLabel('not a date', '1d', tuesday)).toBe('tomorrow (Thu)');
  });
});

describe('the empty brief is a GOOD outcome', () => {
  test('no items and healthy inputs reads calm', () => {
    const clear = brief();
    expect(isEmpty(clear)).toBe(true);
    expect(emptyCopy(clear)).toEqual({
      title: 'Your day is clear.',
      detail: 'Nothing made it through the gate today.',
      tone: 'calm',
    });
  });

  test('no items AND degraded inputs never claims the day is clear', () => {
    const blind = brief({ sources: { email: 'unreachable', calendar: 'absent', oura: 'ok' } });
    const copy = emptyCopy(blind);
    expect(copy.tone).toBe('degraded');
    expect(copy.title).toBe('Most of your inputs are missing');
    expect(copy.title).not.toMatch(/clear/i);
    expect(copy.detail).not.toMatch(/nothing needs you/i);
    expect(copy.detail).toContain('email');
    expect(copy.detail).toContain('calendar');
  });

  test('one degraded input reads "is", not "are"', () => {
    expect(emptyCopy(brief({ sources: { email: 'stale' } })).detail).toContain('email is not reporting');
  });

  test('the fixture brief is not empty', () => {
    expect(isEmpty(LIVE_BRIEF)).toBe(false);
  });

  test('per-bucket empty copy is calm; Background has none because it is omitted', () => {
    expect(bucketEmptyCopy('now')).toBe('Nothing needs you this minute.');
    expect(bucketEmptyCopy('today')).toBe('Nothing has to move today.');
    expect(bucketEmptyCopy('week')).toBe('Nothing dated this week.');
    expect(bucketEmptyCopy('background')).toBeNull();
    for (const b of ['now', 'today', 'week'] as const) {
      expect(bucketEmptyCopy(b)).not.toMatch(/error|fail|unable/i);
    }
  });
});

describe('header and terminus', () => {
  test('dateLine is a weekday and a date, built from the LOCAL calendar', () => {
    // Parsed field-by-field on purpose: `new Date('2026-09-16')` is UTC
    // midnight, which is Sep 15 in every American timezone.
    expect(dateLine('2026-09-16')).toBe('Wed Sep 16');
    expect(dateLine('2026-01-01')).toBe('Thu Jan 1');
  });

  test('a malformed date passes through rather than printing Invalid Date', () => {
    expect(dateLine('')).toBe('');
    expect(dateLine('whenever')).toBe('whenever');
  });

  test('staleServedLabel fires only when the server fell back to an older day', () => {
    expect(staleServedLabel(LIVE_BRIEF)).toBeNull();
    expect(staleServedLabel(brief({ date: '2026-09-16', served_date: '2026-09-16' }))).toBeNull();
    expect(staleServedLabel(brief({ date: '2026-09-16', served_date: '2026-09-14' }))).toBe(
      "showing Mon Sep 14 — today's brief hasn't landed",
    );
  });

  test('terminusLine carries the clock and the build', () => {
    const line = terminusLine(LIVE_BRIEF);
    expect(line).toMatch(/^Generated \d{2}:\d{2} · build [0-9a-f]{7}$/);
  });

  test('an unfinished run says so — a truncated brief must not look complete', () => {
    const partial = brief({
      provenance: { git_sha: 'abc1234', deployed_at: '', finished: false, candidates_sha256: '' },
    });
    expect(terminusLine(partial)).toContain('run did not finish');
  });
});

describe('firstClause — the week row’s terser meta', () => {
  test('cuts at the first clause break', () => {
    expect(firstClause('waiting on your reply — asked 3 days ago')).toBe('waiting on your reply');
    expect(firstClause('due Friday; the PR is green')).toBe('due Friday');
  });

  test('a short why is left whole rather than cut to nothing', () => {
    expect(firstClause('due today')).toBe('due today');
    expect(firstClause('you — them')).toBe('you — them');
  });

  test('empty in, empty out', () => {
    expect(firstClause('')).toBe('');
  });

  test('every live why survives the cut with something left to read', () => {
    for (const i of allItems(LIVE_BRIEF)) {
      expect(firstClause(i.why).length).toBeGreaterThan(0);
    }
  });
});

describe('accessibility label', () => {
  test('title, why and source in one spoken sentence', () => {
    expect(rowAccessibilityLabel(item())).toBe(
      'Q4 planning day 1. starts 9:00 AM today — you are the organizer. Calendar',
    );
  });

  test('a carried item says how long, in words', () => {
    expect(rowAccessibilityLabel(item({ carry_days: 1 }))).toContain('carried 1 day');
    expect(rowAccessibilityLabel(item({ carry_days: 4 }))).toContain('carried 4 days');
  });

  test('a conflict is spoken, not left to the visual chip', () => {
    expect(rowAccessibilityLabel(item({ conflict: true }))).toContain('conflicts with another item');
  });

  test('every live row produces a non-empty label', () => {
    for (const i of allItems(LIVE_BRIEF)) {
      expect(rowAccessibilityLabel(i).length).toBeGreaterThan(10);
    }
  });
});

describe('the write gate degrades rather than 403ing', () => {
  test('an item with a token can be written', () => {
    expect(canWrite(item())).toBe(true);
  });

  test('a brief minted before tokens existed cannot — and says so', () => {
    expect(canWrite(item({ token: undefined }))).toBe(false);
    expect(canWrite(item({ token: '' }))).toBe(false);
    expect(writeFailureCopy('untokened')).toContain('pull to refresh');
  });

  test('403 and 503 are DIFFERENT outcomes with different copy', () => {
    expect(failureKind(403)).toBe('expired');
    expect(failureKind(503)).toBe('offline');
    expect(failureKind(undefined)).toBe('network');
    expect(failureKind(500)).toBe('network');
    expect(writeFailureCopy('expired')).not.toBe(writeFailureCopy('offline'));
    expect(writeFailureCopy('expired')).toContain('expired');
    expect(writeFailureCopy('offline')).toContain('offline');
    expect(writeFailureCopy('network')).toContain('nothing was sent');
  });

  test('every live item carries a 24-hex token', () => {
    for (const i of allItems(LIVE_BRIEF)) {
      expect(canWrite(i)).toBe(true);
      expect(i.token).toMatch(/^[0-9a-f]{24}$/);
    }
  });
});

describe('the banner drops a source the live probe says is back (the user, 2026-09-22)', () => {
  test('a reconnected source is not named, however the brief’s snapshot reads', () => {
    const b = brief({
      sources: { email: 'unreachable', calendar: 'unreachable', packages: 'unreachable' },
      live_sources: { email: 'ok', calendar: 'ok', packages: 'down' },
    });
    expect(unresolvedSources(b)).toEqual(['packages']);
  });

  test('no live opinion leaves the snapshot alone — silence is not health', () => {
    const b = brief({ sources: { email: 'unreachable' }, live_sources: {} });
    expect(unresolvedSources(b)).toEqual(['email']);
  });

  test('every source back means the banner says nothing', () => {
    const b = brief({
      sources: { email: 'unreachable', calendar: 'unreachable' },
      live_sources: { email: 'ok', calendar: 'ok' },
    });
    expect(unresolvedSources(b)).toEqual([]);
  });
});
