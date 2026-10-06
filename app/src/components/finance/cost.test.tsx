// Cost page behaviour, asserted against the real components (the route
// included) rather than helpers in isolation. Every test here guards something
// the 2026-09-11 PWA rework (4ea5691 → 9134121) deliberately changed and that
// docs/inventory/money.md §2 still describes the old way — so a port written
// from the doc fails these, which is the point.
jest.mock('expo-router', () => ({
  // Screen arms the tab-re-press scroll with it; behaviour is asserted in Screen.test.tsx.
  useScrollToTop: () => {},
  useFocusEffect: () => {},
  useIsFocused: () => true,
  router: { push: jest.fn() },
}));

// StackedBars mounts a Skia canvas (TurboModuleRegistry.getEnforcing at import
// time, absent under jest). Task 15 owns its behaviour and tests it through
// charts/geometry; this file only needs the page around it, so the chart is a
// plain View here. Its props are still asserted — those are the page's.
jest.mock('../charts/StackedBars', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    StackedBars: (props: Record<string, unknown>) => React.createElement(View, { testID: 'stacked-bars', ...props }),
    LegendChips: () => null,
  };
});

// The four reads the page owns, served from fixtures. Mocking the api module
// rather than pre-seeding the query cache keeps the real usePoll/QUERY_TUNING
// wiring in the test: a wrong endpoint or a wrong window argument shows up as
// a missing fixture, not as a silently reused cache entry.
const mockApiState: {
  summary: unknown;
  timeseries: unknown;
  credits: unknown;
  cronCosts: unknown;
  cronCostsError: Error | null;
  summaryWindows: string[];
  recurring: unknown;
  recurringError: Error | null;
  recurringWindows: string[];
} = { summary: null, timeseries: null, credits: null, cronCosts: null, cronCostsError: null, summaryWindows: [],
      recurring: null, recurringError: null, recurringWindows: [] };

jest.mock('../../lib/api', () => ({
  api: {
    spendSummary: jest.fn(async (w: string) => {
      mockApiState.summaryWindows.push(w);
      return mockApiState.summary;
    }),
    spendTimeseries: jest.fn(async () => mockApiState.timeseries),
    openrouterCredits: jest.fn(async () => mockApiState.credits),
    cronCosts: jest.fn(async () => {
      if (mockApiState.cronCostsError) throw mockApiState.cronCostsError;
      return mockApiState.cronCosts;
    }),
    recurringCosts: jest.fn(async (w: string) => {
      mockApiState.recurringWindows.push(w);
      if (mockApiState.recurringError) throw mockApiState.recurringError;
      return mockApiState.recurring;
    }),
  },
}));

import TestRenderer, { act } from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BucketDetail, CronJobCostRow, DeltaChip, PerKeyCard } from './costParts';
import { fmtBucket, perKeyRows, recurringFootnote, recurringRows, unpricedEntries } from './costModel';
import { dark, light } from '../../theme/tokens.gen';
import { useTheme, type Scheme } from '../../theme/useTheme';
import { api } from '../../lib/api';
import type {
  CronCostsJob,
  CronCostsReport,
  OpenRouterCredits,
  OpenRouterKeyRow,
  SpendPoint,
  RecurringCosts,
  SpendSummary,
  SpendTimeseries,
} from '../../lib/types';
// eslint-disable-next-line import/no-relative-parent-imports
import CostScreen from '../../../app/ops/cost';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

/** Nested <Text> runs (the per-key row's grey "· $x total" tail) are elements,
 * not strings — walk into them so a line reads as the user sees it. */
const flatten = (children: unknown): string => {
  if (children == null || typeof children === 'boolean') return '';
  if (Array.isArray(children)) return children.map(flatten).join('');
  if (typeof children === 'object' && 'props' in children) {
    return flatten((children as { props: { children?: unknown } }).props.children);
  }
  return String(children);
};

const mounted: TestRenderer.ReactTestRenderer[] = [];
const clients: QueryClient[] = [];

afterEach(() => {
  // Unmount before the environment tears down: a live observer whose query
  // settles after the test ends re-renders into a dead module registry.
  mounted.splice(0).forEach((r) => act(() => r.unmount()));
  clients.splice(0).forEach((c) => c.clear());
  mockApiState.summary = null;
  mockApiState.timeseries = null;
  mockApiState.credits = null;
  mockApiState.cronCosts = null;
  mockApiState.cronCostsError = null;
  mockApiState.summaryWindows = [];
});

