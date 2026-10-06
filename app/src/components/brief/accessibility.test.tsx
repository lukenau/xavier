// The accessibility pass (spec §10), asserted rather than eyeballed — this
// host has no simulator, so VoiceOver and AX5 cannot be checked on a device
// before review.
//
// The load-bearing one: without accessibilityActions + onAccessibilityAction on
// the element that carries the label, the swipe actions are UNREACHABLE with
// VoiceOver on. A gesture is not an accessible affordance.
jest.mock('expo-router', () => ({
  useIsFocused: () => true,
  // Screen arms the tab-re-press scroll with it; behaviour is asserted in Screen.test.tsx.
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
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => {}),
  selectionAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));
jest.mock('../briefs', () => ({ openBrief: jest.fn(), resolveBriefUri: jest.fn() }));

import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import BriefScreen from './BriefScreen';
import { BriefRow } from './BriefRow';
import { BucketHead } from './BucketHead';
import { NowBlock, titleLines } from './NowBlock';
import { UndoRow } from './UndoRow';
import { railShowsLabel, RAIL_LABEL_MAX_SCALE } from './SwipeRail';
import { ROTOR_ACTIONS } from './useBriefActions';
import { allItems, bucketView, rowAccessibilityLabel } from './briefModel';
import { LIVE_BRIEF } from './liveBrief.fixture';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let clients: QueryClient[] = [];
let mounted: TestRenderer.ReactTestRenderer[] = [];

async function renderScreen() {
  (global.fetch as jest.Mock).mockImplementation((url: string, init?: { method?: string }) =>
    Promise.resolve(
      init?.method === 'POST'
        ? jsonResponse({ ok: true, item_id: 'x', action: 'dismiss' })
        : jsonResponse(LIVE_BRIEF),
    ),
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
  const deadline = Date.now() + 3000;
  while (tree.root.findAllByType(BucketHead).length === 0 && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  // H7: the rail isn't mounted until its row's gesture begins. Reveal every
  // row's rail right after mount so a direct tap on Done/Snooze still works —
  // the mount-timing claim itself is covered in SwipeRail.test.tsx.
  act(() => {
    for (const gd of tree.root.findAllByType(GestureDetector)) {
      (gd.props.gesture as { handlers: { onBegin?: () => void } }).handlers.onBegin?.();
    }
  });
  return tree;
}

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<SafeAreaProvider initialMetrics={METRICS}>{node}</SafeAreaProvider>);
  });
  mounted.push(tree);
  return tree;
}

/** Every element VoiceOver would focus as a row.
 *
 * `typeof style === 'function'` picks the Pressable ELEMENT: the host View it
 * renders repeats the same a11y props with an already-resolved style, so
 * matching on the props alone returns three nodes per row. */
function rows(tree: TestRenderer.ReactTestRenderer) {
  return tree.root.findAll(
    (n) =>
      n.props.accessibilityRole === 'button' &&
      n.props.accessibilityHint === 'Opens details' &&
      typeof n.props.style === 'function',
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
});

afterEach(() => {
  act(() => {
    for (const tree of mounted) tree.unmount();
  });
  mounted = [];
  for (const client of clients) client.clear();
  clients = [];
});

describe('VoiceOver can reach every action without a gesture', () => {
  test('every swipeable row carries the three rotor actions, on the labelled element', async () => {
    const tree = await renderScreen();
    const focusable = rows(tree);
    // 44 rows are focusable; the two Background ones carry no actions.
    expect(focusable).toHaveLength(44);
    const withActions = focusable.filter((n) => n.props.accessibilityActions !== undefined);
    expect(withActions).toHaveLength(42);
    for (const row of withActions) {
      expect(row.props.accessibilityActions).toEqual([
        { name: 'done', label: 'Mark done' },
        { name: 'snooze', label: 'Snooze' },
        { name: 'useful', label: 'Mark useful' },
      ]);
      expect(typeof row.props.onAccessibilityAction).toBe('function');
    }
  });

  test('the rotor list and the rail offer the SAME capabilities', () => {
    // Useful has no swipe (leading swipe is unavailable), so the rotor is the
    // only place it is reachable without opening the sheet.
    expect(ROTOR_ACTIONS.map((a) => a.name).sort()).toEqual(['done', 'snooze', 'useful']);
  });

  test('the rotor `done` COMMITS DIRECTLY — no arm step (carve-out to Ruling 61)', async () => {
    const tree = await renderScreen();
    const row = rows(tree).find((n) => n.props.accessibilityActions !== undefined)!;
    await act(async () => row.props.onAccessibilityAction({ nativeEvent: { actionName: 'done' } }));
    // One POST, straight away. Two-tap guards a mis-tap while scrolling
    // one-handed; a rotor action is already deliberate, and a second rotor
    // pass would be hostile. Flagged for the user in spec §12.4.
    const posted = (global.fetch as jest.Mock).mock.calls.filter(([, i]) => i?.method === 'POST');
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0][1].body).action).toBe('dismiss');
  });

  test('rotor snooze and useful hit their own endpoints', async () => {
    const tree = await renderScreen();
    const actionable = () => rows(tree).filter((n) => n.props.accessibilityActions !== undefined);
    // Two different rows: a snoozed row leaves the list for its undo slot, so
    // re-using its node afterwards reads an unmounted component.
    await act(async () =>
      actionable()[0].props.onAccessibilityAction({ nativeEvent: { actionName: 'snooze' } }),
    );
    await act(async () =>
      actionable()[0].props.onAccessibilityAction({ nativeEvent: { actionName: 'useful' } }),
    );
    const posted = (global.fetch as jest.Mock).mock.calls
      .filter(([, i]) => i?.method === 'POST')
      .map(([url]) => String(url));
    expect(posted[0]).toContain('/briefing/dismiss.json');
    expect(posted[1]).toContain('/briefing/useful.json');
  });

  test('Background rows are focusable but offer no actions — they need none', async () => {
    const tree = await renderScreen();
    const titles = bucketView(LIVE_BRIEF, 'background').map((i) => rowAccessibilityLabel(i));
    const bg = rows(tree).filter((n) => titles.includes(n.props.accessibilityLabel));
    expect(bg).toHaveLength(2);
    for (const row of bg) expect(row.props.accessibilityActions).toBeUndefined();
  });
});

