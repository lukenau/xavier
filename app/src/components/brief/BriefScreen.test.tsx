// The brief screen, rendered for real against the 2026-09-16 fixture brief.
//
// The gate these tests hold, following DecisionsScreen.test.tsx: a tap issues a
// GENUINE api.dismissBriefItem POST against a mocked fetch, and the typed
// failure comes back out at the row — never a stubbed success and never a
// silent no-op, which is what "most of the buttons and dismissals didn't really
// work" meant.
jest.mock('expo-router', () => ({
  useIsFocused: () => true,
  // Screen arms the tab-re-press scroll with it; behaviour is asserted in Screen.test.tsx.
  useScrollToTop: () => {},
  // useHideTabBar runs this on mount (tabBar.tsx:54).
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
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => {}),
  selectionAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));
jest.mock('../briefs', () => ({ openBrief: jest.fn(), resolveBriefUri: jest.fn() }));

import TestRenderer, { act } from 'react-test-renderer';
import { ScrollView, Text } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { router } from 'expo-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { QUERY_TUNING } from '../../lib/query';
import { RefreshControl, SCREEN_GUTTER, StatePanel } from '../shell';
import { BucketHead } from './BucketHead';
import BriefScreen from './BriefScreen';
import { SourceBanner } from './SourceBanner';
import { UndoRow } from './UndoRow';
import { ARM_TIMEOUT_MS, UNDO_WINDOW_MS } from './useBriefActions';
import { allItems, bucketView, type Brief } from './briefModel';
import { LIVE_BRIEF } from './liveBrief.fixture';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};
const BASE = 'https://hub.example.com/api';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** The brief GET, then whatever the test queues for the writes. */
function serveBrief(brief: Brief = LIVE_BRIEF) {
  (global.fetch as jest.Mock).mockImplementation((url: string) =>
    Promise.resolve(
      String(url).includes('/brief?') || String(url).endsWith('/brief')
        ? jsonResponse(brief)
        : jsonResponse({ ok: true, item_id: 'x', action: 'dismiss' }),
    ),
  );
}

// Every mounted tree and its client are torn down after each test. Without
// this jest RUNS the suite green and then never exits: react-query's
// notifyManager keeps a timer alive for as long as an observer is mounted, and
// a leaked one is an open handle (query.test.ts hits the same thing and
// unmounts + clears in a `finally` for the same reason).
// Arrays, not single values: one test renders TWICE, and a client that is
// tracked only by "the last one" leaks its observer timer forever.
let clients: QueryClient[] = [];
let mounted: TestRenderer.ReactTestRenderer[] = [];

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(
      <QueryClientProvider client={client}>
        <SafeAreaProvider initialMetrics={METRICS}>
          <BriefScreen />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );
  });
  mounted.push(tree);
  // Settle on the CONDITION, not on a fixed number of ticks: the query's own
  // retry (QUERY_TUNING.brief keeps the global retry:1) puts a real ~1s delay
  // in front of the error branch, so microtask flushes alone never get there.
  // Same reason query.test.ts has a waitFor of its own.
  const deadline = Date.now() + 3000;
  while (isPending(tree) && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  revealAllRails(tree);
  return tree;
}

/** H7: the swipe rail is not mounted until its row's gesture begins. These
 * tests exercise the rail's own wiring (does tapping Done actually arm/
 * dismiss) as if a swipe had already happened, so reveal every row's rail
 * right after mount rather than hand-simulating a drag in every test. The
 * mount-timing claim itself is covered separately in SwipeRail.test.tsx. */
function revealAllRails(tree: TestRenderer.ReactTestRenderer) {
  act(() => {
    for (const gd of tree.root.findAllByType(GestureDetector)) {
      (gd.props.gesture as { handlers: { onBegin?: () => void } }).handlers.onBegin?.();
    }
  });
}

/** Still showing the skeleton: no bucket head and no state panel yet. */
function isPending(tree: TestRenderer.ReactTestRenderer): boolean {
  return (
    tree.root.findAllByType(BucketHead).length === 0 &&
    tree.root.findAllByType(StatePanel).length === 0
  );
}

function texts(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(Text)
    .flatMap((n) => [n.props.children].flat())
    .filter((c) => typeof c === 'string' || typeof c === 'number')
    .map(String);
}

function button(tree: TestRenderer.ReactTestRenderer, label: string, index = 0) {
  const found = tree.root.findAll(
    (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  );
  expect(found.length).toBeGreaterThan(index);
  return found[index];
}

/** The write POSTs only — the brief GET is filtered out. */
function writes(): { url: string; body: Record<string, unknown> }[] {
  return (global.fetch as jest.Mock).mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(init.body) }));
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
  serveBrief();
});

