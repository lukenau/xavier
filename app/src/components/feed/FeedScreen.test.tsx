// Wiring-level tests for the Feed screen. These render the real component —
// the class of bug that matters here is "the guard exists but its caller never
// calls it" (task-19-report.md's security round), which a pure-function test
// of resolveBriefUri/filterItems could never catch.
//
// expo-router's focus hooks need a navigation container; "always focused" is
// the only semantics these tests care about.
jest.mock('expo-router', () => ({
  // Screen arms the tab-re-press scroll with it; behaviour is asserted in Screen.test.tsx.
  useScrollToTop: () => {},
  useFocusEffect: (callback: () => undefined | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useEffect } = require('react');
    useEffect(callback, [callback]);
  },
  useIsFocused: () => true,
}));

// react-native-webview reaches for a native module at import time, which does
// not exist under jest. Nothing here asserts on WebView behaviour — only on
// which URI reaches openBrief.
jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: React.forwardRef((props: object, _ref: unknown) => React.createElement(View, props)),
  };
});

// resolveBriefUri stays REAL (it is the thing under test); only the navigation
// side effect is captured.
jest.mock('../briefs', () => ({
  ...jest.requireActual('../briefs'),
  openBrief: jest.fn(),
}));

jest.mock('../../lib/query', () => ({
  ...jest.requireActual('../../lib/query'),
  usePoll: jest.fn(),
}));

import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { openBrief } from '../briefs';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import { StatePanel } from '../shell';
import type { FeedItem, FeedResponse } from '../../lib/types';
import { FeedCard } from './FeedCard';
import { FeedDetailSheet } from './FeedDetailSheet';
import FeedScreen from './FeedScreen';
import { LAST_SEEN_KEY } from './feedModel';
import AsyncStorage from '@react-native-async-storage/async-storage';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

const HOST = 'https://hub.example.com';

function item(over: Partial<FeedItem> & { id: string; kind: FeedItem['kind'] }): FeedItem {
  return { ts: 1_757_000_000, title: over.id, ...over };
}

function feedState(items: FeedItem[], over: Record<string, unknown> = {}) {
  const data: FeedResponse = { items, status_line: null, updated_at: '' };
  return {
    data,
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    dataUpdatedAt: Date.now(),
    refetch: jest.fn(),
    ...over,
  };
}

/** The Pressable element instance carrying this label. `findAllByType(Pressable)`
 * finds nothing under RN 0.86 (Pressable is a memo/forwardRef wrapper), and the
 * host View it renders carries the label but not `onPress`, so the pair is what
 * identifies it. */
function pressable(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const found = renderer.root.findAll(
    (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  );
  expect(found).toHaveLength(1);
  return found[0];
}

// The header's refresh spinner is an Animated.loop (shell/motion.ts:62). A tree
// left mounted keeps it running past the file: this suite HANGS on its own, and
// force-exits a worker inside a full run.
const mounted: TestRenderer.ReactTestRenderer[] = [];

function track(renderer: TestRenderer.ReactTestRenderer) {
  mounted.push(renderer);
  return renderer;
}

async function render() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <FeedScreen />
      </SafeAreaProvider>,
    );
  });
  return track(renderer);
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
});

afterEach(() => {
  act(() => {
    mounted.splice(0).forEach((r) => r.unmount());
  });
});

test('the query is the PWA call site verbatim: key ["feed"], QUERY_TUNING.feed', async () => {
  (usePoll as jest.Mock).mockReturnValue(feedState([]));
  await render();
  expect(usePoll).toHaveBeenCalledWith(['feed'], expect.any(Function), QUERY_TUNING.feed);
});

