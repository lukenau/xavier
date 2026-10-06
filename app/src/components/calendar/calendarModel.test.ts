import type { CalendarWeek, WireEvent } from '../../lib/calendarTypes';
import {
  addDays,
  agendaSections,
  coverage,
  coverageFor,
  fetchRange,
  freshness,
  freshnessFor,
  hiddenCount,
  isHidden,
  visibleEvents,
  inSyncedWindow,
  isoDate,
  nextBusyDay,
  nextUp,
  rangeFor,
  rangeTitle,
  step,
  toDays,
  whenLabel,
  windowLabel,
} from './calendarModel';

// Jest sandboxes process.env, so a TZ set here never reaches Date and the
// suite runs in whatever zone the host is in. The inputs are therefore built
// from a local wall-clock time and written in some OTHER offset: the model has
// to bring them back to the local day and minute, whichever zone that is.
function at(date: string, hhmm: string, offsetMin: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  const shifted = new Date(new Date(y, m - 1, d, h, min).getTime() + offsetMin * 60_000);
  const abs = Math.abs(offsetMin);
  const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');
  return `${shifted.toISOString().slice(0, 19)}${offsetMin < 0 ? '-' : '+'}${pad(abs / 60)}:${pad(abs % 60)}`;
}

test('the helper writes one instant in any offset', () => {
  const local = new Date(2026, 8, 29, 11, 30).getTime();
  expect(new Date(at('2026-09-29', '11:30', -240)).getTime()).toBe(local);
  expect(new Date(at('2026-09-29', '11:30', 540)).getTime()).toBe(local);
  expect(at('2026-09-29', '11:30', 540)).toMatch(/\+09:00$/);
});

function timed(id: string, start: string, end: string, over: Partial<WireEvent> = {}): WireEvent {
  return {
    id,
    title: id,
    account: 'work',
    all_day: false,
    start,
    end,
    start_date: null,
    end_date: null,
    location: null,
    conference_url: null,
    organizer: null,
    attendee_count: null,
    unconfirmed: false,
    ...over,
  };
}

function allDay(id: string, startDate: string, endDate: string, over: Partial<WireEvent> = {}): WireEvent {
  return timed(id, '', '', { all_day: true, start: null, end: null, start_date: startDate, end_date: endDate, ...over });
}

function on(days: ReturnType<typeof toDays>, date: string) {
  return days.find((d) => d.date === date)?.events ?? [];
}

describe('dates', () => {
  test('isoDate is the local calendar date', () => {
    expect(isoDate(new Date(2026, 8, 29, 23, 59))).toBe('2026-09-29');
  });

  test('addDays crosses months and years', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  test('addDays is not thrown by the autumn clock change', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
  });
});