afterEach(() => {
  act(() => {
    for (const tree of mounted) tree.unmount();
  });
  mounted = [];
  for (const client of clients) client.clear();
  clients = [];
});

describe('the whole brief renders', () => {
  test('44 items, four sticky heads, the banner and the terminus', async () => {
    const tree = await render();
    const rendered = texts(tree);
    for (const item of allItems(LIVE_BRIEF)) expect(rendered).toContain(item.title);
    expect(tree.root.findAllByType(BucketHead)).toHaveLength(4);
    expect(tree.root.findAllByType(SourceBanner)).toHaveLength(1);
    expect(rendered.join(' ')).toContain('110 held back');
    expect(rendered.join(' ')).toContain('Wed Sep 16');
  });

  test('the ONE query is ["brief"] on the brief tuning — no poll', async () => {
    await render();
    const gets = (global.fetch as jest.Mock).mock.calls.filter(([, init]) => !init?.method);
    expect(gets).toHaveLength(1);
    expect(String(gets[0][0])).toBe(`${BASE}/brief`);
    expect(QUERY_TUNING.brief.refetchInterval).toBe(false);
    expect(QUERY_TUNING.brief.staleTime).toBe(300_000);
  });

  test('bucket heads are sticky, and the indices point AT the heads', async () => {
    const tree = await render();
    const scroll = tree.root.findAll((n) => Array.isArray(n.props.stickyHeaderIndices))[0];
    const indices: number[] = scroll.props.stickyHeaderIndices;
    expect(indices).toHaveLength(4);
    const children = [scroll.props.children].flat();
    // Off-by-one here is the whole failure mode: a sticky index that lands on a
    // row pins a row to the top of the screen forever.
    for (const i of indices) expect(children[i].type).toBe(BucketHead);
  });

  test('there is no hero counter and no segmented filter anywhere', async () => {
    const rendered = texts(await render());
    expect(rendered).not.toContain('44');
    expect(rendered).not.toContain('44 items');
    // Section counts DO appear, right-aligned in their heads.
    expect(rendered).toContain('20');
  });
});

/** Walks up from a node to the nearest ancestor (inclusive) whose style sets
 * `paddingHorizontal` — PageTitle interposes its own wrapper between
 * RefreshControl and BriefHeader's own outer View, so the inset isn't on the
 * immediate parent. */
function horizontalInset(node: TestRenderer.ReactTestInstance): number | undefined {
  let n: TestRenderer.ReactTestInstance | null = node;
  while (n) {
    const flat = [n.props.style].flat().filter(Boolean) as Record<string, unknown>[];
    for (const s of flat) {
      if (s && 'paddingHorizontal' in s) return s.paddingHorizontal as number;
    }
    n = n.parent;
  }
  return undefined;
}

describe('design review fixes (Task V)', () => {
  test('H1: the header sits at the same horizontal inset as the rows, in every page state', async () => {
    const tree = await render();
    expect(horizontalInset(tree.root.findByType(RefreshControl))).toBe(SCREEN_GUTTER);
  });

  test('H2/H3: loading and error states use the same header inset as the loaded one', async () => {
    (global.fetch as jest.Mock).mockImplementation(
      () => new Promise(() => {}), // never resolves — stays on the skeleton
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <QueryClientProvider client={client}>
          <SafeAreaProvider initialMetrics={METRICS}>
            <BriefScreen />
          </SafeAreaProvider>
        </QueryClientProvider>,
      );
    });
    mounted.push(tree);
    expect(horizontalInset(tree.root.findByType(RefreshControl))).toBe(SCREEN_GUTTER);
  });

  test('H4/H12: the screen has a real page title and a back control, not just a grey date', async () => {
    const tree = await render();
    expect(texts(tree)).toContain('Today’s brief');
    const back = button(tree, 'Home');
    act(() => back.props.onPress());
    expect(router.back).toHaveBeenCalledTimes(1);
    // The date is now a subtitle, not the page's only heading.
    const headers = tree.root.findAll((n) => n.props.accessibilityRole === 'header');
    expect(headers.some((n) => [n.props.children].flat().includes('Today’s brief'))).toBe(true);
    const dateNode = tree.root.findAll((n) => [n.props.children].flat().includes('Wed Sep 16'))[0];
    expect(dateNode.props.accessibilityRole).not.toBe('header');
  });

  test('H5: pulling to refresh triggers a real refetch of the brief', async () => {
    const tree = await render();
    const gets = () => (global.fetch as jest.Mock).mock.calls.filter(([, init]) => !init?.method);
    expect(gets()).toHaveLength(1);

    const scroll = tree.root.findByType(ScrollView);
    expect(scroll.props.refreshControl).toBeTruthy();
    await act(async () => {
      scroll.props.refreshControl.props.onRefresh();
    });

    expect(gets().length).toBeGreaterThan(1);
  });
});