describe('opening a card', () => {
  test('a brief link is resolved before it can reach the reader — openBrief gets the ABSOLUTE hub URL, never the raw param', async () => {
    const brief = item({ id: 'brief-x', kind: 'brief', link: '/my-pages/briefing-2026-09-11/' });
    (usePoll as jest.Mock).mockReturnValue(feedState([brief]));
    const renderer = await render();

    act(() => renderer.root.findByType(FeedCard).props.onOpen(brief));

    expect(openBrief).toHaveBeenCalledWith(`${HOST}/my-pages/briefing-2026-09-11/`, 'brief-x');
    expect(renderer.root.findByType(FeedDetailSheet).props.item).toBeNull();
  });

  test('an off-host brief link never reaches the reader; it falls through to the text sheet', async () => {
    const brief = item({
      id: 'brief-evil',
      kind: 'brief',
      link: 'https://attacker.example/login',
      summary: 'bait',
    });
    (usePoll as jest.Mock).mockReturnValue(feedState([brief]));
    const renderer = await render();

    act(() => renderer.root.findByType(FeedCard).props.onOpen(brief));

    expect(openBrief).not.toHaveBeenCalled();
    expect(renderer.root.findByType(FeedDetailSheet).props.item).toBe(brief);
  });

  test('a javascript: brief link never reaches the reader either', async () => {
    const brief = item({ id: 'brief-js', kind: 'brief', link: 'javascript:alert(1)' });
    (usePoll as jest.Mock).mockReturnValue(feedState([brief]));
    const renderer = await render();

    act(() => renderer.root.findByType(FeedCard).props.onOpen(brief));

    expect(openBrief).not.toHaveBeenCalled();
  });

  test('a non-brief card opens the text sheet, never the brief reader', async () => {
    const run = item({ id: 'run-1', kind: 'run', status: 'ok', summary: 'output' });
    (usePoll as jest.Mock).mockReturnValue(feedState([run]));
    const renderer = await render();

    act(() => renderer.root.findByType(FeedCard).props.onOpen(run));

    expect(openBrief).not.toHaveBeenCalled();
    expect(renderer.root.findByType(FeedDetailSheet).props.item).toBe(run);
  });
});

describe('filter chips', () => {
  const items = [
    item({ id: 'b', kind: 'brief', link: '/my-pages/b/' }),
    item({ id: 'r', kind: 'run', summary: 'log' }),
    item({ id: 's', kind: 'status' }),
  ];

  test('tapping Runs shows only runs; report/status kinds are reachable only under All', async () => {
    (usePoll as jest.Mock).mockReturnValue(feedState(items));
    const renderer = await render();
    expect(renderer.root.findAllByType(FeedCard).map((c) => c.props.item.id)).toEqual(['b', 'r', 's']);

    act(() => pressable(renderer, 'Runs').props.onPress());

    expect(renderer.root.findAllByType(FeedCard).map((c) => c.props.item.id)).toEqual(['r']);
  });

  test('an empty filter shows the literal-pluralised copy, not the "Nothing yet" one', async () => {
    (usePoll as jest.Mock).mockReturnValue(feedState([item({ id: 'r', kind: 'run', summary: 'l' })]));
    const renderer = await render();

    act(() => pressable(renderer, 'Alerts').props.onPress());

    expect(renderer.root.findByType(StatePanel).props.title).toBe('No alerts');
  });
});