describe('toDays', () => {
  test('returns every date in the range, empty ones included', () => {
    const days = toDays([], '2026-09-28', '2026-10-04');
    expect(days.map((d) => d.date)).toEqual([
      '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
    ]);
    expect(days.every((d) => d.events.length === 0)).toBe(true);
  });

  test('a week across the clock change is still seven different days', () => {
    const dates = toDays([], '2026-11-01', '2026-11-07').map((d) => d.date);
    expect(new Set(dates).size).toBe(7);
    expect(dates[6]).toBe('2026-11-07');
  });

  test('a timed event lands on its day at its minute', () => {
    const [e] = on(toDays([timed('a', at('2026-09-29', '11:30', -240), at('2026-09-29', '12:00', -240))], '2026-09-29', '2026-09-29'), '2026-09-29');
    expect([e.startMin, e.endMin]).toEqual([690, 720]);
  });

  test('the same instant written in a far-off offset lands identically', () => {
    const [e] = on(toDays([timed('a', at('2026-09-29', '11:30', 540), at('2026-09-29', '12:00', 540))], '2026-09-29', '2026-09-29'), '2026-09-29');
    expect([e.startMin, e.endMin]).toEqual([690, 720]);
  });

  test('an event already in tomorrow by its own offset belongs to the local evening', () => {
    const days = toDays([timed('a', at('2026-09-30', '23:30', 540), at('2026-10-01', '00:00', 540))], '2026-09-30', '2026-10-01');
    expect(on(days, '2026-09-30').map((e) => e.startMin)).toEqual([1410]);
    expect(on(days, '2026-10-01')).toEqual([]);
  });

  test('an event running past midnight is split at the day boundary', () => {
    const days = toDays([timed('n', at('2026-09-29', '23:00', -240), at('2026-09-30', '01:00', -240))], '2026-09-29', '2026-09-30');
    expect(on(days, '2026-09-29').map((e) => [e.startMin, e.endMin])).toEqual([[1380, 1440]]);
    expect(on(days, '2026-09-30').map((e) => [e.startMin, e.endMin])).toEqual([[0, 60]]);
  });

  test('an event ending exactly at midnight does not spill into the next day', () => {
    const days = toDays([timed('n', at('2026-09-29', '22:00', -240), at('2026-09-30', '00:00', -240))], '2026-09-29', '2026-09-30');
    expect(on(days, '2026-09-29').map((e) => [e.startMin, e.endMin])).toEqual([[1320, 1440]]);
    expect(on(days, '2026-09-30')).toEqual([]);
  });

  test('a multi-day all-day event is on every day it covers and not the exclusive end', () => {
    const days = toDays([allDay('v', '2026-09-26', '2026-10-07')], '2026-09-25', '2026-10-08');
    const covered = days.filter((d) => d.events.length > 0).map((d) => d.date);
    expect(covered[0]).toBe('2026-09-26');
    expect(covered[covered.length - 1]).toBe('2026-10-06');
    expect(covered).toHaveLength(11);
    expect(on(days, '2026-09-30')[0].startMin).toBeNull();
  });

  test('a one-day all-day event is on exactly one day', () => {
    const days = toDays([allDay('h', '2026-10-01', '2026-10-02')], '2026-09-28', '2026-10-04');
    expect(days.filter((d) => d.events.length > 0).map((d) => d.date)).toEqual(['2026-10-01']);
  });

  test('all-day events lead the day, then events run in start order', () => {
    const days = toDays(
      [
        timed('late', at('2026-09-29', '15:00', -240), at('2026-09-29', '16:00', -240)),
        allDay('whole', '2026-09-29', '2026-09-30'),
        timed('early', at('2026-09-29', '09:00', -240), at('2026-09-29', '10:00', -240)),
      ],
      '2026-09-29',
      '2026-09-29',
    );
    expect(on(days, '2026-09-29').map((e) => e.id)).toEqual(['whole', 'early', 'late']);
  });

  test('personal events carry the accent and work events stay quiet', () => {
    const days = toDays(
      [
        timed('w', at('2026-09-29', '09:00', -240), at('2026-09-29', '10:00', -240)),
        timed('p', at('2026-09-29', '11:00', -240), at('2026-09-29', '12:00', -240), { account: 'personal' }),
      ],
      '2026-09-29',
      '2026-09-29',
    );
    expect(on(days, '2026-09-29').map((e) => e.tone)).toEqual(['neutral', 'accent']);
  });

  test('each entry keeps the event it came from', () => {
    const wire = timed('a', at('2026-09-29', '11:30', -240), at('2026-09-29', '12:00', -240), { location: 'Room 5' });
    const [e] = on(toDays([wire], '2026-09-29', '2026-09-29'), '2026-09-29');
    expect(e.wire).toBe(wire);
    expect(e.location).toBe('Room 5');
  });

  test('an event that never ends costs no more than the days that were asked for', () => {
    // A model's "no end date" is year 9999. Walking every day it covers took
    // 14 s in node, and Home calls this on every render.
    const forever = [allDay('leave', '2026-10-01', '9999-12-31'), timed('long', at('2026-10-02', '09:00', -240), '9999-12-31T00:00:00+00:00')];
    const began = Date.now();
    const days = toDays(forever, '2026-09-28', '2026-10-04');
    const next = nextUp(forever, new Date(2026, 9, 3, 8, 0));
    const label = whenLabel(forever[0]);
    expect(Date.now() - began).toBeLessThan(500);
    expect(days.filter((d) => d.events.length > 0).map((d) => d.date)).toEqual([
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
    ]);
    // A whole middle day of a long timed event is drawn as all-day, not as a
    // block from 0:00 to 24:00.
    expect(on(days, '2026-10-03').map((e) => [e.id, e.startMin, e.endMin])).toEqual([
      ['leave', null, null],
      ['long', null, null],
    ]);
    expect(next.map((n) => n.event.id)).toEqual([]);
    expect(label).toContain('Oct 1');
  });

  test('an event that began long ago is still on the days asked for', () => {
    const days = toDays([allDay('old', '2001-01-01', '2026-09-30')], '2026-09-28', '2026-10-04');
    expect(days.filter((d) => d.events.length > 0).map((d) => d.date)).toEqual(['2026-09-28', '2026-09-29']);
  });

  test('an event that cannot be placed is left out rather than drawn at midnight', () => {
    const days = toDays(
      [timed('bad', 'soon', 'later'), allDay('worse', 'someday', 'never'), timed('nulls', '', '', { start: null, end: null })],
      '2026-09-29',
      '2026-09-29',
    );
    expect(on(days, '2026-09-29')).toEqual([]);
  });
});

