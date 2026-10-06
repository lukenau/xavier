// The calendar screen rendered against a fixed afternoon (Tue 2026-09-29,
// 16:00 local) and a response shaped like the real endpoint's.
jest.mock('expo-router', () => ({
  useIsFocused: () => true,
  useScrollToTop: () => {},
  useFocusEffect: (callback: () => undefined | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useEffect } = require('react');
    useEffect(callback, [callback]);
  },
  router: { push: jest.fn(), back: jest.fn() },
}));
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('expo-glass-effect', () => ({
  GlassView: ({ children }: { children: React.ReactNode }) => children,
  isLiquidGlassAvailable: () => false,
}));

import TestRenderer, { act } from 'react-test-renderer';
import { Linking, Text } from 'react-native';
import { router } from 'expo-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { CalendarResponse, CalendarWeek, WireEvent } from '../../lib/calendarTypes';
import { Screen, SkeletonRows, StatePanel } from '../shell';
import { DetailSheet } from '../system/DetailSheet';
import CalendarScreen, { forgetCalendarState } from './CalendarScreen';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};
const NOW = new Date(2026, 8, 29, 16, 0);

function at(date: string, hhmm: string, offsetMin = -240): string {
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  const shifted = new Date(new Date(y, m - 1, d, h, min).getTime() + offsetMin * 60_000);
  const abs = Math.abs(offsetMin);
  const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');
  return `${shifted.toISOString().slice(0, 19)}${offsetMin < 0 ? '-' : '+'}${pad(abs / 60)}:${pad(abs % 60)}`;
}

function timed(id: string, date: string, from: string, to: string, over: Partial<WireEvent> = {}): WireEvent {
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
    ...over,
  };
}

const SYNCED = new Date(NOW.getTime() - 12 * 60_000).toISOString();
const MONDAYS = ['2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09'];
const WEEKS: CalendarWeek[] = MONDAYS.map((monday) => ({ monday, work: SYNCED, personal: SYNCED }));

const EVENTS: WireEvent[] = [
  {
    ...timed('Vacation', '2026-09-26', '00:00', '00:00'),
    all_day: true,
    start: null,
    end: null,
    start_date: '2026-09-26',
    end_date: '2026-10-07',
  },
  timed('Standup', '2026-09-29', '10:00', '10:30'),
  timed('One to one', '2026-09-29', '11:30', '12:00', {
    location: 'Huddle 5',
    organizer: 'boss@example.com',
    attendee_count: 2,
  }),
  timed('All hands', '2026-09-30', '14:00', '15:00', { conference_url: 'https://meet.example.com/abc' }),
  timed('Lunch talk', '2026-09-30', '12:00', '13:00', { location: 'https://stream.example.com/xyz, Room 17' }),
  timed('Maybe cancelled', '2026-10-02', '10:00', '11:00', { unconfirmed: true }),
  timed('Colleague OOO', '2026-09-29', '14:00', '16:00', { organizer: 'c_test1@group.calendar.google.com' }),
  timed('[OPTIONAL] Brown bag', '2026-09-29', '12:00', '13:00'),
  timed('Dentist', '2026-10-01', '13:00', '14:00', { account: 'personal', location: '1 Main St' }),
  timed('Far off', '2026-10-20', '09:00', '10:00'),
];

function response(over: Partial<CalendarResponse> = {}): CalendarResponse {
  return {
    events: EVENTS,
    synced_at: SYNCED,
    window: { from: '2026-09-14', to: '2026-11-15' },
    stale_slices: 0,
    weeks: WEEKS,
    sync_requested_at: null,
    ...over,
  };
}

function serve(body: CalendarResponse | null, status = 200) {
  (global.fetch as jest.Mock).mockImplementation(() =>
    Promise.resolve({ ok: status < 300, status, json: async () => body ?? { detail: 'boom' } } as Response),
  );
}

let clients: QueryClient[] = [];
let mounted: TestRenderer.ReactTestRenderer[] = [];

beforeEach(() => {
  global.fetch = jest.fn();
  (router.back as jest.Mock).mockClear();
  forgetCalendarState();
});

afterEach(() => {
  act(() => mounted.forEach((tree) => tree.unmount()));
  clients.forEach((client) => client.clear());
  mounted = [];
  clients = [];
  jest.restoreAllMocks();
});