describe('the "new" dot', () => {
  test('only items newer than the stored last-seen ts carry it', async () => {
    await AsyncStorage.setItem(LAST_SEEN_KEY, '1_757_000_000'.replace(/_/g, ''));
    (usePoll as jest.Mock).mockReturnValue(
      feedState([
        item({ id: 'newer', kind: 'report', ts: 1_757_000_050 }),
        item({ id: 'same', kind: 'report', ts: 1_757_000_000 }),
        item({ id: 'older', kind: 'report', ts: 1_756_000_000 }),
      ]),
    );
    const renderer = await render();

    const dots = Object.fromEntries(
      renderer.root.findAllByType(FeedCard).map((c) => [c.props.item.id, c.props.isNew]),
    );
    expect(dots).toEqual({ newer: true, same: false, older: false });
  });

  test('last-seen is read ONCE per mount: an item arriving during the mount keeps its dot even though the newest ts was already written back', async () => {
    await AsyncStorage.setItem(LAST_SEEN_KEY, '1757000000');
    const first = item({ id: 'first', kind: 'report', ts: 1_757_000_000 });
    (usePoll as jest.Mock).mockReturnValue(feedState([first]));
    const renderer = await render();
    expect(renderer.root.findByType(FeedCard).props.isNew).toBe(false);

    // The poll brings something newer. The PWA writes the new top ts to
    // storage but never re-reads it, so the card shows its dot for the rest of
    // this mount (PARITY-INVENTORY OQ-16 — reproduced, not "fixed").
    const arrived = item({ id: 'arrived', kind: 'report', ts: 1_757_009_999 });
    (usePoll as jest.Mock).mockReturnValue(feedState([arrived, first]));
    await act(async () => {
      renderer.update(
        <SafeAreaProvider initialMetrics={METRICS}>
          <FeedScreen />
        </SafeAreaProvider>,
      );
    });

    const dots = Object.fromEntries(
      renderer.root.findAllByType(FeedCard).map((c) => [c.props.item.id, c.props.isNew]),
    );
    expect(dots).toEqual({ arrived: true, first: false });
    await expect(AsyncStorage.getItem(LAST_SEEN_KEY)).resolves.toBe('1757009999');
  });

  test('the write is chained behind the read, so a payload that lands first cannot blind the dot', async () => {
    await AsyncStorage.setItem(LAST_SEEN_KEY, '1757000000');
    (usePoll as jest.Mock).mockReturnValue(
      feedState([item({ id: 'newer', kind: 'report', ts: 1_757_000_050 })]),
    );
    const renderer = await render();
    expect(renderer.root.findByType(FeedCard).props.isNew).toBe(true);
  });
});

describe('page states', () => {
  test('loading with no data shows the skeleton, not an empty panel', async () => {
    (usePoll as jest.Mock).mockReturnValue({
      ...feedState([]),
      data: undefined,
      isLoading: true,
    });
    const renderer = await render();
    expect(renderer.root.findAllByType(StatePanel)).toHaveLength(0);
  });

  test('an error surfaces the ApiError message verbatim', async () => {
    (usePoll as jest.Mock).mockReturnValue({
      ...feedState([]),
      data: undefined,
      isError: true,
      error: new Error('GET /feed → 503'),
    });
    const renderer = await render();
    const panel = renderer.root.findByType(StatePanel);
    expect(panel.props.title).toBe('Feed unavailable');
    expect(panel.props.detail).toBe('GET /feed → 503');
  });

  test('the status line renders "xavier" + text only when the server sends one', async () => {
    (usePoll as jest.Mock).mockReturnValue(feedState([]));
    let renderer = await render();
    expect(renderer.root.findAllByType(Text).some((n) => n.props.children === 'xavier')).toBe(false);

    (usePoll as jest.Mock).mockReturnValue(
      feedState([], {
        data: {
          items: [],
          status_line: { text: 'mac is asleep', ts: 1_757_000_000 },
          updated_at: '',
        },
      }),
    );
    renderer = await render();
    expect(renderer.root.findAllByType(Text).some((n) => n.props.children === 'xavier')).toBe(true);
    expect(
      renderer.root.findAllByType(Text).some((n) => n.props.children === 'mac is asleep'),
    ).toBe(true);
  });
});

describe('FeedCard openability', () => {
  function renderCard(card: FeedItem) {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <SafeAreaProvider initialMetrics={METRICS}>
          <FeedCard item={card} isNew={false} onOpen={jest.fn()} />
        </SafeAreaProvider>,
      );
    });
    return track(renderer);
  }

  test('a card with nothing to open is disabled', () => {
    const renderer = renderCard(item({ id: 'r', kind: 'report' }));
    expect(pressable(renderer, 'r').props.disabled).toBe(true);
  });

  test('a run with output is not', () => {
    const renderer = renderCard(item({ id: 'r', kind: 'run', summary: 'log' }));
    expect(pressable(renderer, 'r').props.disabled).toBe(false);
  });
});
