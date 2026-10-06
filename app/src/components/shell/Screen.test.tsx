// The sticky header is one structural fact — the header is NOT a descendant
// of the ScrollView — and one arithmetic one: the safe-area clearance moves
// from the scrolling column onto the header, so the first card sits where it
// always did. Both are what a "restore PWA parity" edit would quietly undo.
import TestRenderer, { act } from 'react-test-renderer';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { Screen, SCREEN_TOP_PAD } from './Screen';

// Screen now also arms the tab-re-press scroll. The hook itself is expo-router's
// (vendored react-navigation); what is ours, and so what is asserted below, is
// that Screen hands it a ref that really tracks the ScrollView.
const mockScrollToTopRefs: { current: unknown }[] = [];
jest.mock('expo-router', () => ({
  useIsFocused: () => true,
  useScrollToTop: (ref: { current: unknown }) => {
    mockScrollToTopRefs.push(ref);
  },
}));

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

let active: TestRenderer.ReactTestRenderer | null = null;

function render(element: React.ReactElement) {
  act(() => {
    active = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>{element}</SafeAreaProvider>,
    );
  });
  return active as TestRenderer.ReactTestRenderer;
}

afterEach(() => {
  act(() => active?.unmount());
  active = null;
});

/** The `paddingTop` the style array ends up applying. */
const topPadOf = (style: object | object[]) =>
  [style].flat().reduce<number | undefined>(
    (found, s) => (s && 'paddingTop' in s ? (s as { paddingTop: number }).paddingTop : found),
    undefined,
  );

test('the header is a sibling of the ScrollView, not a child of it', () => {
  const r = render(
    <Screen header={<Text testID="head">Ops</Text>}>
      <Text testID="body">rows</Text>
    </Screen>,
  );
  const scroll = r.root.findByType(ScrollView);
  expect(scroll.findAllByProps({ testID: 'body' }).length).toBeGreaterThan(0);
  expect(scroll.findAllByProps({ testID: 'head' })).toHaveLength(0);
  expect(r.root.findAllByProps({ testID: 'head' }).length).toBeGreaterThan(0);
});

test('the top clearance moves to the header, so content keeps its position', () => {
  const r = render(
    <Screen header={<Text testID="head">Ops</Text>}>
      <Text>rows</Text>
    </Screen>,
  );
  expect(topPadOf(r.root.findByType(ScrollView).props.contentContainerStyle)).toBe(0);
  const bar = r.root.findByProps({ testID: 'head' }).parent as TestRenderer.ReactTestInstance;
  expect(topPadOf(bar.props.style)).toBe(METRICS.insets.top + SCREEN_TOP_PAD);
});

test('without a header the column keeps the clearance itself', () => {
  const r = render(
    <Screen>
      <Text>rows</Text>
    </Screen>,
  );
  expect(topPadOf(r.root.findByType(ScrollView).props.contentContainerStyle)).toBe(
    METRICS.insets.top + SCREEN_TOP_PAD,
  );
});

test('scroll={false} still renders its content, without a ScrollView', () => {
  const r = render(
    <Screen scroll={false} testID="static">
      <Text testID="body">terminal</Text>
    </Screen>,
  );
  expect(r.root.findAllByType(ScrollView)).toHaveLength(0);
  const content = r.root.findAllByProps({ testID: 'static' }).filter((n) => n.type === View);
  expect(content).toHaveLength(1);
  expect(content[0].findAllByProps({ testID: 'body' }).length).toBeGreaterThan(0);
});

test('the wash is behind the content and takes no touches', () => {
  const r = render(
    <Screen>
      <Text>rows</Text>
    </Screen>,
  );
  const ground = r.root.findByProps({ testID: 'ground' });
  expect(ground.props.pointerEvents).toBe('none');
  // Behind, not over: it is outside the scroller entirely, so nothing it
  // paints can scroll away or sit on top of a card.
  expect(r.root.findByType(ScrollView).findAllByProps({ testID: 'ground' })).toHaveLength(0);
});

// --- tab re-press scrolls to top -------------------------------------------

