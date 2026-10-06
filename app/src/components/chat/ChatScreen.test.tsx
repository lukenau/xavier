// Regression: the Chat tab hit "Maximum update depth exceeded" on the phone the
// first time it rendered real threads (2026-09-22). zustand 5 selects through
// useSyncExternalStore, which re-renders forever when a selector returns a
// fresh array/Set on every call — exactly what selectThreadList and
// selectNeedsYouThreadIds did. This mounts the real screen against the real
// store with two live-shaped threads; the loop throws here as it did there.
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { useChatStore } from '../../chat/store';
import type { Thread } from '../../chat/types';
import ChatScreen from './ChatScreen';
import { ThreadRow } from './ThreadRow';

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useIsFocused: () => true,
  useScrollToTop: () => {},
  useFocusEffect: (cb: () => undefined | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useEffect } = require('react');
    useEffect(cb, [cb]);
  },
}));
jest.mock('./ChatLockGate', () => ({
  ChatLockGate: ({ children }: { children: React.ReactNode }) => children,
}));
const mockQuery = {
  data: { threads: [] as Thread[] },
  isLoading: false,
  isFetching: false,
  isError: false,
  error: null,
  refetch: jest.fn(),
};
jest.mock('../../chat/hooks', () => ({
  useChatBootstrap: () => mockQuery,
}));
const mockCreate = jest.fn();
jest.mock('../../lib/api', () => ({
  api: { chatCreateThread: (...args: unknown[]) => mockCreate(...args), vitals: jest.fn() },
}));
// The agent-status line polls the same ['vitals'] key Home does; the list's own
// query is mocked above, so this stands in for the shared one.
let mockVitals: unknown;
jest.mock('../../lib/query', () => ({
  QUERY_TUNING: { vitals: {} },
  usePoll: () => ({ data: mockVitals }),
}));

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

function thread(id: string, kind: Thread['kind'], updated_at: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id, kind, title: null, status: 'idle', pinned: false, archived: false, last_seq: 2,
    created_at: updated_at, updated_at, last_read_seq: 0, unread: 2,
    preview: null, preview_role: null, hermes_session_id: null,
    origin_thread_id: null, origin_message_id: null, ...overrides,
  } as Thread;
}

let active: TestRenderer.ReactTestRenderer | null = null;
beforeEach(() => {
  mockVitals = { agent: { name: 'Xavier', status: 'up', busy: false } };
});
afterEach(() => {
  act(() => active?.unmount());
  active = null;
  useChatStore.getState().reset();
});

test('renders live-shaped threads without a render loop', () => {
  const ops = thread('ops', 'ops', '2026-09-22T01:00:18Z');
  const cron = thread('cron', 'cron', '2026-09-22T00:00:14Z');
  mockQuery.data = { threads: [ops, cron] };
  const store = useChatStore.getState();
  store.hydrateSnapshot(ops, []);
  store.hydrateSnapshot(cron, []);
  store.applyFrame({
    type: 'attention.upsert', seq: 3, thread_id: 'ops', attention_id: 'att_1', kind: 'approval',
    request_id: 'r1', run_id: 'run1', summary: 'terminal: ls', message_id: null,
  } as never);

  act(() => {
    active = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ChatScreen />
      </SafeAreaProvider>,
    );
  });
  const rows = (active as TestRenderer.ReactTestRenderer).root.findAllByType(ThreadRow);
  expect(rows.map((r) => r.props.thread.id)).toEqual(['ops', 'cron']);
  expect(rows.map((r) => r.props.needsYou)).toEqual([true, false]);
});

test('an empty store renders the empty state, also without looping', () => {
  mockQuery.data = { threads: [] };
  act(() => {
    active = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ChatScreen />
      </SafeAreaProvider>,
    );
  });
  expect((active as TestRenderer.ReactTestRenderer).root.findAllByType(ThreadRow)).toHaveLength(0);
});

