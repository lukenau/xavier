// Home's door into the calendar. Native-only, so nothing in the parity
// inventory guards its words: these render it and assert what reaches the
// screen, plus the route it opens.
import TestRenderer, { act } from 'react-test-renderer';
import type { CalendarResponse, WireEvent } from '../../lib/calendarTypes';
import { CalendarCard, calendarCardSummary, timeRange } from './CalendarCard';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { router } = require('expo-router') as { router: { push: jest.Mock } };

const NOW = new Date(2026, 8, 29, 16, 0); // Tuesday

function at(date: string, hhmm: string, offsetMin = -240): string {
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  const shifted = new Date(new Date(y, m - 1, d, h, min).getTime() + offsetMin * 60_000);
  const abs = Math.abs(offsetMin);
  const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');
  return `${shifted.toISOString().slice(0, 19)}${offsetMin < 0 ? '-' : '+'}${pad(abs / 60)}:${pad(abs % 60)}`;
}

function timed(id: string, date: string, from: string, to: string): WireEvent {
  return {
    id,
    title: id,
    account: 'work',
    all_day: false,
    start: at(date, from),
    end: at(date, to),
    start_date: null,
    end_date: null,
    location: null,
    conference_url: null,
    organizer: null,
    attendee_count: null,
    unconfirmed: false,
  };
}

function response(events: WireEvent[], over: Partial<CalendarResponse> = {}): CalendarResponse {
  return {
    events,
    synced_at: new Date(NOW.getTime() - 12 * 60_000).toISOString(),
    window: { from: '2026-09-14', to: '2026-11-15' },
    stale_slices: 0,
    weeks: [],
    sync_requested_at: null,
    ...over,
  };
}

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(node);
  });
  return tree;
}

function texts(tree: TestRenderer.ReactTestRenderer): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(tree.toJSON());
  return out;
}

beforeEach(() => router.push.mockClear());

describe('timeRange', () => {
  test('shares one AM/PM when both ends are in the same half of the day', () => {
    expect(timeRange(16 * 60 + 30, 17 * 60 + 30)).toBe('4:30–5:30 PM');
  });

  test('keeps both when the event crosses noon', () => {
    expect(timeRange(11 * 60 + 30, 12 * 60 + 30)).toBe('11:30 AM–12:30 PM');
  });

  test('an event with no length is its start alone', () => {
    expect(timeRange(9 * 60, 9 * 60)).toBe('9:00 AM');
  });

  test('an event running to midnight ends at 12:00 AM', () => {
    expect(timeRange(23 * 60, 1440)).toBe('11:00 PM–12:00 AM');
  });
});

