// Layout regressions from the user's phone, 2026-09-22: the empty state rendered
// upside down, and the keyboard covered the newest messages because the
// composer translated over a full-height list instead of the column shrinking.
import TestRenderer, { act } from 'react-test-renderer';
import { FlatList, StyleSheet, Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useChatStore } from '../../chat/store';
import type { ChatMessage, Thread } from '../../chat/types';
import { ThreadStatusRing } from './parts/ThreadStatusRing';
import { ThreadMenuButton } from './ThreadMenu';
import { ThreadSurface } from './ThreadScreen';

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => ({ threadId: 't1' }),
  useIsFocused: () => true,
  useScrollToTop: () => {},
  useFocusEffect: (cb: () => undefined | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useEffect } = require('react');
    useEffect(cb, [cb]);
  },
}));
jest.mock('react-native-keyboard-controller', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { View } = require('react-native');
  return {
    KeyboardAvoidingView: View,
    useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: { value: 0 } }),
  };
});
const mockSession = jest.fn();
jest.mock('../../lib/api', () => ({
  api: {
    chatMarkRead: jest.fn().mockResolvedValue({}),
    session: (...args: unknown[]) => mockSession(...args),
  },
}));
jest.mock('../../chat/hooks', () => ({
  useThreadDetail: () => ({
    data: { thread: null, messages: [] },
    isError: false,
    isLoading: false,
    error: null,
    refetch: jest.fn(),
  }),
  useSendMessage: () => ({ send: jest.fn(), retry: jest.fn() }),
}));

// A run reads as working only while it is still moving, so fixtures are
// stamped now rather than at a fixed date (turnState.ts STALE_RUN_MS).
const NOW_ISO = new Date().toISOString();

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

let active: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => {
  act(() => active?.unmount());
  active = null;
});

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

function wrap(node: React.ReactNode) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </SafeAreaProvider>
  );
}

function render() {
  act(() => {
    active = TestRenderer.create(wrap(<ThreadSurface threadId="t1" />));
  });
  return active as TestRenderer.ReactTestRenderer;
}

const flatten = (style: unknown): Record<string, unknown> =>
  (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;

test('the transcript column shrinks with the keyboard rather than being slid over', () => {
  const tree = render();
  // The list and the composer share one avoiding column: with the composer
  // pinned by a translate instead, the newest messages sit under the keyboard.
  const column = tree.root.findByType(KeyboardAvoidingView);
  expect(flatten(column.props.style).flex).toBe(1);
  expect(column.findAllByType(FlatList)).toHaveLength(1);
});

test('the empty state is counter-flipped out of the inverted list', () => {
  const tree = render();
  const list = tree.root.findByType(FlatList);
  expect(list.props.inverted).toBe(true);
  // The element itself carries the counter-flip: `inverted` is a scaleY(-1) on
  // the list, and RN counter-flips its CELLS but not an empty component.
  const empty = list.props.ListEmptyComponent as React.ReactElement<{ style?: unknown }>;
  expect(empty).toBeTruthy();
  expect(flatten(empty.props.style).transform).toEqual([{ scaleY: -1 }]);
});

// --- batch 4: the header chrome (A20 / A21 / A23) ------------------------------
function hydrate(thread: Partial<Thread> = {}, messages: ChatMessage[] = []) {
  useChatStore.getState().hydrateSnapshot(
    {
      id: 't1',
      kind: 'chat',
      title: 'Fast sleeve',
      status: 'idle',
      pinned: false,
      archived: false,
      last_seq: messages.length,
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
      last_read_seq: messages.length,
      unread: 0,
      preview: null,
      preview_role: null,
      hermes_session_id: null,
      origin_thread_id: null,
      origin_message_id: null,
      ...thread,
    },
    messages,
  );
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    thread_id: 't1',
    seq: 1,
    version: 1,
    role: 'assistant',
    author_type: 'agent',
    run_id: 'run1',
    status: 'complete',
    client_msg_id: null,
    cron_run_id: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    parts: [{ type: 'text', text: 'hi' }],
    ...overrides,
  };
}