function screen(now: Date) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <CalendarScreen now={now} />
    </SafeAreaProvider>
  );
}

async function settle(tree: TestRenderer.ReactTestRenderer, until: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!until() && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function render(now: Date = NOW) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(<QueryClientProvider client={client}>{screen(now)}</QueryClientProvider>);
  });
  mounted.push(tree);
  const rerender = (next: Date) =>
    act(() => tree.update(<QueryClientProvider client={client}>{screen(next)}</QueryClientProvider>));
  (tree as TestRenderer.ReactTestRenderer & { rerender: typeof rerender }).rerender = rerender;
  const deadline = Date.now() + 3000;
  while (tree.root.findAllByType(SkeletonRows).length > 0 && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  return tree;
}

type Tree = TestRenderer.ReactTestRenderer;

function texts(tree: Tree): string[] {
  return tree.root
    .findAllByType(Text)
    .flatMap((n) => [n.props.children].flat(Infinity))
    .filter((c) => typeof c === 'string' || typeof c === 'number')
    .map(String);
}

function has(tree: Tree, fragment: string): boolean {
  return texts(tree).some((s) => s.includes(fragment));
}

function byId(tree: Tree, testID: string) {
  return tree.root.findAll((n) => n.props.testID === testID && typeof n.type !== 'string');
}

/** A Pressable is two composite nodes deep in the test tree, both carrying its
 * props, so anything collected off one is collected twice. */
function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function press(tree: Tree, match: { label?: string; testID?: string }, index = 0) {
  const found = tree.root.findAll(
    (n) =>
      typeof n.props.onPress === 'function' &&
      (match.label ? n.props.accessibilityLabel === match.label : n.props.testID === match.testID),
  );
  expect(found.length).toBeGreaterThan(index);
  act(() => found[index].props.onPress());
}

function sheet(tree: Tree) {
  return tree.root.findByType(DetailSheet);
}

test('opens on the agenda with today first', async () => {
  serve(response());
  const tree = await render();
  expect(byId(tree, 'cal-agenda')).toHaveLength(1);
  const all = texts(tree);
  // 'Today ·' is the section heading; bare 'Today' is the stepper's button.
  const today = all.findIndex((s) => s.startsWith('Today ·'));
  expect(today).toBeGreaterThanOrEqual(0);
  expect(all.indexOf('Standup')).toBeGreaterThan(today);
  expect(all.indexOf('Standup')).toBeLessThan(all.indexOf('All hands'));
  expect(has(tree, 'Tomorrow ·')).toBe(true);
});

test('the agenda does not list what is beyond its two weeks', async () => {
  serve(response());
  const tree = await render();
  expect(has(tree, 'Dentist')).toBe(true);
  expect(has(tree, 'Far off')).toBe(false);
});

test.each([
  ['Agenda view', 'cal-agenda'],
  ['Day view', 'cal-dayview'],
  ['Week view', 'cal-weekview'],
  ['Month view', 'cal-monthview'],
])('%s shows its own view and only that one', async (label, testID) => {
  serve(response());
  const tree = await render();
  press(tree, { label });
  for (const id of ['cal-agenda', 'cal-dayview', 'cal-weekview', 'cal-monthview']) {
    expect(byId(tree, id)).toHaveLength(id === testID ? 1 : 0);
  }
});

test('the selected view is announced as selected', async () => {
  serve(response());
  const tree = await render();
  press(tree, { label: 'Week view' });
  const selected = tree.root
    .findAll((n) => n.props.accessibilityState?.selected === true && typeof n.type !== 'string')
    .map((n) => n.props.accessibilityLabel);
  expect(unique(selected)).toEqual(['Week view']);
});

test('the day view shows timed events and the all-day one', async () => {
  serve(response());
  const tree = await render();
  press(tree, { label: 'Day view' });
  expect(has(tree, 'Standup')).toBe(true);
  expect(has(tree, 'One to one')).toBe(true);
  expect(has(tree, 'Vacation')).toBe(true);
  expect(has(tree, 'All hands')).toBe(false);
});

test('an empty day says so', async () => {
  serve(response());
  const tree = await render();
  press(tree, { label: 'Day view' });
  for (let i = 0; i < 8; i += 1) press(tree, { label: 'Next' });
  expect(has(tree, 'Nothing scheduled')).toBe(true);
});