describe('a tap issues a genuine API call', () => {
  test('Done arms first, and only the SECOND tap POSTs — a full swipe never commits', async () => {
    const tree = await render();
    // The first rail in the tree is the first NOW block's: Now is swipeable
    // like any other row, and it is what sits at the top of the screen.
    const item = bucketView(LIVE_BRIEF, 'now')[0];

    act(() => button(tree, 'Done').props.onPress());
    // Armed, not committed. Ruling 61.
    expect(writes()).toHaveLength(0);
    expect(texts(tree)).toContain('Confirm?');

    await act(async () => button(tree, 'Confirm?').props.onPress());
    const posted = writes();
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe(`${BASE}/briefing/dismiss.json`);
    expect(posted[0].body).toEqual({
      item_id: item.item_id,
      action: 'dismiss',
      token: item.token,
      // The BRIEF's date, not today's — the token is an HMAC over it.
      date: LIVE_BRIEF.date,
    });
  });

  test('Snooze is single-tap, because it expires', async () => {
    const tree = await render();
    await act(async () => button(tree, 'Snooze').props.onPress());
    expect(writes()).toHaveLength(1);
    expect(writes()[0].body.action).toBe('snooze:1d');
  });

  test('a committed row becomes an undo line in its own slot, not a toast', async () => {
    const tree = await render();
    const item = bucketView(LIVE_BRIEF, 'now')[0];
    act(() => button(tree, 'Done').props.onPress());
    await act(async () => button(tree, 'Confirm?').props.onPress());
    expect(tree.root.findAllByType(UndoRow)).toHaveLength(1);
    expect(texts(tree).join(' ')).toContain(`Done · ${item.title}`);
    // And it carries a real button, which is why it cannot be the shell Toast
    // (that one is pointerEvents="none").
    expect(button(tree, 'Undo')).toBeTruthy();
  });

  test('Undo POSTs action:"undo" and puts the row back', async () => {
    const tree = await render();
    const item = bucketView(LIVE_BRIEF, 'now')[0];
    act(() => button(tree, 'Done').props.onPress());
    await act(async () => button(tree, 'Confirm?').props.onPress());
    await act(async () => button(tree, 'Undo').props.onPress());
    expect(writes().map((w) => w.body.action)).toEqual(['dismiss', 'undo']);
    expect(tree.root.findAllByType(UndoRow)).toHaveLength(0);
    expect(texts(tree)).toContain(item.title);
  });

  test('the snooze undo line uses the SERVER’s `until`, not the local guess', async () => {
    // The `until` is derived from today rather than written down: untilLabel()
    // prints an absolute date only 7+ days out, so a fixed one stops testing
    // what it names the moment the calendar walks past it.
    const now = new Date();
    const until = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 10, 12);
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const iso = `${until.getFullYear()}-${String(until.getMonth() + 1).padStart(2, '0')}-${String(
      until.getDate(),
    ).padStart(2, '0')}T12:00:00`;
    (global.fetch as jest.Mock).mockImplementation((url: string, init?: { method?: string }) =>
      Promise.resolve(
        init?.method === 'POST'
          ? jsonResponse({ ok: true, item_id: 'x', action: 'snooze:1d', until: iso })
          : jsonResponse(LIVE_BRIEF),
      ),
    );
    const tree = await render();
    await act(async () => button(tree, 'Snooze').props.onPress());
    const shown = texts(tree).join(' ');
    expect(shown).toContain(`Snoozed to ${MONTHS[until.getMonth()]} ${until.getDate()}`);
    // The local guess for a 1d span would have said "tomorrow (Day)".
    expect(shown).not.toContain('Snoozed to tomorrow');
  });
});