test('New starts a thread server-side and opens it', async () => {
  // The prototype's header chip. Without it nothing in the app can create a
  // thread at all — every other row is opened by a gateway delivery.
  const { router } = jest.requireMock('expo-router') as { router: { push: jest.Mock } };
  router.push.mockClear();
  mockCreate.mockResolvedValue({ thread: { id: 'thr_abc123', kind: 'chat' } });
  mockQuery.data = { threads: [] };
  act(() => {
    active = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ChatScreen />
      </SafeAreaProvider>,
    );
  });
  const tree = active as TestRenderer.ReactTestRenderer;
  const button = tree.root.findAll(
    (n) => n.props?.accessibilityLabel === 'New chat' && typeof n.props?.onPress === 'function',
  )[0];
  await act(async () => button.props.onPress());
  expect(mockCreate).toHaveBeenCalled();
  expect(mockQuery.refetch).toHaveBeenCalled();
  expect(router.push).toHaveBeenCalledWith({ pathname: '/chat/thread', params: { threadId: 'thr_abc123' } });
});

// --- batch 4: the list says what is happening ---------------------------------
function mount() {
  act(() => {
    active = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ChatScreen />
      </SafeAreaProvider>,
    );
  });
  return active as TestRenderer.ReactTestRenderer;
}

function rowFor(tree: TestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAllByType(ThreadRow).find((r) => r.props.thread.id === id);
}

test('an archived thread leaves the list without being deleted', () => {
  const ops = thread('ops', 'ops', '2026-09-22T01:00:18Z');
  const old = thread('old', 'chat', '2026-09-21T00:00:00Z', { archived: true });
  mockQuery.data = { threads: [ops, old] };
  const store = useChatStore.getState();
  store.hydrateSnapshot(ops, []);
  store.hydrateSnapshot(old, []);
  const tree = mount();
  expect(tree.root.findAllByType(ThreadRow).map((r) => r.props.thread.id)).toEqual(['ops']);
  // Still in the store — unarchiving is a patch away, the transcript is untouched.
  expect(useChatStore.getState().chat.threads.old).toBeDefined();
});

test('the open attention summary is what a waiting row previews', () => {
  const ops = thread('ops', 'ops', '2026-09-22T01:00:18Z', { preview: 'ran the backup', preview_role: 'assistant' });
  mockQuery.data = { threads: [ops] };
  const store = useChatStore.getState();
  store.hydrateSnapshot(ops, []);
  store.applyFrame({
    type: 'attention.upsert', seq: 3, thread_id: 'ops', attention_id: 'att_1', kind: 'approval',
    request_id: 'r1', run_id: 'run1', summary: 'terminal: ls', message_id: null,
  } as never);
  expect(rowFor(mount(), 'ops')?.props.attentionSummary).toBe('terminal: ls');
});

test('a quiet row falls back to the last message hub-api sent', () => {
  const chat = thread('thr_1', 'chat', '2026-09-22T01:00:18Z', { preview: 'ran the backup', preview_role: 'assistant' });
  mockQuery.data = { threads: [chat] };
  useChatStore.getState().hydrateSnapshot(chat, []);
  const row = rowFor(mount(), 'thr_1');
  expect(row?.props.attentionSummary).toBeNull();
  expect(row?.props.thread.preview).toBe('ran the backup');
});

test('provenance is named from the origin thread this client already holds', () => {
  const brief = thread('brief', 'brief', '2026-09-22T00:00:00Z');
  const spun = thread('thr_2', 'chat', '2026-09-22T01:00:00Z', { origin_thread_id: 'brief' });
  mockQuery.data = { threads: [brief, spun] };
  const store = useChatStore.getState();
  store.hydrateSnapshot(brief, []);
  store.hydrateSnapshot(spun, []);
  const tree = mount();
  expect(rowFor(tree, 'thr_2')?.props.originLabel).toBe('Brief');
  expect(rowFor(tree, 'brief')?.props.originLabel).toBeNull();
});

test('an origin this client has never seen still earns a pill, unnamed', () => {
  const spun = thread('thr_3', 'chat', '2026-09-22T01:00:00Z', { origin_thread_id: 'thr_gone' });
  mockQuery.data = { threads: [spun] };
  useChatStore.getState().hydrateSnapshot(spun, []);
  expect(rowFor(mount(), 'thr_3')?.props.originLabel).toBe('linked');
});

test('the agent-status line reports the gateway, not a guess', () => {
  mockQuery.data = { threads: [] };
  mockVitals = { agent: { name: 'Xavier', status: 'down', busy: false } };
  const shown = mount()
    .root.findAllByType(Text)
    .map((n) => String(n.props.children));
  expect(shown).toContain('Xavier is unreachable · connecting to chat…');
});