test('the week is a timeline per day, days already over folded into one line', async () => {
  serve(response());
  const tree = await render();
  press(tree, { label: 'Week view' });
  const heads = () =>
    unique(
      tree.root
        .findAll((n) => /^cal-week-head-/.test(n.props.testID ?? '') && typeof n.type !== 'string')
        .map((n) => n.props.testID),
    );
  expect(heads()).toEqual([
    'cal-week-head-2026-09-29',
    'cal-week-head-2026-09-30',
    'cal-week-head-2026-10-01',
    'cal-week-head-2026-10-02',
    'cal-week-head-2026-10-03',
  ]);
  expect(has(tree, 'Sun 27 – Mon 28')).toBe(true);
  press(tree, { label: 'Show Sun 27 – Mon 28' });
  expect(heads()[0]).toBe('cal-week-head-2026-09-27');
  expect(heads()).toHaveLength(7);
});

test('each day shows its free time between meetings', async () => {
  serve(response());
  const tree = await render();
  press(tree, { label: 'Week view' });
  // Wed Sep 30: Lunch talk 12–1, All hands 2–3.
  expect(has(tree, '1h free')).toBe(true);
  expect(has(tree, 'Dentist')).toBe(true);
});

test('a day with nothing on it says it is free', async () => {
  serve(response());
  const tree = await render();
  press(tree, { label: 'Week view' });
  expect(has(tree, 'free all day')).toBe(true);
});

test('tapping a day in the week opens that day', async () => {
  serve(response());
  const tree = await render();
  press(tree, { label: 'Week view' });
  press(tree, { testID: 'cal-week-head-2026-10-01' });
  expect(byId(tree, 'cal-dayview')).toHaveLength(1);
  expect(has(tree, 'Dentist')).toBe(true);
  expect(has(tree, 'Standup')).toBe(false);
});

test('tapping a day in the month lists that day under the grid', async () => {
  serve(response());
  const tree = await render();
  press(tree, { label: 'Month view' });
  // Today is selected to begin with.
  expect(has(tree, 'Standup')).toBe(true);
  press(tree, { testID: 'cal-month-2026-09-30' });
  expect(byId(tree, 'cal-monthview')).toHaveLength(1);
  expect(has(tree, 'All hands')).toBe(true);
  expect(has(tree, 'Standup')).toBe(false);
});

test('tapping an event opens its details', async () => {
  serve(response());
  const tree = await render();
  expect(sheet(tree).props.visible).toBe(false);
  press(tree, { testID: 'cal-event-One to one' });
  expect(sheet(tree).props.visible).toBe(true);
  expect(sheet(tree).props.title).toBe('One to one');
  expect(sheet(tree).props.eyebrow).toBe('Work');
  expect(has(tree, 'Huddle 5')).toBe(true);
  expect(has(tree, 'boss@example.com')).toBe(true);
  expect(has(tree, '2 people')).toBe(true);
  expect(texts(tree).some((s) => s.includes('Sep 29') && s.includes('11:30'))).toBe(true);
});

test('closing the sheet closes it', async () => {
  serve(response());
  const tree = await render();
  press(tree, { testID: 'cal-event-One to one' });
  act(() => sheet(tree).props.onClose());
  expect(sheet(tree).props.visible).toBe(false);
});

test('an event with a meeting link offers Join, and Join opens it', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  serve(response());
  const tree = await render();
  press(tree, { testID: 'cal-event-All hands' });
  press(tree, { label: 'Join' });
  expect(open).toHaveBeenCalledWith('https://meet.example.com/abc');
});

test('an event without a link offers no Join', async () => {
  serve(response());
  const tree = await render();
  press(tree, { testID: 'cal-event-One to one' });
  expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Join')).toHaveLength(0);
});

test.each(['javascript:alert(1)', 'tel:+15550100', 'http://meet.example.com/abc', 'not a url'])(
  'a link that is not https (%s) is never offered',
  async (url) => {
    serve(response({ events: [timed('Odd', '2026-09-29', '17:00', '18:00', { conference_url: url })] }));
    const tree = await render();
    press(tree, { testID: 'cal-event-Odd' });
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Join')).toHaveLength(0);
  },
);