function inspect(renderer: TestRenderer.ReactTestRenderer) {
  const texts = renderer.root.findAllByType(Text);
  // A nested <Text> shows up as its own node AND inside its parent's flattened
  // string; both spellings are useful, so keep the full list.
  const lines = texts.map((n) => flatten(n.props.children));
  return {
    renderer,
    lines,
    has: (line: string) => lines.includes(line),
    indexOf: (line: string) => lines.findIndex((l) => l.includes(line)),
    colorOf(line: string) {
      const node = texts.find((n) => flatten(n.props.children) === line);
      if (!node) throw new Error(`no line ${JSON.stringify(line)} in ${JSON.stringify(lines)}`);
      return StyleSheet.flatten(node.props.style).color as string;
    },
  };
}

function view(node: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(node);
  });
  mounted.push(renderer);
  return inspect(renderer);
}

/** The scheme useTheme() resolves to here, so colour assertions do not
 * hard-code one half of the token table. */
let tokenTable: Record<string, string> | null = null;
function tokens(): Record<string, string> {
  if (!tokenTable) {
    const captured: Scheme[] = [];
    function Probe() {
      captured.push(useTheme().scheme);
      return null;
    }
    // Create and unmount in SEPARATE act() calls: React 19 flushes the render
    // at the end of the act, so an unmount queued inside the same one means
    // Probe never renders and the default below silently wins.
    let probe!: TestRenderer.ReactTestRenderer;
    act(() => {
      probe = TestRenderer.create(<Probe />);
    });
    act(() => probe.unmount());
    tokenTable = captured[0] === 'light' ? light : dark;
  }
  return tokenTable;
}

// --- fixtures ---------------------------------------------------------------

const point = (over: Partial<SpendPoint> = {}): SpendPoint => ({
  date: '2026-09-10',
  spend_usd: 1,
  per_model: { 'claude-opus-4-5': 0.8, 'mimo-v2-5': 0.2 },
  per_provider: { anthropic: 0.8, openrouter: 0.2 },
  tokens: { input: 1_200_000, output: 45_000, cache_read: 900_000 },
  sessions: 3,
  ...over,
});

const summary = (over: Partial<SpendSummary> = {}): SpendSummary => ({
  total_usd: 1.5,
  window: 'today',
  range: { start: '2026-09-11T00:00:00', end: '2026-09-11T12:00:00' },
  prev_range: { start: '2026-09-10T00:00:00', end: '2026-09-10T23:59:59' },
  delta_pct: 25,
  prev_total_usd: 1.2,
  models: [
    {
      model: 'claude-opus-4-5',
      provider: 'anthropic',
      total_spend: 1,
      input: 1_000_000,
      output: 40_000,
      cache_read: 900_000,
      cache_write: 10_000,
      sessions: 2,
      share_pct: 66,
    },
  ],
  by_provider: { anthropic: 1, openrouter: 0.5 },
  tokens: { input: 1_200_000, output: 45_000, cache_read: 900_000, cache_write: 10_000 },
  sessions: 3,
  cache: { read_tokens: 900_000, saved_usd: 2.4, saved_pct: 62, would_have_cost_usd: 3.9 },
  unpriced: [],
  updated_at: '2026-09-11T12:00:00',
  ...over,
});

const timeseries = (over: Partial<SpendTimeseries> = {}): SpendTimeseries => ({
  window: 'today',
  granularity: 'day',
  points: [point({ date: '2026-09-09', spend_usd: 0.5 }), point()],
  ...over,
});

const key = (name: string, windows: OpenRouterKeyRow['windows'], usage: number): OpenRouterKeyRow => ({
  name,
  label: null,
  usage,
  windows,
  delta_since_last: null,
  ts: '2026-09-11T12:00:00',
});

const credits = (over: Partial<OpenRouterCredits> = {}): OpenRouterCredits => ({
  total_credits: 120,
  total_usage: 88.4,
  balance: 31.6,
  usage_daily: 1.2,
  usage_monthly: 18.5,
  keys: [
    key('hermes', { today: { usd: 1, since: 'a' }, '7d': { usd: 2, since: 'a' } }, 50),
    key('capture-sync', { today: { usd: 0.5, since: 'a' }, '7d': { usd: 1, since: 'a' } }, 12),
  ],
  updated_at: '2026-09-11T12:00:00',
  ...over,
});