describe('labels and roles', () => {
  test('every row is one button with a spoken sentence, not a pile of texts', async () => {
    const tree = await renderScreen();
    const labels = rows(tree).map((n) => n.props.accessibilityLabel);
    expect(labels).toHaveLength(44);
    for (const item of allItems(LIVE_BRIEF)) {
      expect(labels).toContain(rowAccessibilityLabel(item));
    }
  });

  test('bucket heads are headers', async () => {
    const tree = await renderScreen();
    for (const head of tree.root.findAllByType(BucketHead)) {
      const label = head.findAll((n) => n.props.accessibilityRole === 'header');
      expect(label.length).toBeGreaterThan(0);
    }
  });

  test('the section count is not spoken twice — it is hidden from the reader', async () => {
    const tree = await renderScreen();
    const head = tree.root.findAllByType(BucketHead)[0];
    const hidden = head.findAll((n) => n.props.accessibilityElementsHidden === true);
    expect(hidden.length).toBeGreaterThan(0);
  });

  test('the undo line announces politely, without stealing focus', () => {
    const tree = render(<UndoRow label="Done · something" onUndo={() => {}} />);
    const live = tree.root.findAll((n) => n.props.accessibilityLiveRegion === 'polite');
    expect(live.length).toBeGreaterThan(0);
    // And its button is a real 44pt target.
    const undo = tree.root.find(
      (n) => n.props.accessibilityLabel === 'Undo' && typeof n.props.style === 'function',
    );
    const flat = [undo.props.style({ pressed: false })].flat(Infinity).filter(Boolean);
    expect(flat.some((s: Record<string, unknown>) => s?.minHeight === 44 && s?.minWidth === 44)).toBe(
      true,
    );
  });

  test('the split rule and the origin symbol are decorative, never spoken', () => {
    const item = bucketView(LIVE_BRIEF, 'today')[0];
    const tree = render(<BriefRow item={item} density="today" onPress={() => {}} />);
    const hidden = tree.root.findAll((n) => n.props.accessibilityElementsHidden === true);
    expect(hidden.length).toBeGreaterThan(0);
  });
});

describe('Dynamic Type', () => {
  test('titles gain a line past 1.3x rather than truncating harder', () => {
    expect(titleLines(2, 1.0)).toBe(2);
    expect(titleLines(2, 1.31)).toBe(3);
    expect(titleLines(3, 1.31)).toBe(4);
  });

  test('the rail drops to icon-only above 1.6x', () => {
    expect(railShowsLabel(1.0)).toBe(true);
    expect(railShowsLabel(RAIL_LABEL_MAX_SCALE)).toBe(true);
    expect(railShowsLabel(1.7)).toBe(false);
    expect(railShowsLabel(3.0)).toBe(false);
  });

  test('but the ARMED label survives the drop, at any scale', async () => {
    // jest reports a font scale of 2, so this suite runs entirely in the
    // icon-only regime — which is how the bug was found. Armed is the state
    // that destroys an item, and with its label dropped the only difference
    // from Done is the warn ground: no difference at all to a colour-blind
    // reader, since the symbol is a checkmark either way.
    expect(railShowsLabel()).toBe(false);
    const tree = await renderScreen();
    const done = tree.root.findAll(
      (n) => n.props.accessibilityLabel === 'Done' && typeof n.props.onPress === 'function',
    )[0];
    act(() => done.props.onPress());
    const labels = tree.root
      .findAllByType(Text)
      .flatMap((n) => [n.props.children].flat())
      .filter((c): c is string => typeof c === 'string');
    expect(labels).toContain('Confirm?');
    // And the unarmed rail beside it is still icon-only.
    expect(labels).not.toContain('Snooze');
  });

  test('human content scales unbounded; machine data is capped at 1.6x', () => {
    const item = bucketView(LIVE_BRIEF, 'now')[0];
    const tree = render(<NowBlock item={item} onPress={() => {}} />);
    const byText = (needle: string) =>
      tree.root.findAll((n) => [n.props.children].flat().includes(needle))[0];
    expect(byText(item.title)?.props.maxFontSizeMultiplier).toBeUndefined();
    expect(byText(item.why)?.props.maxFontSizeMultiplier).toBeUndefined();
    // The evidence quote is human content too.
    expect(byText(item.evidence[0])?.props.maxFontSizeMultiplier).toBeUndefined();
  });

  test('no row, head or undo line sets a fixed height', async () => {
    const tree = await renderScreen();
    // Scoped to the brief's OWN subtrees: the page behind them is the shell's
    // Ground wash, whose decorative rings are deliberately 620px circles.
    const subtrees = [
      ...rows(tree),
      ...tree.root.findAllByType(BucketHead),
      ...tree.root.findAllByType(UndoRow),
    ];
    expect(subtrees.length).toBeGreaterThan(44);
    const fixed = subtrees
      .flatMap((node) =>
        node
          .findAll((n) => n.props.style !== undefined && typeof n.props.style !== 'function')
          .flatMap((n) => [n.props.style].flat(Infinity)),
      )
      .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
      // A fixed height is what clips a row at AX5; minHeight is the only floor
      // any of these may set.
      .filter((s) => typeof s.height === 'number');
    expect(fixed).toEqual([]);
  });
});