test('a range clear of the synced window says so instead of looking empty', async () => {
  serve(response());
  const tree = await render();
  press(tree, { label: 'Month view' });
  for (let i = 0; i < 3; i += 1) press(tree, { label: 'Next' });
  expect(has(tree, 'December 2026')).toBe(true);
  expect(has(tree, 'Outside the synced range')).toBe(true);
  expect(byId(tree, 'cal-monthview')).toHaveLength(0);
});

test('a month running past the synced weeks is drawn, and its unsynced days are marked, not blank', async () => {
  serve(response());
  const tree = await render();
  press(tree, { label: 'Month view' });
  for (let i = 0; i < 2; i += 1) press(tree, { label: 'Next' });
  expect(has(tree, 'November 2026')).toBe(true);
  expect(byId(tree, 'cal-monthview')).toHaveLength(1);
  const known = tree.root.findAll((n) => n.props.testID === 'cal-month-2026-11-10' && typeof n.type !== 'string')[0];
  const unknown = tree.root.findAll((n) => n.props.testID === 'cal-month-2026-11-20' && typeof n.type !== 'string')[0];
  expect(known.props.accessibilityLabel).not.toContain('not synced');
  expect(unknown.props.accessibilityLabel).toContain('not synced');
  expect(unknown.props.accessibilityState?.disabled).toBe(true);
  expect(has(tree, 'not synced for these dates')).toBe(false);
});

test('a week with an unsynced day says so in that column', async () => {
  serve(response({ weeks: WEEKS.filter((w) => w.monday !== '2026-11-09') }));
  const tree = await render();
  press(tree, { label: 'Week view' });
  press(tree, { label: 'Today' });
  for (let i = 0; i < 6; i += 1) press(tree, { label: 'Next' });
  // Sun Nov 8 (synced week of Nov 2) then Mon Nov 9 onward (never synced).
  expect(has(tree, 'Nov 8 – Nov 14')).toBe(true);
  expect(byId(tree, 'cal-weekview')).toHaveLength(1);
  expect(byId(tree, 'cal-week-unsynced-2026-11-09')).toHaveLength(1);
  expect(byId(tree, 'cal-week-unsynced-2026-11-08')).toHaveLength(0);
});

test('a day no account has synced is not drawn as a free day', async () => {
  serve(response({ weeks: WEEKS.filter((w) => w.monday !== '2026-10-05') }));
  const tree = await render();
  press(tree, { label: 'Day view' });
  for (let i = 0; i < 7; i += 1) press(tree, { label: 'Next' });
  expect(has(tree, 'October 6')).toBe(true);
  expect(has(tree, 'Nothing scheduled')).toBe(false);
  expect(tree.root.findAllByType(StatePanel).map((p) => p.props.title)).toEqual(['Nothing is known about this day']);
});

test('the agenda flags days it cannot vouch for instead of skipping them', async () => {
  serve(response({ weeks: WEEKS.filter((w) => w.monday !== '2026-10-05') }));
  const tree = await render();
  expect(has(tree, 'Oct 5 – Oct 11 · not synced')).toBe(true);
});

test('the header says how fresh the dates on screen are, not the newest slice', async () => {
  serve(response({ weeks: WEEKS.map((w) => (w.monday === '2026-10-05' ? { ...w, personal: null } : w)) }));
  const tree = await render();
  press(tree, { label: 'Week view' });
  expect(has(tree, 'synced 12m ago')).toBe(true);
  press(tree, { label: 'Next' });
  expect(has(tree, 'personal calendar not synced for these dates')).toBe(true);
});

test('an event that began earlier is listed once in the agenda, with its end', async () => {
  serve(response());
  const tree = await render();
  const vacationRows = tree.root.findAll(
    (n) => n.props.testID === 'cal-event-Vacation' && typeof n.type !== 'string' && typeof n.props.onPress === 'function',
  );
  expect(unique(vacationRows.map((n) => n.props.accessibilityLabel))).toHaveLength(1);
  expect(has(tree, 'through Oct 6')).toBe(true);
});

test('when a refetch fails, what was loaded stays on screen behind a notice', async () => {
  serve(response());
  const tree = await render();
  expect(has(tree, 'Standup')).toBe(true);
  serve(null, 500);
  act(() => tree.root.findByType(Screen).props.onRefresh());
  await settle(tree, () => has(tree, 'showing the last snapshot'));
  expect(has(tree, 'showing the last snapshot')).toBe(true);
  expect(has(tree, 'Standup')).toBe(true);
  expect(tree.root.findAllByType(StatePanel)).toHaveLength(0);
});