const cronJob = (over: Partial<CronCostsJob> = {}): CronCostsJob => ({
  id: 'daily-brief',
  name: 'Daily Briefing',
  no_agent: false,
  last_run: {
    at: 1_789_000_200, // epoch seconds
    cost_usd: 0.2,
    cost_status: 'actual',
    tokens: 40_000,
    model: 'anthropic/claude-opus-4-5',
  },
  week: {
    runs: 5,
    cost_usd: 1.25,
    unknown_runs: 0,
    tokens: 400_000,
    days: { '2026-09-10': { cost_usd: 0.25, runs: 1, unknown_runs: 0 } },
  },
  ...over,
});

const cronReport = (jobs: CronCostsJob[]): CronCostsReport => ({
  generated_at: '2026-09-11T12:00:00',
  window_days: 7,
  jobs,
  count: jobs.length,
});

async function renderScreen(seed: {
  summary?: SpendSummary;
  timeseries?: SpendTimeseries;
  credits?: OpenRouterCredits | null;
  cronCosts?: CronCostsReport;
  cronCostsError?: Error;
  recurring?: RecurringCosts | null;
  recurringError?: Error;
}) {
  mockApiState.summary = seed.summary ?? null;
  mockApiState.timeseries = seed.timeseries ?? null;
  mockApiState.credits = seed.credits ?? null;
  mockApiState.cronCosts = seed.cronCosts ?? cronReport([]);
  mockApiState.cronCostsError = seed.cronCostsError ?? null;
  mockApiState.recurring = seed.recurring ?? null;
  mockApiState.recurringError = seed.recurringError ?? null;

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <QueryClientProvider client={client}>
          <CostScreen />
        </QueryClientProvider>
      </SafeAreaProvider>,
    );
  });
  // A second flush: react-query's notifyManager batches observer updates onto
  // a timer, so the mount act alone can return before the resolved queries
  // have re-rendered the tree.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  mounted.push(renderer);
  return inspect(renderer);
}

// --- endpoints the page reads -----------------------------------------------

test('the page reads exactly the five Cost endpoints, the windowed ones on the window', async () => {
  await renderScreen({ summary: summary(), timeseries: timeseries(), credits: credits(), cronCosts: cronReport([]) });
  expect(mockApiState.summaryWindows).toEqual(['today']); // the PWA's initial window
  expect(api.spendTimeseries).toHaveBeenCalledWith('today');
  expect(api.openrouterCredits).toHaveBeenCalled();
  expect(api.cronCosts).toHaveBeenCalled();
  // Recurring is windowed too: it prorates onto the span the pills resolve, so
  // reading it without the window would put a 30d figure under a 'today' pill.
  expect(mockApiState.recurringWindows).toEqual(['today']);
});

// --- the rework's page order ------------------------------------------------