describe('the why chips (Ruling 146)', () => {
  test('a chip posts reason:<code>, and the line becomes Noted', async () => {
    const tree = await render();
    const item = bucketView(LIVE_BRIEF, 'now')[0];
    act(() => button(tree, 'Done').props.onPress());
    await act(async () => button(tree, 'Confirm?').props.onPress());
    expect(texts(tree)).toContain('why?');

    await act(async () => button(tree, 'not mine').props.onPress());
    const posted = writes();
    expect(posted[posted.length - 1]).toEqual({
      url: `${BASE}/briefing/dismiss.json`,
      body: {
        item_id: item.item_id, action: 'reason:not-mine', token: item.token, date: LIVE_BRIEF.date,
      },
    });
    expect(texts(tree)).toContain('Noted');
    expect(texts(tree)).not.toContain('why?');
  });

  test('a snoozed row gets no chips at all — a snooze is "not now", not "not mine"', async () => {
    const tree = await render();
    await act(async () => button(tree, 'Snooze').props.onPress());
    expect(tree.root.findAllByType(UndoRow)).toHaveLength(1);
    expect(texts(tree)).not.toContain('why?');
  });

  test('a failed post keeps the chips — Noted never appears', async () => {
    const tree = await render();
    act(() => button(tree, 'Done').props.onPress());
    await act(async () => button(tree, 'Confirm?').props.onPress());

    (global.fetch as jest.Mock).mockImplementation((url: string, init?: { method?: string }) =>
      Promise.resolve(
        init?.method === 'POST' ? jsonResponse({ detail: 'nope' }, 500) : jsonResponse(LIVE_BRIEF),
      ),
    );
    await act(async () => button(tree, 'already done').props.onPress());
    expect(texts(tree)).toContain('why?');
    expect(texts(tree)).not.toContain('Noted');
  });
});

describe('failures restore the row and say which failure it was', () => {
  const failWith = (status: number, body: unknown) => {
    (global.fetch as jest.Mock).mockImplementation((url: string, init?: { method?: string }) =>
      Promise.resolve(init?.method === 'POST' ? jsonResponse(body, status) : jsonResponse(LIVE_BRIEF)),
    );
  };

  test('403 says the brief expired — and the row comes BACK', async () => {
    failWith(403, { detail: { code: 'bad_item_token', detail: 'bad item token' } });
    const tree = await render();
    const item = bucketView(LIVE_BRIEF, 'now')[0];
    act(() => button(tree, 'Done').props.onPress());
    await act(async () => button(tree, 'Confirm?').props.onPress());

    expect(tree.root.findAllByType(UndoRow)).toHaveLength(0);
    expect(texts(tree)).toContain(item.title);
    expect(texts(tree).join(' ')).toContain('this brief expired');
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('error');
  });

  test('503 says dismissals are offline — a DIFFERENT sentence', async () => {
    failWith(503, { detail: { code: 'dismiss_key_unprovisioned', detail: 'not provisioned' } });
    const tree = await render();
    act(() => button(tree, 'Done').props.onPress());
    await act(async () => button(tree, 'Confirm?').props.onPress());
    const rendered = texts(tree).join(' ');
    expect(rendered).toContain('offline right now');
    expect(rendered).not.toContain('expired');
  });

  test('a network error says nothing was sent', async () => {
    (global.fetch as jest.Mock).mockImplementation((url: string, init?: { method?: string }) =>
      init?.method === 'POST' ? Promise.reject(new Error('offline')) : Promise.resolve(jsonResponse(LIVE_BRIEF)),
    );
    const tree = await render();
    act(() => button(tree, 'Done').props.onPress());
    await act(async () => button(tree, 'Confirm?').props.onPress());
    expect(texts(tree).join(' ')).toContain('nothing was sent');
  });

  test('a brief with no tokens never POSTs at all — it says so instead of 403ing', async () => {
    const strip = (items: typeof LIVE_BRIEF.buckets.now) =>
      items.map(({ token: _drop, ...rest }) => rest);
    const untokened: Brief = {
      ...LIVE_BRIEF,
      buckets: {
        now: strip(LIVE_BRIEF.buckets.now),
        today: strip(LIVE_BRIEF.buckets.today),
        week: strip(LIVE_BRIEF.buckets.week),
        background: strip(LIVE_BRIEF.buckets.background),
      },
    };
    serveBrief(untokened);
    const tree = await render();
    act(() => button(tree, 'Done').props.onPress());
    await act(async () => button(tree, 'Confirm?').props.onPress());
    expect(writes()).toHaveLength(0);
    expect(texts(tree).join(' ')).toContain('predates dismissals');
  });
});