test('a new day moves today with it', async () => {
  serve(response());
  const tree = await render();
  const todayHeading = () => texts(tree).find((s) => s.startsWith('Today ·')) ?? '';
  expect(todayHeading()).toContain('Sep 29');
  (tree as TestRenderer.ReactTestRenderer & { rerender: (d: Date) => void }).rerender(new Date(2026, 8, 30, 8, 0));
  expect(todayHeading()).toContain('Sep 30');
});

test('a day he stepped to on purpose stays put when the day turns', async () => {
  serve(response());
  const tree = await render();
  press(tree, { label: 'Day view' });
  press(tree, { label: 'Next' });
  press(tree, { label: 'Next' });
  expect(has(tree, 'October 1')).toBe(true);
  (tree as TestRenderer.ReactTestRenderer & { rerender: (d: Date) => void }).rerender(new Date(2026, 8, 30, 8, 0));
  expect(has(tree, 'October 1')).toBe(true);
});

test('the view and date he left on are where he comes back to', async () => {
  serve(response());
  const first = await render();
  press(first, { label: 'Week view' });
  press(first, { label: 'Next' });
  act(() => first.unmount());
  mounted.pop();
  const second = await render();
  expect(byId(second, 'cal-weekview')).toHaveLength(1);
  expect(has(second, 'Oct 4 – Oct 10')).toBe(true);
});

test('the day view keeps its empty hours, so free time is visible time', async () => {
  serve(response());
  const tree = await render();
  press(tree, { label: 'Day view' });
  expect(has(tree, 'free')).toBe(false);
  for (const hour of ['8 AM', '12 PM', '5 PM']) expect(has(tree, hour)).toBe(true);
  expect(byId(tree, 'cal-now')).toHaveLength(1);
});

test('the week marks now in today\'s timeline and not elsewhere', async () => {
  serve(response());
  const tree = await render();
  press(tree, { label: 'Week view' });
  expect(byId(tree, 'cal-now')).toHaveLength(1);
  press(tree, { label: 'Next' });
  expect(byId(tree, 'cal-now')).toHaveLength(0);
});

test('a week block is announced with its day, time and calendar', async () => {
  serve(response());
  const tree = await render();
  press(tree, { label: 'Week view' });
  const block = tree.root.findAll((n) => n.props.testID === 'cal-event-Dentist' && typeof n.props.onPress === 'function')[0];
  for (const part of ['Dentist', 'Oct 1', '1:00', 'personal']) expect(block.props.accessibilityLabel).toContain(part);
});

test('the month\'s bars count meetings, not the all-day entries lying over every day', async () => {
  serve(response());
  const tree = await render();
  press(tree, { label: 'Month view' });
  expect(byId(tree, 'cal-bar-Vacation')).toHaveLength(0);
  expect(byId(tree, 'cal-bar-Standup')).toHaveLength(1);
});

test('the legend names the two calendars', async () => {
  serve(response());
  const tree = await render();
  expect(has(tree, 'work')).toBe(true);
  expect(has(tree, 'personal')).toBe(true);
});

test('an event the last sync did not return is marked as such, on the row and in its details', async () => {
  serve(response());
  const tree = await render();
  const row = tree.root.findAll((n) => n.props.testID === 'cal-event-Maybe cancelled' && typeof n.props.onPress === 'function')[0];
  expect(row.props.accessibilityLabel).toContain('unconfirmed');
  press(tree, { testID: 'cal-event-Maybe cancelled' });
  expect(has(tree, 'Not returned by the latest sync')).toBe(true);
});

test('a meeting link that arrived inside the location is still a Join', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  serve(response());
  const tree = await render();
  press(tree, { testID: 'cal-event-Lunch talk' });
  press(tree, { label: 'Join' });
  expect(open).toHaveBeenCalledWith('https://stream.example.com/xyz');
});

test('Join says where it goes', async () => {
  serve(response());
  const tree = await render();
  press(tree, { testID: 'cal-event-All hands' });
  expect(has(tree, 'meet.example.com')).toBe(true);
});