describe('ranges and stepping', () => {
  test('a day is itself', () => {
    expect(rangeFor('day', '2026-09-30')).toEqual({ from: '2026-09-30', to: '2026-09-30' });
  });

  test('a week runs Sunday to Saturday, like the month grid', () => {
    expect(rangeFor('week', '2026-09-30')).toEqual({ from: '2026-09-27', to: '2026-10-03' });
    expect(rangeFor('week', '2026-09-27')).toEqual({ from: '2026-09-27', to: '2026-10-03' });
  });

  test('a month is its first to its last day', () => {
    expect(rangeFor('month', '2026-09-30')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(rangeFor('month', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  test('the agenda is two weeks from the anchor', () => {
    expect(rangeFor('agenda', '2026-09-29')).toEqual({ from: '2026-09-29', to: '2026-10-12' });
  });

  test('stepping moves by the unit of the view', () => {
    expect(step('day', '2026-09-30', 1)).toBe('2026-10-01');
    expect(step('week', '2026-09-30', -1)).toBe('2026-09-23');
    expect(step('agenda', '2026-09-29', 1)).toBe('2026-10-13');
  });

  test('stepping a month from the 31st lands in the next month, not the one after', () => {
    expect(step('month', '2026-01-31', 1)).toBe('2026-02-01');
    expect(step('month', '2026-03-31', -1)).toBe('2026-02-01');
    expect(step('month', '2026-12-15', 1)).toBe('2027-01-01');
  });

  test('a date is inside the synced window only between its ends', () => {
    const window = { from: '2026-09-14', to: '2026-11-15' };
    expect(inSyncedWindow('2026-09-14', window)).toBe(true);
    expect(inSyncedWindow('2026-11-15', window)).toBe(true);
    expect(inSyncedWindow('2026-09-13', window)).toBe(false);
    expect(inSyncedWindow('2026-11-16', window)).toBe(false);
    expect(inSyncedWindow('2026-09-29', null)).toBe(false);
  });
});

describe('agenda', () => {
  test('only days with something on them are listed', () => {
    const days = toDays(
      [timed('a', at('2026-09-29', '09:00', -240), at('2026-09-29', '10:00', -240)), allDay('h', '2026-10-01', '2026-10-02')],
      '2026-09-28',
      '2026-10-04',
    );
    expect(agendaSections(days).map((d) => d.date)).toEqual(['2026-09-29', '2026-10-01']);
  });
});

describe('next up', () => {
  const now = new Date(at('2026-09-29', '16:00', -240));
  const events = [
    timed('done', at('2026-09-29', '11:30', -240), at('2026-09-29', '12:00', -240)),
    timed('running', at('2026-09-29', '15:30', -240), at('2026-09-29', '16:30', -240)),
    allDay('vacation', '2026-09-26', '2026-10-07'),
    timed('later', at('2026-09-29', '17:00', -240), at('2026-09-29', '18:00', -240)),
    timed('tomorrow1', at('2026-09-30', '10:00', -240), at('2026-09-30', '10:30', -240)),
    timed('tomorrow2', at('2026-09-30', '13:00', -240), at('2026-09-30', '13:30', -240)),
    timed('thursday', at('2026-10-01', '09:30', -240), at('2026-10-01', '10:00', -240)),
  ];

  test('skips what has ended, keeps what is running, and stops at three', () => {
    expect(nextUp(events, now).map((n) => n.event.id)).toEqual(['running', 'later', 'tomorrow1']);
  });

  test('says which day each one is on', () => {
    expect(nextUp(events, now).map((n) => n.date)).toEqual(['2026-09-29', '2026-09-29', '2026-09-30']);
  });

  test('looks no further than the end of tomorrow', () => {
    expect(nextUp(events, now, 10).map((n) => n.event.id)).toEqual(['running', 'later', 'tomorrow1', 'tomorrow2']);
  });

  test('all-day entries are not "next"', () => {
    expect(nextUp([allDay('vacation', '2026-09-26', '2026-10-07')], now)).toEqual([]);
  });

  test('with nothing through tomorrow, the next busy day is named', () => {
    const quiet = [events[0], events[2], events[6]];
    expect(nextUp(quiet, now)).toEqual([]);
    expect(nextBusyDay(quiet, now)).toBe('2026-10-01');
    expect(nextBusyDay([events[0]], now)).toBeNull();
  });
});

describe('freshness', () => {
  const now = new Date('2026-09-29T20:12:00Z');

  test('no sync yet says so', () => {
    expect(freshness(null, 0, now)).toEqual({ label: 'not synced yet', tone: 'warn' });
  });

  test('minutes, then hours, then days', () => {
    expect(freshness('2026-09-29T20:00:00+00:00', 0, now)).toEqual({ label: 'synced 12m ago', tone: 'neutral' });
    expect(freshness('2026-09-29T20:11:40+00:00', 0, now).label).toBe('synced just now');
    expect(freshness('2026-09-29T18:12:00+00:00', 0, now).label).toBe('synced 2h ago');
    expect(freshness('2026-09-27T20:12:00+00:00', 0, now).label).toBe('synced 2d ago');
  });

  test('past three hours it warns', () => {
    expect(freshness('2026-09-29T17:13:00+00:00', 0, now).tone).toBe('neutral');
    expect(freshness('2026-09-29T16:12:00+00:00', 0, now)).toEqual({ label: 'synced 4h ago', tone: 'warn' });
  });

  test('a recent sync with failing slices is partly out of date', () => {
    expect(freshness('2026-09-29T20:00:00+00:00', 2, now)).toEqual({
      label: 'synced 12m ago · partly out of date',
      tone: 'warn',
    });
  });

  test('a timestamp that does not parse reads as never synced', () => {
    expect(freshness('whenever', 0, now)).toEqual({ label: 'not synced yet', tone: 'warn' });
  });
});

describe('whenLabel', () => {
  test('a timed event gives its day and its hours', () => {
    const label = whenLabel(timed('a', at('2026-09-29', '11:30', -240), at('2026-09-29', '12:00', -240)));
    expect(label).toContain('Sep 29');
    expect(label).toContain('11:30');
    expect(label).toContain('12:00');
  });

  test('a one-day all-day event names one day', () => {
    const label = whenLabel(allDay('h', '2026-10-01', '2026-10-02'));
    expect(label).toContain('All day');
    expect(label).toContain('Oct 1');
    expect(label).not.toContain('Oct 2');
  });

  test('a multi-day all-day event names its last day, not the exclusive end', () => {
    const label = whenLabel(allDay('v', '2026-09-26', '2026-10-07'));
    expect(label).toContain('Sep 26');
    expect(label).toContain('Oct 6');
    expect(label).not.toContain('Oct 7');
  });

  test('an event crossing midnight names both days', () => {
    const label = whenLabel(timed('n', at('2026-09-29', '23:00', -240), at('2026-09-30', '01:00', -240)));
    expect(label).toContain('Sep 29');
    expect(label).toContain('Sep 30');
  });
});

describe('what to fetch', () => {
  test('the whole synced span in one request: two weeks back from Monday, 62 days on', () => {
    expect(fetchRange(new Date(2026, 8, 29, 16, 0))).toEqual({ from: '2026-09-14', to: '2026-11-15' });
  });

  test('on a Sunday the week is the one that is ending', () => {
    expect(fetchRange(new Date(2026, 9, 4, 9, 0)).from).toBe('2026-09-14');
  });

  test('on a Monday the week is the one starting', () => {
    expect(fetchRange(new Date(2026, 9, 5, 9, 0)).from).toBe('2026-09-21');
  });
});

describe('coverage', () => {
  const window = { from: '2026-09-14', to: '2026-11-15' };

  test('a range inside the window is covered', () => {
    expect(coverage({ from: '2026-09-27', to: '2026-10-03' }, window)).toBe('in');
  });

  test('a range hanging off either end is partly covered', () => {
    expect(coverage({ from: '2026-11-01', to: '2026-11-30' }, window)).toBe('partial');
    expect(coverage({ from: '2026-09-13', to: '2026-09-19' }, window)).toBe('partial');
  });

  test('a range clear of the window is not covered', () => {
    expect(coverage({ from: '2026-12-01', to: '2026-12-31' }, window)).toBe('out');
    expect(coverage({ from: '2026-08-01', to: '2026-08-31' }, window)).toBe('out');
  });

  test('with no window nothing is covered', () => {
    expect(coverage({ from: '2026-09-27', to: '2026-10-03' }, null)).toBe('out');
  });
});

describe('rangeTitle', () => {
  test('a day is named in full', () => {
    expect(rangeTitle('day', '2026-09-29')).toContain('September 29');
  });

  test('a week and an agenda are their two ends', () => {
    expect(rangeTitle('week', '2026-09-30')).toBe('Sep 27 – Oct 3');
    expect(rangeTitle('agenda', '2026-09-29')).toBe('Sep 29 – Oct 12');
  });

  test('a month is its name and year', () => {
    expect(rangeTitle('month', '2026-09-30')).toBe('September 2026');
  });
});

describe('windowLabel', () => {
  test('names both ends of what is synced', () => {
    expect(windowLabel({ from: '2026-09-14', to: '2026-11-15' })).toBe('Sep 14 – Nov 15');
  });
});

describe('what is known about a day', () => {
  const t = (h: number) => new Date(2026, 8, 29, 16 - h, 0).toISOString();
  const weeks: CalendarWeek[] = [
    { monday: '2026-09-21', work: t(1), personal: t(1) },
    { monday: '2026-09-28', work: t(1), personal: null },
    { monday: '2026-10-05', work: null, personal: null },
  ];

  test('a week both accounts have synced is fully known', () => {
    expect(coverageFor('2026-09-27', weeks)).toBe('full');
  });

  test('a week only one account has synced is partly known', () => {
    expect(coverageFor('2026-09-29', weeks)).toBe('partial');
    expect(coverageFor('2026-10-04', weeks)).toBe('partial');
  });

  test('a week no account has synced, or no week at all, is unknown', () => {
    expect(coverageFor('2026-10-05', weeks)).toBe('none');
    expect(coverageFor('2026-12-25', weeks)).toBe('none');
    expect(coverageFor('2026-09-29', [])).toBe('none');
  });

  test('toDays carries it on each day', () => {
    const days = toDays([], '2026-09-27', '2026-10-05', weeks);
    expect(days.map((d) => d.coverage)).toEqual(['full', 'partial', 'partial', 'partial', 'partial', 'partial', 'partial', 'partial', 'none']);
  });

  test('without weeks a day is taken as known', () => {
    expect(toDays([], '2026-09-29', '2026-09-29')[0].coverage).toBe('full');
  });
});

describe('freshness of the dates on screen', () => {
  const now = new Date(2026, 8, 29, 16, 0);
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();

  test('is the OLDEST account sync among the weeks in view', () => {
    const weeks = [{ monday: '2026-09-28', work: ago(4), personal: ago(40) }];
    expect(freshnessFor({ from: '2026-09-29', to: '2026-09-29' }, weeks, now)).toEqual({
      label: 'synced 40m ago',
      tone: 'neutral',
    });
  });

  test('a near week is late after two hours, a far week after a day', () => {
    const near = [{ monday: '2026-09-28', work: ago(130), personal: ago(4) }];
    expect(freshnessFor({ from: '2026-09-29', to: '2026-09-29' }, near, now).tone).toBe('warn');
    const far = [{ monday: '2026-10-26', work: ago(23 * 60), personal: ago(23 * 60) }];
    expect(freshnessFor({ from: '2026-10-26', to: '2026-11-01' }, far, now).tone).toBe('neutral');
    const farLate = [{ monday: '2026-10-26', work: ago(25 * 60), personal: ago(25 * 60) }];
    expect(freshnessFor({ from: '2026-10-26', to: '2026-11-01' }, farLate, now).tone).toBe('warn');
  });

  test('a week in view that one account has never synced says so', () => {
    const weeks = [{ monday: '2026-09-28', work: ago(4), personal: null }];
    expect(freshnessFor({ from: '2026-09-29', to: '2026-09-29' }, weeks, now)).toEqual({
      label: 'personal calendar not synced for these dates',
      tone: 'warn',
    });
  });

  test('a range with no synced week at all is not synced', () => {
    expect(freshnessFor({ from: '2026-12-01', to: '2026-12-31' }, [], now)).toEqual({
      label: 'not synced for these dates',
      tone: 'warn',
    });
  });

  test('days already over do not count: a Sunday-first week does not report last week\'s slow sync', () => {
    const weeks = [
      { monday: '2026-09-21', work: ago(11 * 60), personal: ago(11 * 60) },
      { monday: '2026-09-28', work: ago(4), personal: ago(4) },
    ];
    expect(freshnessFor({ from: '2026-09-27', to: '2026-10-03' }, weeks, now)).toEqual({
      label: 'synced 4m ago',
      tone: 'neutral',
    });
  });

  test('a range entirely in the past still reports its own weeks', () => {
    const weeks = [{ monday: '2026-09-14', work: ago(11 * 60), personal: ago(11 * 60) }];
    expect(freshnessFor({ from: '2026-09-14', to: '2026-09-20' }, weeks, now).label).toBe('synced 11h ago');
  });

  test('a month spanning several weeks reports the oldest of them', () => {
    const weeks = [
      { monday: '2026-09-28', work: ago(4), personal: ago(4) },
      { monday: '2026-10-05', work: ago(6 * 60), personal: ago(4) },
    ];
    expect(freshnessFor({ from: '2026-10-01', to: '2026-10-31' }, weeks, now).label).toBe('synced 6h ago');
  });
});

describe('an event that runs on', () => {
  test('knows it is a continuation after its first day, and where it ends', () => {
    const days = toDays([allDay('v', '2026-09-26', '2026-10-07')], '2026-09-25', '2026-10-08');
    const first = on(days, '2026-09-26')[0];
    const middle = on(days, '2026-09-30')[0];
    expect([first.continues, first.through]).toEqual([false, '2026-10-06']);
    expect([middle.continues, middle.through]).toEqual([true, '2026-10-06']);
  });

  test('a one-day event neither continues nor runs through', () => {
    const [e] = on(toDays([allDay('h', '2026-10-01', '2026-10-02')], '2026-10-01', '2026-10-01'), '2026-10-01');
    expect([e.continues, e.through]).toEqual([false, null]);
  });

  test('the agenda lists it once, on the first day it shows, not on every day', () => {
    const days = toDays(
      [allDay('v', '2026-09-26', '2026-10-07'), timed('m', at('2026-10-01', '09:00', -240), at('2026-10-01', '10:00', -240))],
      '2026-09-29',
      '2026-10-05',
    );
    const sections = agendaSections(days);
    expect(sections.map((d) => [d.date, d.events.map((e) => e.id)])).toEqual([
      ['2026-09-29', ['v']],
      ['2026-10-01', ['m']],
    ]);
  });
});

describe('unconfirmed', () => {
  test('rides along onto the screen event', () => {
    const wire = timed('u', at('2026-09-29', '09:00', -240), at('2026-09-29', '10:00', -240), { unconfirmed: true });
    expect(on(toDays([wire], '2026-09-29', '2026-09-29'), '2026-09-29')[0].unconfirmed).toBe(true);
  });
});

describe('what is hidden by default', () => {
  const shared = 'c_test2@group.calendar.google.com';
  const base = timed('x', at('2026-09-29', '10:00', -240), at('2026-09-29', '11:00', -240));

  test('anything from a shared team or company calendar', () => {
    expect(isHidden({ ...base, organizer: shared })).toBe(true);
    expect(isHidden({ ...base, organizer: 'x@group.v.calendar.google.com' })).toBe(true);
  });

  test('a meeting marked optional, however it is written', () => {
    expect(isHidden({ ...base, title: '[OPTIONAL] Lunch & Learn' })).toBe(true);
    expect(isHidden({ ...base, title: 'PDA AI Collab [OPTIONAL]' })).toBe(true);
    expect(isHidden({ ...base, title: 'Demo (optional)' })).toBe(true);
  });

  test('a US holiday on a shared calendar stays: it is his day off too', () => {
    const holiday = allDay('h', '2026-10-12', '2026-10-13', { organizer: shared, title: "Indigenous Peoples' Day (US)" });
    expect(isHidden(holiday)).toBe(false);
    expect(isHidden({ ...holiday, title: 'Bank Holiday (IE)' })).toBe(true);
  });

  test('his own meetings and invitations stay', () => {
    expect(isHidden({ ...base, organizer: 'someone@example.com' })).toBe(false);
    expect(isHidden({ ...base, organizer: null })).toBe(false);
    expect(isHidden({ ...base, title: 'Optionality review' })).toBe(false);
  });

  test('visibleEvents drops them unless asked, and hiddenCount says how many were dropped', () => {
    const events = [base, { ...base, id: 'o', title: '[OPTIONAL] x' }, { ...base, id: 's', organizer: shared }];
    expect(visibleEvents(events, false).map((e) => e.id)).toEqual(['x']);
    expect(visibleEvents(events, true)).toHaveLength(3);
    expect(hiddenCount(events)).toBe(2);
  });
});
