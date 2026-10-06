// H6: one row's swipe must not re-render its siblings. Isolated in its own
// file because it needs BriefRow itself wrapped in a call-counting jest.fn —
// a top-level jest.mock that the rest of the brief's tests don't want.
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
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => {}),
  selectionAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));
jest.mock('../briefs', () => ({ openBrief: jest.fn(), resolveBriefUri: jest.fn() }));
jest.mock('./BriefRow', () => {
  const actual = jest.requireActual('./BriefRow');
  return { ...actual, BriefRow: jest.fn(actual.BriefRow) };
});

import TestRenderer, { act } from 'react-test-renderer';
import { GestureDetector } from 'react-native-gesture-handler';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import BriefScreen from './BriefScreen';
import { BriefRow } from './BriefRow';
import { BucketHead } from './BucketHead';
import { bucketView } from './briefModel';
import { LIVE_BRIEF } from './liveBrief.fixture';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};
const renderSpy = BriefRow as unknown as jest.Mock;

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let clients: QueryClient[] = [];
let mounted: TestRenderer.ReactTestRenderer[] = [];

async function render() {
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
  // H7: the rail isn't mounted until its row's gesture begins — reveal every
  // row's rail right after mount so a direct Done tap still works. This does
  // NOT re-render BriefRow: SwipeRow's own `revealed` state change re-renders
  // only SwipeRow, whose `children` prop (the already-built BriefRow element)
  // is passed through unchanged, so the baseline call count below stays 1.
  act(() => {
    for (const gd of tree.root.findAllByType(GestureDetector)) {
      (gd.props.gesture as { handlers: { onBegin?: () => void } }).handlers.onBegin?.();
    }
  });
  return tree;
}

function button(tree: TestRenderer.ReactTestRenderer, label: string, index = 0) {
  const found = tree.root.findAll(
    (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  );
  expect(found.length).toBeGreaterThan(index);
  return found[index];
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

test('swiping one row does not re-render any other row', async () => {
  const tree = await render();
  const today = bucketView(LIVE_BRIEF, 'today');
  const swiped = today[0];
  const untouched = today[1];

  const callsFor = (itemId: string) =>
    renderSpy.mock.calls.filter(([props]) => props.item.item_id === itemId).length;

  expect(callsFor(swiped.item_id)).toBe(1);
  expect(callsFor(untouched.item_id)).toBe(1);

  // The Now bucket's own rails (NowBlock, not BriefRow) come first in DOM
  // order; the Today items follow, in the same order as bucketView(...,'today').
  const nowCount = bucketView(LIVE_BRIEF, 'now').length;
  act(() => button(tree, 'Done', nowCount).props.onPress());

  expect(callsFor(swiped.item_id)).toBeGreaterThan(1);
  expect(callsFor(untouched.item_id)).toBe(1);
});