describe('what the card says', () => {
  test('the next events, soonest first, with the time each starts', () => {
    const summary = calendarCardSummary(
      response([
        timed('Retro', '2026-09-29', '17:00', '18:00'),
        timed('Done already', '2026-09-29', '09:00', '09:30'),
        timed('Sync', '2026-09-29', '16:30', '17:00'),
      ]),
      NOW,
    );
    expect(summary.rows.map((r) => r.title)).toEqual(['Sync', 'Retro']);
    expect(summary.rows.map((r) => r.when)).toEqual(['4:30–5:00 PM', '5:00–6:00 PM']);
    expect(summary.line).toBeNull();
  });

  test('an event already under way reads as now, not as a time that has passed', () => {
    const summary = calendarCardSummary(response([timed('Running', '2026-09-29', '15:30', '16:30')]), NOW);
    // Keyed by day as well as event: one running past midnight is on two days.
    expect(summary.rows).toEqual([{ id: '2026-09-29-Running', title: 'Running', when: 'Now–4:30 PM' }]);
  });

  test('tomorrow is said to be tomorrow', () => {
    const summary = calendarCardSummary(response([timed('Standup', '2026-09-30', '10:00', '10:30')]), NOW);
    expect(summary.rows[0].when).toBe('Tomorrow 10:00–10:30 AM');
  });

  test('other people\'s entries and optional meetings do not count as next', () => {
    const summary = calendarCardSummary(
      response([
        { ...timed('Colleague OOO', '2026-09-29', '16:30', '18:00'), organizer: 'c_test1@group.calendar.google.com' },
        timed('[OPTIONAL] Lunch & Learn', '2026-09-29', '17:00', '18:00'),
        timed('Retro', '2026-09-29', '17:30', '18:00'),
      ]),
      NOW,
    );
    expect(summary.rows.map((r) => r.title)).toEqual(['Retro']);
  });

  test('never more than three', () => {
    const summary = calendarCardSummary(
      response(
        [
          ['17:00', '17:30'],
          ['17:30', '18:00'],
          ['18:00', '18:30'],
          ['18:30', '19:00'],
        ].map(([from, to], i) => timed(`e${i}`, '2026-09-29', from, to)),
      ),
      NOW,
    );
    expect(summary.rows).toHaveLength(3);
  });

  test('nothing through tomorrow names the next day that has something', () => {
    const summary = calendarCardSummary(response([timed('Thursday thing', '2026-10-01', '09:30', '10:00')]), NOW);
    expect(summary.rows).toEqual([]);
    expect(summary.line).toBe('No timed events before Thu, Oct 1');
  });

  test('an all-day entry today is said, so a quiet card never claims a free day', () => {
    const summary = calendarCardSummary(
      response([
        { ...timed('Offsite', '2026-09-29', '00:00', '00:00'), all_day: true, start: null, end: null, start_date: '2026-09-29', end_date: '2026-09-30' },
        timed('Thursday thing', '2026-10-01', '09:30', '10:00'),
      ]),
      NOW,
    );
    expect(summary.rows).toEqual([]);
    expect(summary.allDay).toBe('All day · Offsite');
    expect(summary.line).toBe('No timed events before Thu, Oct 1');
  });

  test('nothing at all in the synced span says so', () => {
    expect(calendarCardSummary(response([]), NOW)).toMatchObject({ rows: [], line: 'Nothing scheduled' });
  });

  test('before any data it describes itself instead of claiming a free day', () => {
    expect(calendarCardSummary(undefined, NOW)).toEqual({
      rows: [],
      allDay: null,
      line: 'work and personal, in one place',
      warning: null,
    });
  });

  test('an unsynced calendar warns and shows no events', () => {
    const summary = calendarCardSummary(response([], { synced_at: null, window: null }), NOW);
    expect(summary).toEqual({ rows: [], allDay: null, line: null, warning: 'not synced yet' });
  });

  test('fresh data carries no warning', () => {
    expect(calendarCardSummary(response([]), NOW).warning).toBeNull();
  });

  test('stale data warns, and still shows what it has', () => {
    const summary = calendarCardSummary(
      response([timed('Retro', '2026-09-29', '17:00', '18:00')], {
        synced_at: new Date(NOW.getTime() - 5 * 3600_000).toISOString(),
      }),
      NOW,
    );
    expect(summary.warning).toBe('synced 5h ago');
    expect(summary.rows.map((r) => r.title)).toEqual(['Retro']);
  });
});

describe('the card', () => {
  test('renders the rows it was given', () => {
    const tree = render(
      <CalendarCard data={response([timed('Retro', '2026-09-29', '17:00', '18:00')])} now={NOW} />,
    );
    const all = texts(tree);
    expect(all).toContain('Calendar');
    expect(all).toContain('Retro');
    expect(all.some((s) => s.includes('5:00'))).toBe(true);
  });

  test('renders with no data at all, so the route is always reachable', () => {
    const tree = render(<CalendarCard data={undefined} now={NOW} />);
    expect(texts(tree)).toContain('work and personal, in one place');
  });

  test('shows the warning in place of nothing', () => {
    const tree = render(<CalendarCard data={response([], { synced_at: null, window: null })} now={NOW} />);
    expect(texts(tree)).toContain('not synced yet');
  });

  test('opens the calendar', () => {
    const tree = render(<CalendarCard data={undefined} now={NOW} />);
    const card = tree.root.findAll((n) => typeof n.props.onPress === 'function')[0];
    act(() => card.props.onPress());
    expect(router.push).toHaveBeenCalledWith('/calendar');
  });
});