test('the ref handed to useScrollToTop tracks a really scrollable ScrollView', () => {
  mockScrollToTopRefs.length = 0;
  render(
    <Screen>
      <Text>body</Text>
    </Screen>,
  );
  expect(mockScrollToTopRefs).toHaveLength(1);
  const target = mockScrollToTopRefs[0].current as { scrollTo?: unknown } | null;
  // A forever-null ref, or one pointing at something without scrollTo, means the
  // second tab tap silently does nothing — which is exactly the bug to catch.
  expect(target).not.toBeNull();
  expect(typeof target?.scrollTo).toBe('function');
});

test("a caller's own scrollRef still receives the same node", () => {
  mockScrollToTopRefs.length = 0;
  const callerRef = { current: null } as { current: unknown };
  render(
    <Screen scrollRef={callerRef as never}>
      <Text>body</Text>
    </Screen>,
  );
  // Screen fans one callback ref out to both; dropping the caller's half would
  // break any screen that drives its own scrolling.
  expect(callerRef.current).not.toBeNull();
  expect(callerRef.current).toBe(mockScrollToTopRefs[0].current);
});

test('sticky heads and the scroll-start callback reach the ScrollView', () => {
  // The brief's bucket heads stick as they reach the top, and a drag disarms
  // every armed row. Both are ScrollView props, and Screen owns the only
  // ScrollView — without these pass-throughs the screen cannot have either.
  const onScrollBeginDrag = jest.fn();
  const tree = render(
    <Screen stickyHeaderIndices={[0, 3]} onScrollBeginDrag={onScrollBeginDrag}>
      <Text>a</Text>
    </Screen>,
  );
  const scroll = tree.root.findByType(ScrollView);
  expect(scroll.props.stickyHeaderIndices).toEqual([0, 3]);
  scroll.props.onScrollBeginDrag();
  expect(onScrollBeginDrag).toHaveBeenCalled();
});

test('a screen that passes neither leaves both undefined rather than defaulting', () => {
  const scroll = render(
    <Screen>
      <Text>a</Text>
    </Screen>,
  ).root.findByType(ScrollView);
  expect(scroll.props.stickyHeaderIndices).toBeUndefined();
  expect(scroll.props.onScrollBeginDrag).toBeUndefined();
});

// --- tab re-press scrolls to top -------------------------------------------

test('the ref handed to useScrollToTop tracks a really scrollable ScrollView', () => {
  mockScrollToTopRefs.length = 0;
  render(
    <Screen>
      <Text>body</Text>
    </Screen>,
  );
  expect(mockScrollToTopRefs).toHaveLength(1);
  const target = mockScrollToTopRefs[0].current as { scrollTo?: unknown } | null;
  // A forever-null ref, or one pointing at something without scrollTo, means the
  // second tab tap silently does nothing — which is exactly the bug to catch.
  expect(target).not.toBeNull();
  expect(typeof target?.scrollTo).toBe('function');
});

describe('H5: pull-to-refresh', () => {
  test('with no onRefresh, the ScrollView gets no refreshControl at all', () => {
    const scroll = render(
      <Screen>
        <Text>a</Text>
      </Screen>,
    ).root.findByType(ScrollView);
    expect(scroll.props.refreshControl).toBeUndefined();
  });

  test('onRefresh wires RN RefreshControl, tracking refreshing', () => {
    const onRefresh = jest.fn();
    const scroll = render(
      <Screen refreshing onRefresh={onRefresh}>
        <Text>a</Text>
      </Screen>,
    ).root.findByType(ScrollView);
    expect(scroll.props.refreshControl).toBeTruthy();
    expect(scroll.props.refreshControl.props.refreshing).toBe(true);
    scroll.props.refreshControl.props.onRefresh();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

test("a caller's own scrollRef still receives the same node", () => {
  mockScrollToTopRefs.length = 0;
  const callerRef = { current: null } as { current: unknown };
  render(
    <Screen scrollRef={callerRef as never}>
      <Text>body</Text>
    </Screen>,
  );
  // Screen fans one callback ref out to both; dropping the caller's half would
  // break any screen that drives its own scrolling.
  expect(callerRef.current).not.toBeNull();
  expect(callerRef.current).toBe(mockScrollToTopRefs[0].current);
});