describe('arming', () => {
  test('an armed row disarms itself after 3s', async () => {
    // Fake timers only AFTER the render settles: the waitFor in render() runs
    // on real ones, and the arm timeout is scheduled by the tap below.
    const tree = await render();
    jest.useFakeTimers();
    try {
      act(() => button(tree, 'Done').props.onPress());
      expect(texts(tree)).toContain('Confirm?');
      act(() => {
        jest.advanceTimersByTime(ARM_TIMEOUT_MS + 1);
      });
      expect(texts(tree)).not.toContain('Confirm?');
      expect(writes()).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('scrolling disarms every armed row', async () => {
    const tree = await render();
    act(() => button(tree, 'Done').props.onPress());
    expect(texts(tree)).toContain('Confirm?');
    const scroll = tree.root.findAll((n) => typeof n.props.onScrollBeginDrag === 'function')[0];
    act(() => scroll.props.onScrollBeginDrag());
    expect(texts(tree)).not.toContain('Confirm?');
  });

  test('the undo slot is released after 6s, and the brief is refetched', async () => {
    const tree = await render();
    jest.useFakeTimers();
    try {
      act(() => button(tree, 'Done').props.onPress());
      await act(async () => button(tree, 'Confirm?').props.onPress());
      expect(tree.root.findAllByType(UndoRow)).toHaveLength(1);
      await act(async () => {
        jest.advanceTimersByTime(UNDO_WINDOW_MS + 1);
      });
      expect(tree.root.findAllByType(UndoRow)).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('haptics are sparse and specific', () => {
  test('arming selects, dismissing succeeds, snoozing is a light impact', async () => {
    const tree = await render();
    act(() => button(tree, 'Done').props.onPress());
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
    await act(async () => button(tree, 'Confirm?').props.onPress());
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('success');
  });

  test('nothing fires on a plain render — no haptic on scroll or on first paint', async () => {
    await render();
    expect(Haptics.selectionAsync).not.toHaveBeenCalled();
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  });
});

describe('page states', () => {
  test('a failed read names the error rather than showing an empty day', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ detail: 'no brief' }, 404));
    const rendered = texts(await render()).join(' ');
    expect(rendered).toContain('Couldn’t read today’s brief');
    expect(rendered).not.toContain('Your day is clear');
  });

  test('H13: an empty brief with healthy sources reads calm, as prose — not the StatePanel chrome', async () => {
    serveBrief({
      ...LIVE_BRIEF,
      buckets: { now: [], today: [], week: [], background: [] },
      sources: { email: 'ok', calendar: 'ok' },
      deferred: [],
      held_back: { total: 0, by_code: {} },
    });
    const tree = await render();
    expect(texts(tree).join(' ')).toContain('Your day is clear.');
    // No border/fill/radius card standing in for the good-day sentence.
    expect(tree.root.findAllByType(StatePanel)).toHaveLength(0);
  });

  test('H13: an empty brief with dead sources never claims the day is clear, and keeps the StatePanel error chrome', async () => {
    serveBrief({
      ...LIVE_BRIEF,
      buckets: { now: [], today: [], week: [], background: [] },
      sources: { email: 'unreachable', calendar: 'absent' },
    });
    const tree = await render();
    const rendered = texts(tree).join(' ');
    expect(rendered).toContain('Most of your inputs are missing');
    expect(rendered).not.toContain('Your day is clear');
    expect(rendered).toContain('incomplete');
    // The degraded state stays the app's error idiom — never mistaken for the
    // calm day's plain prose.
    const panels = tree.root.findAllByType(StatePanel);
    expect(panels).toHaveLength(1);
    expect(panels[0].props.tone).toBe('error');
  });

  test('a served-from-yesterday brief says so in the header', async () => {
    serveBrief({ ...LIVE_BRIEF, date: '2026-09-14', served_date: '2026-09-14' });
    // date === served_date is the normal case even after a fallback, because
    // the older FILE is what was loaded — so the label keys off a real
    // mismatch, which the server sets when it serves a different day.
    expect(texts(await render()).join(' ')).not.toContain("hasn't landed");

    serveBrief({ ...LIVE_BRIEF, date: '2026-09-16', served_date: '2026-09-14' });
    expect(texts(await render()).join(' ')).toContain("today's brief hasn't landed");
  });
});

describe('Background is not swipeable (spec §5.4 / §12.4)', () => {
  test('background rows offer no Done and no Snooze', async () => {
    const tree = await render();
    // Two Now + 20 Today + 20 Week rails, and none for the two Background rows.
    const rails = (label: string) =>
      tree.root.findAll(
        (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
      ).length;
    expect(allItems(LIVE_BRIEF)).toHaveLength(44);
    expect(bucketView(LIVE_BRIEF, 'background')).toHaveLength(2);
    expect(rails('Done')).toBe(42);
    expect(rails('Snooze')).toBe(42);
    // The background titles are still on the page — they are just not actionable.
    for (const item of bucketView(LIVE_BRIEF, 'background')) {
      expect(texts(tree)).toContain(item.title);
    }
  });
});