test('Today comes back from wherever the stepper went', async () => {
  serve(response());
  const tree = await render();
  press(tree, { label: 'Day view' });
  for (let i = 0; i < 5; i += 1) press(tree, { label: 'Previous' });
  expect(has(tree, 'September 24')).toBe(true);
  press(tree, { label: 'Today' });
  expect(has(tree, 'September 29')).toBe(true);
  expect(has(tree, 'Standup')).toBe(true);
});

test('says how fresh the data is', async () => {
  serve(response());
  const tree = await render();
  expect(has(tree, 'synced 12m ago')).toBe(true);
});

test('says when the weeks on screen are late', async () => {
  const late = new Date(NOW.getTime() - 3 * 3600_000).toISOString();
  serve(response({ weeks: WEEKS.map((w) => (w.monday === '2026-09-28' ? { ...w, work: late } : w)) }));
  const tree = await render();
  expect(has(tree, 'synced 3h ago')).toBe(true);
  const alert = tree.root.findAll((n) => n.props.accessibilityRole === 'alert' && typeof n.type !== 'string');
  expect(alert.length).toBeGreaterThan(0);
});

test('before the first sync it says so and draws no calendar', async () => {
  serve(response({ events: [], synced_at: null, window: null }));
  const tree = await render();
  expect(tree.root.findAllByType(StatePanel).map((p) => p.props.title)).toEqual(['Not synced yet']);
  expect(byId(tree, 'cal-agenda')).toHaveLength(0);
});

test('a failed request is an error, not an empty calendar', async () => {
  serve(null, 500);
  const tree = await render();
  const panels = tree.root.findAllByType(StatePanel);
  expect(panels.map((p) => [p.props.tone, p.props.title])).toEqual([['error', 'Calendar unavailable']]);
  expect(has(tree, 'Nothing scheduled')).toBe(false);
});

test('asks once for the whole synced span and never again on a view or date change', async () => {
  serve(response());
  const tree = await render();
  press(tree, { label: 'Week view' });
  press(tree, { label: 'Next' });
  press(tree, { label: 'Month view' });
  const calls = (global.fetch as jest.Mock).mock.calls.map(([url]) => String(url));
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain('/calendar?from=2026-09-14&to=2026-11-15');
});

test('the back link goes back', async () => {
  serve(response());
  const tree = await render();
  press(tree, { label: 'Home' });
  expect(router.back).toHaveBeenCalled();
});


test('other people\'s entries and optional meetings are hidden until asked for', async () => {
  serve(response());
  const tree = await render();
  press(tree, { label: 'Day view' });
  expect(has(tree, 'Colleague OOO')).toBe(false);
  expect(has(tree, 'Brown bag')).toBe(false);
  expect(has(tree, '2 hidden')).toBe(true);
  press(tree, { label: 'Show hidden' });
  expect(has(tree, 'Colleague OOO')).toBe(true);
  expect(has(tree, 'Brown bag')).toBe(true);
  press(tree, { label: 'Hide them' });
  expect(has(tree, 'Colleague OOO')).toBe(false);
});

test('a day with nothing hidden does not mention hiding', async () => {
  serve(response());
  const tree = await render();
  press(tree, { label: 'Day view' });
  press(tree, { label: 'Next' });
  expect(has(tree, 'hidden')).toBe(false);
});

test('Sync now asks the host and says it is under way', async () => {
  (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: init?.method === 'POST' ? 202 : 200,
      json: async () =>
        init?.method === 'POST'
          ? { requested_at: NOW.toISOString(), already: false }
          : response({ sync_requested_at: (global.fetch as jest.Mock).mock.calls.some(([, i]) => i?.method === 'POST') ? NOW.toISOString() : null }),
    } as Response),
  );
  const tree = await render();
  expect(has(tree, 'syncing')).toBe(false);
  press(tree, { label: 'Sync now' });
  await settle(tree, () => has(tree, 'syncing'));
  const posts = (global.fetch as jest.Mock).mock.calls.filter(([, i]) => i?.method === 'POST').map(([u]) => String(u));
  expect(posts).toEqual([expect.stringContaining('/calendar/sync')]);
  expect(has(tree, 'syncing this week and next')).toBe(true);
});

test('a sync already asked for shows as under way on open', async () => {
  serve(response({ sync_requested_at: NOW.toISOString() }));
  const tree = await render();
  expect(has(tree, 'syncing this week and next')).toBe(true);
});