test('the two account cards sit at the FOOT of the page, below the scheduled jobs', async () => {
  // money.md §2.2 orders them 6th and 7th, above the history header. The rework
  // moved them last (8e5d798 / 9134121): a port that follows the doc fails here.
  const v = await renderScreen({
    summary: summary(),
    timeseries: timeseries(),
    credits: credits(),
    cronCosts: cronReport([cronJob()]),
  });
  const order = [
    '$1.50', // hero
    'per key · today',
    'History · day',
    'Models',
    'Scheduled jobs · 7d',
    'prompt cache',
    'openrouter balance',
  ].map((line) => v.indexOf(line));

  expect(order.every((i) => i >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

test('the per-key card sits directly under the hero, not inside the balance card', async () => {
  const v = await renderScreen({ summary: summary(), timeseries: timeseries(), credits: credits() });
  expect(v.indexOf('per key · today')).toBeLessThan(v.indexOf('History · day'));
  expect(v.indexOf('per key · today')).toBeLessThan(v.indexOf('openrouter balance'));
});

// --- per-key spend by window ------------------------------------------------

test('per-key spend reads the selected window from `windows`, with lifetime alongside', () => {
  const v = view(<PerKeyCard keys={credits().keys!} window="7d" />);
  expect(v.has('per key · 7d')).toBe(true);
  expect(v.has('$3.00')).toBe(true); // 2 + 1, the window total in the header
  expect(v.has('$2.00 · $50.00 total')).toBe(true);
  expect(v.has('$1.00 · $12.00 total')).toBe(true);
  // The pre-rework card labelled the header with the meter's own period
  // ("this week"), never the pill.
  expect(v.lines.some((l) => l.includes('this week'))).toBe(false);
});

test('a key with no spend in the window keeps its row (and the split bar disappears)', () => {
  // Pre-rework this card filtered rows to value > 0 and returned null when the
  // total was 0; now every key is listed from its first snapshot on.
  const keys = [key('hermes', { today: null }, 50), key('capture-sync', {}, 12)];
  const v = view(<PerKeyCard keys={keys} window="today" />);
  expect(v.has('hermes')).toBe(true);
  expect(v.has('capture-sync')).toBe(true);
  expect(v.has('$0 · $50.00 total')).toBe(true);
  expect(perKeyRows(keys, 'today').every((r) => r.usd === 0)).toBe(true);
});

// --- the unpriced warning ---------------------------------------------------

test('unpriced entries carrying no tokens raise no warning', async () => {
  // The live payload's {model:'unknown', input:0, output:0, cache_read:0} rows
  // are exactly what money.md §2.4 says renders "1 model unpriced". It no longer
  // does (5dd60c3) — warning about them claims spend that cannot exist.
  const s = summary({ unpriced: [{ model: 'unknown', input: 0, output: 0, cache_read: 0 }] });
  const v = await renderScreen({ summary: s, timeseries: timeseries() });
  expect(v.lines.some((l) => l.includes('unpriced — spend not counted'))).toBe(false);
  expect(unpricedEntries(s)).toEqual([]);
});

test('an unpriced entry that really carries tokens still warns, with the PWA copy', async () => {
  const v = await renderScreen({
    summary: summary({ unpriced: [{ model: 'openrouter/mimo-v2-5', input: 900, output: 100, cache_read: 0 }] }),
    timeseries: timeseries(),
  });
  expect(v.has('1 model unpriced — spend not counted')).toBe(true);
  expect(v.has('mimo-v2-5 (1k tok)')).toBe(true);
});

// --- bucket detail ----------------------------------------------------------

test('the bucket header leads with the weekday on a day axis, and only there', () => {
  const day = view(
    <BucketDetail point={point()} granularity="day" index={1} count={2} onStep={() => {}} series={[]} />,
  );
  expect(day.has(`${new Date('2026-09-10T00:00:00').toLocaleDateString([], { weekday: 'short' })} Sep 10`)).toBe(true);

  const hour = view(
    <BucketDetail
      point={point({ date: '2026-09-10T14:00' })}
      granularity="hour"
      index={5}
      count={9}
      onStep={() => {}}
      series={[]}
    />,
  );
  expect(hour.has('2p')).toBe(true);
  expect(hour.lines.some((l) => /^\w{3} 2p$/.test(l))).toBe(false);
});

test('a bucket with no priced model says so rather than showing an empty list', () => {
  const v = view(
    <BucketDetail
      point={point({ per_model: {}, spend_usd: 0 })}
      granularity="day"
      index={0}
      count={1}
      onStep={() => {}}
      series={[]}
    />,
  );
  expect(v.has('no usage in this bucket')).toBe(true);
  expect(v.has('3 sessions · 1.2M in · 45k out · 900k cached')).toBe(true);
});

// --- delta chip -------------------------------------------------------------

test('spend up wears the DOWN colour — direction times goodness', () => {
  const up = view(<DeltaChip deltaPct={25} prevRange={{ start: '2026-09-10T00:00', end: '2026-09-10T23:59' }} />);
  expect(up.has('↑ 25% vs Sep 10')).toBe(true);
  expect(up.colorOf('↑ 25% vs Sep 10')).toBe(tokens()['status-down']);

  const down = view(<DeltaChip deltaPct={-40} prevRange={{ start: '2026-09-08T00:00', end: '2026-09-10T23:59' }} />);
  expect(down.has('↓ 40% vs Sep 8–Sep 10')).toBe(true);
  expect(down.colorOf('↓ 40% vs Sep 8–Sep 10')).toBe(tokens()['status-up']);

  const flat = view(<DeltaChip deltaPct={0.01} prevRange={{ start: '2026-09-10T00:00', end: '2026-09-10T23:59' }} />);
  expect(flat.colorOf('→ 0% vs Sep 10')).toBe(tokens()['fg-3']);

  expect(view(<DeltaChip deltaPct={null} prevRange={null} />).lines).toEqual([]);
});

// --- scheduled jobs ---------------------------------------------------------

test('a week of runs with no recorded cost says "cost unknown", never $0.00', () => {
  const v = view(
    <CronJobCostRow job={cronJob({ week: { runs: 3, cost_usd: 0, unknown_runs: 3, tokens: 0, days: {} } })} last />,
  );
  expect(v.has('cost unknown')).toBe(true);
  expect(v.lines.some((l) => l === '$0')).toBe(false);
});

test('a priced week still counts the runs it could not price', () => {
  const v = view(
    <CronJobCostRow
      job={cronJob({ week: { runs: 5, cost_usd: 1.25, unknown_runs: 2, tokens: 400_000, days: {} } })}
      last
    />,
  );
  expect(v.has('$1.25')).toBe(true);
  expect(v.has('5 runs · 400k tok · opus-4-5 · 2 cost unknown')).toBe(true);
});

test('a job removed from jobs.json is named, not left blank', () => {
  const v = view(<CronJobCostRow job={cronJob({ name: null, last_run: null })} last />);
  expect(v.has('removed job')).toBe(true);
  expect(v.has('5 runs · 400k tok · no model')).toBe(true);
});

test('a failing cron-costs read still prints its header so the gap is explained', async () => {
  const v = await renderScreen({
    summary: summary(),
    timeseries: timeseries(),
    cronCostsError: new Error('cron costs unavailable — bridge down'),
  });
  expect(v.has('Scheduled jobs · 7d')).toBe(true);
  expect(v.has('Job costs unavailable')).toBe(true);
  expect(v.has('cron costs unavailable — bridge down')).toBe(true);
});

test('script-only jobs are a footnote, not rows', async () => {
  const scriptJob = cronJob({
    id: 'trader-derive',
    name: 'Trader derive',
    no_agent: true,
    last_run: null,
    week: { runs: 0, cost_usd: 0, unknown_runs: 0, tokens: 0, days: {} },
  });
  const v = await renderScreen({
    summary: summary(),
    timeseries: timeseries(),
    cronCosts: cronReport([cronJob(), scriptJob]),
  });
  expect(v.has('+ 1 script job · $0 LLM · no model')).toBe(true);
  expect(v.has('Trader derive')).toBe(false);
  expect(v.has('Daily Briefing')).toBe(true);
});

// --- axis labels ------------------------------------------------------------

test('bucket ticks follow the key shape, not the window', () => {
  expect(fmtBucket('2026-09-10T00:00', 'hour', 4)).toMatch(/^\w{3} 12a$/);
  expect(fmtBucket('2026-09-10T14:00', 'hour', 4)).toBe('2p');
  expect(fmtBucket('2026-09-10T12:00', 'hour', 4)).toBe('12p');
  expect(fmtBucket('2026-09-10T09:00', 'hour', 0)).toMatch(/^\w{3} 9a$/);
  expect(fmtBucket('2026-09-10', 'day', 1)).toBe('Sep 10');
  expect(fmtBucket('2026-09-07', 'week', 1)).toBe('wk Sep 7');
  expect(fmtBucket('2026-09', 'month', 1)).toBe('Sep');
  expect(fmtBucket('whatever', 'quarter', 1)).toBe('whatever');
});

// --- chart wiring -----------------------------------------------------------

test('the chart is stacked by the selected identity and says so out loud', async () => {
  const v = await renderScreen({ summary: summary(), timeseries: timeseries() });
  const bars = v.renderer.root.findByProps({ testID: 'stacked-bars' });
  expect(bars.props.ariaTitle).toBe('Spend per day, stacked by models');
  expect(bars.props.height).toBe(130);
  // Last bucket is the in-progress one.
  expect(bars.props.buckets.map((b: { partial?: boolean }) => b.partial)).toEqual([false, true]);
  expect(bars.props.buckets[1].values).toEqual({ 'claude-opus-4-5': 0.8, other: 0.2 });
});

test('an empty window explains itself instead of drawing an empty chart', async () => {
  const v = await renderScreen({ summary: summary(), timeseries: timeseries({ points: [] }) });
  expect(v.has('No spend history')).toBe(true);
  expect(v.has('No usage recorded in today.')).toBe(true);
  expect(v.renderer.root.findAllByProps({ testID: 'stacked-bars' })).toHaveLength(0);
});


// --- recurring spend (the page foot) ----------------------------------------

const recurring = (over: Partial<RecurringCosts> = {}): RecurringCosts => ({
  window: 'today',
  range: { start: '2026-09-11T00:00:00-04:00', end: '2026-09-11T17:40:00-04:00' },
  elapsed_days: 0.736,
  items: [
    {
      id: 'model-plan',
      label: 'Example model plan',
      vendor: 'Example AI',
      category: 'model',
      cadence: 'monthly',
      amount_usd: 200,
      daily_usd: 6.5753,
      monthly_usd: 200,
      window_usd: 4.84,
      note: null,
    },
    {
      id: 'annual-example',
      label: 'Annual example',
      vendor: 'Example',
      category: 'infrastructure',
      cadence: 'annual',
      amount_usd: 106.91,
      daily_usd: 0.2927,
      monthly_usd: 8.91,
      window_usd: 0.215,
      note: null,
    },
  ],
  total_window_usd: 5.06,
  total_monthly_usd: 208.91,
  excludes: ['openrouter', 'anthropic-api-credits'],
  updated_on: '2026-09-11',
  updated_at: '',
  ...over,
});

test('the recurring card sits at the very foot, below the OpenRouter balance', async () => {
  const v = await renderScreen({
    summary: summary(),
    timeseries: timeseries(),
    credits: credits(),
    recurring: recurring(),
  });
  expect(v.indexOf('openrouter balance')).toBeGreaterThanOrEqual(0);
  expect(v.indexOf('fixed · today')).toBeGreaterThan(v.indexOf('openrouter balance'));
});

test('each row pairs its prorated share with the rate it was derived from', async () => {
  const v = await renderScreen({ summary: summary(), timeseries: timeseries(), recurring: recurring() });
  expect(v.has('Example model plan')).toBe(true);
  expect(v.indexOf('$4.84')).toBeGreaterThanOrEqual(0); // today's share of $200/mo
  expect(v.indexOf('/mo')).toBeGreaterThanOrEqual(0);
  // an annual line must say /yr — calling it /mo would overstate it 12x
  expect(v.indexOf('$107/yr')).toBeGreaterThanOrEqual(0);
});

test('the footnote names the exclusions, so the card cannot read as total spend', async () => {
  const v = await renderScreen({ summary: summary(), timeseries: timeseries(), recurring: recurring() });
  expect(v.indexOf('run-rate')).toBeGreaterThanOrEqual(0);
  expect(v.indexOf('excludes openrouter, anthropic-api-credits')).toBeGreaterThanOrEqual(0);
});

test('no ledger = no card, rather than a $0 card claiming there is no fixed spend', async () => {
  const v = await renderScreen({ summary: summary(), timeseries: timeseries(), recurring: null });
  expect(v.indexOf('fixed · ')).toBe(-1);
  const empty = await renderScreen({
    summary: summary(),
    timeseries: timeseries(),
    recurring: recurring({ items: [] }),
  });
  expect(empty.indexOf('fixed · ')).toBe(-1);
});

test('a ledger read failure surfaces instead of silently dropping the card', async () => {
  const v = await renderScreen({
    summary: summary(),
    timeseries: timeseries(),
    recurringError: new Error('ledger unreadable'),
  });
  expect(v.indexOf('Recurring costs unavailable')).toBeGreaterThanOrEqual(0);
});

test('the total is the hero-neutral colour — gold stays the hero figure alone', async () => {
  const v = await renderScreen({ summary: summary(), timeseries: timeseries(), recurring: recurring() });
  expect(v.colorOf('$5.06')).toBe(tokens()['fg-0']);
});

test('recurringRows/recurringFootnote format without a renderer', () => {
  const rows = recurringRows(recurring());
  expect(rows.map((r) => r.id)).toEqual(['model-plan', 'annual-example']);
  expect(rows[0].windowUsd).toBe('$4.84');
  expect(rows[1].sourceTail).toBe(' · $107/yr');
  expect(recurringFootnote(recurring({ excludes: [] }))).toBe('$209/mo run-rate');
});