/** Polls under act() until `until` holds. A single macrotask is not enough for
 * the session query to resolve and re-render on a loaded machine — the same
 * fixed-tick assumption that money.test.tsx and query.test.ts already replaced
 * with a waitFor — and here it made the model-pill assertion fail only under
 * load. Defaults to one flush for callers with nothing to wait for. */
async function settle(until: () => boolean = () => true): Promise<void> {
  const deadline = Date.now() + 5000;
  do {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  } while (!until() && Date.now() < deadline);
  if (!until()) throw new Error('settle: condition not satisfied within 5000ms');
}

function headerTexts(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map((n) => String(n.props.children));
}

afterEach(() => {
  mockSession.mockReset();
  useChatStore.getState().reset();
});

test('the status ring reads the running state off the transcript', () => {
  hydrate({}, [message()]);
  expect(render().root.findByType(ThreadStatusRing).props.state).toBe('idle');
});

test('a streaming turn spins the ring', () => {
  hydrate({}, [message({ status: 'streaming' })]);
  expect(render().root.findByType(ThreadStatusRing).props.state).toBe('working');
});

test('a message hub-api could not hand on shows as undelivered, not as working', () => {
  hydrate({}, [message({ role: 'user', author_type: 'human', forward_status: 'pending' })]);
  expect(render().root.findByType(ThreadStatusRing).props.state).toBe('undelivered');
});

test('the model is shown only when the thread\'s own session carries one', async () => {
  mockSession.mockResolvedValue({ id: 'sess-1', model: 'claude-opus-4-6' });
  hydrate({ hermes_session_id: 'sess-1' }, [message()]);
  const tree = render();
  await settle(() => headerTexts(tree).some((t) => t.includes('opus-4-6')));
  expect(mockSession).toHaveBeenCalledWith('sess-1');
  expect(headerTexts(tree)).toContain('opus-4-6');
});

test('a session with no model draws no pill rather than a placeholder', async () => {
  mockSession.mockResolvedValue({ id: 'sess-1', model: null });
  hydrate({ hermes_session_id: 'sess-1' }, [message()]);
  const tree = render();
  await settle(() => mockSession.mock.calls.length > 0);
  expect(headerTexts(tree)).toEqual(expect.not.arrayContaining(['opus-4-6']));
});

test('a thread bound to no gateway session never asks for one', () => {
  hydrate({}, [message()]);
  render();
  expect(mockSession).not.toHaveBeenCalled();
});

test('the overflow opens on a loaded thread and is absent before one arrives', () => {
  expect(render().root.findAllByType(ThreadMenuButton)).toHaveLength(0);
  act(() => (active as TestRenderer.ReactTestRenderer).unmount());
  active = null;
  hydrate({}, [message()]);
  expect(render().root.findByType(ThreadMenuButton).props.thread.id).toBe('t1');
});

// --- agents still working, pinned (L108) ------------------------------------------
const workingAgent = (): ChatMessage =>
  message({
    id: 'a1',
    seq: 1,
    version: 1,
    parts: [
      {
        type: 'tool_call',
        tool_call_id: 'subagent:c1',
        tool_name: 'delegate_task',
        status: 'running',
        args: { role: 'leaf' },
        subagent: { child_session_id: 'c1', child_role: 'leaf', phase: 'start', tool_call_count: null },
      } as never,
    ],
  });

// `findAll` walks composite AND host fibers, so one element matches several
// times; the host node is the one that renders.
const hosts = (tree: TestRenderer.ReactTestRenderer, testID: string) =>
  tree.root.findAll((n) => typeof n.type === 'string' && n.props.testID === testID);

test('agents still working with newer rows below them get a pinned strip', () => {
  hydrate({}, [workingAgent(), message({ id: 'p1', seq: 2, version: 2, parts: [{ type: 'text', text: 'meanwhile…' }] })]);
  const tree = render();
  expect(hosts(tree, 'agents-strip')).toHaveLength(1);
  expect(hosts(tree, 'agents-block')).toHaveLength(1);
});

test('the strip stays away while the agents are the newest thing on screen', () => {
  hydrate({}, [workingAgent()]);
  const tree = render();
  expect(hosts(tree, 'agents-strip')).toHaveLength(0);
  expect(hosts(tree, 'agents-block')).toHaveLength(1);
});
