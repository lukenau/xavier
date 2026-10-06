// Adversarial review, 2026-09-22: Stop had no guard, no pending state and no
// outcome (a 404 and a 502 read the same), and a thread that failed to load
// told the user to unlock a chat that was already unlocked.
import TestRenderer, { act } from 'react-test-renderer';
import { Text, TextInput } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useChatStore } from '../../chat/store';
import type { ChatMessage } from '../../chat/types';
import { ThreadSurface } from './ThreadScreen';

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => ({ threadId: 't1' }),
  useIsFocused: () => true,
  useScrollToTop: () => {},
  useFocusEffect: (cb: () => undefined | (() => void)) => {
    const { useEffect } = require('react');
    useEffect(cb, [cb]);
  },
}));
jest.mock('react-native-keyboard-controller', () => {
  const { View } = require('react-native');
  return {
    KeyboardAvoidingView: View,
    useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: { value: 0 } }),
  };
});
const mockStop = jest.fn();
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ApiError: actual.ApiError,
    api: {
      chatMarkRead: jest.fn().mockResolvedValue({}),
      session: jest.fn(() => new Promise(() => {})),
      chatCommands: jest.fn(() => new Promise(() => {})),
      chatStopThread: (...args: unknown[]) => mockStop(...args),
    },
  };
});
const mockDetail = {
  data: null as unknown,
  isError: false,
  isLoading: false,
  error: null as Error | null,
  refetch: jest.fn(),
};
const mockSend = jest.fn();
jest.mock('../../chat/hooks', () => ({
  useThreadDetail: () => mockDetail,
  useSendMessage: () => ({ send: (...args: unknown[]) => mockSend(...args), retry: jest.fn() }),
}));

// eslint-disable-next-line import/first
import { ApiError } from '../../lib/api';

// A run reads as working only while it is still moving, so fixtures are
// stamped now rather than at a fixed date (turnState.ts STALE_RUN_MS).
const NOW_ISO = new Date().toISOString();

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

let active: TestRenderer.ReactTestRenderer | null = null;
let client: QueryClient;

function render() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    active = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <QueryClientProvider client={client}>
          <ThreadSurface threadId="t1" />
        </QueryClientProvider>
      </SafeAreaProvider>,
    );
  });
  return active!;
}

afterEach(() => {
  act(() => active?.unmount());
  active = null;
  client?.clear();
  mockStop.mockReset();
  mockSend.mockReset();
  Object.assign(mockDetail, { data: null, isError: false, isLoading: false, error: null, refetch: jest.fn() });
  useChatStore.getState().reset();
});

function streaming(): ChatMessage {
  return {
    id: 'm1',
    thread_id: 't1',
    seq: 1,
    version: 1,
    role: 'assistant',
    author_type: 'agent',
    run_id: 'run1',
    status: 'streaming',
    client_msg_id: null,
    cron_run_id: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    parts: [{ type: 'text', text: 'working' }],
  };
}

function hydrateRunning() {
  useChatStore.getState().hydrateSnapshot(
    {
      id: 't1',
      kind: 'chat',
      title: 'Fast sleeve',
      status: 'idle',
      pinned: false,
      archived: false,
      last_seq: 1,
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
      last_read_seq: 1,
      unread: 0,
      preview: null,
      preview_role: null,
      hermes_session_id: null,
      origin_thread_id: null,
      origin_message_id: null,
    },
    [streaming()],
  );
  mockDetail.data = { thread: null, messages: [] };
}

const stopButton = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll((n) => n.props.accessibilityLabel === 'Stop' && typeof n.props.onPress === 'function')[0];

function allText(r: TestRenderer.ReactTestRenderer): string {
  return r.root
    .findAllByType(Text)
    .flatMap((n) => [n.props.children].flat())
    .filter((c) => typeof c === 'string')
    .join(' | ');
}

describe('Stop', () => {
  test('two presses while the first is in flight send one stop', async () => {
    hydrateRunning();
    mockStop.mockImplementation(() => new Promise(() => {}));
    const r = render();
    const press = stopButton(r).props.onPress;
    act(() => {
      press();
      press();
    });
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  test('the button shows it is working and is disabled while in flight', () => {
    hydrateRunning();
    mockStop.mockImplementation(() => new Promise(() => {}));
    const r = render();
    act(() => stopButton(r).props.onPress());
    expect(stopButton(r).props.disabled).toBe(true);
    expect(allText(r)).toContain('Stopping…');
  });

  test('a delivered stop is confirmed rather than silent', async () => {
    hydrateRunning();
    mockStop.mockResolvedValue({ status: 'ok', thread_id: 't1' });
    const r = render();
    await act(async () => stopButton(r).props.onPress());
    expect(allText(r)).toMatch(/Stop sent/);
  });

  test('a 404 and a 502 say different things', async () => {
    hydrateRunning();
    mockStop.mockRejectedValueOnce(new ApiError(404, "no thread 't1'", 'not_found'));
    const r = render();
    await act(async () => stopButton(r).props.onPress());
    const notFound = allText(r);
    act(() => r.unmount());

    hydrateRunning();
    mockStop.mockRejectedValueOnce(new ApiError(502, 'the gateway did not answer', 'gateway_unreachable'));
    const r2 = render();
    await act(async () => stopButton(r2).props.onPress());
    const unreachable = allText(r2);

    expect(notFound).toMatch(/nothing to stop/i);
    expect(unreachable).toMatch(/couldn.t reach the agent/i);
  });
});

describe('composer while the thread is not loaded', () => {
  test('a failed load does not say the chat is locked', () => {
    Object.assign(mockDetail, { data: null, isError: true, isLoading: false, error: new Error('502') });
    const r = render();
    expect(r.root.findByType(TextInput).props.placeholder).not.toMatch(/lock/i);
  });

  test('a load in progress does not say the chat is locked', () => {
    Object.assign(mockDetail, { data: null, isError: false, isLoading: true, error: null });
    const r = render();
    expect(r.root.findByType(TextInput).props.placeholder).not.toMatch(/lock/i);
  });
});


describe('the composer mode reaches the send call', () => {
  // the user, 2026-09-22: "queue/steer/redirect aren't wired up btw" — the chips
  // moved the segmented control and nothing else; ThreadScreen dropped the
  // second argument on the floor.
  function type(r: TestRenderer.ReactTestRenderer, text: string) {
    const input = r.root.findAllByType(TextInput)[0];
    act(() => input.props.onChangeText(text));
  }

  function tapMode(r: TestRenderer.ReactTestRenderer, label: string) {
    const chip = r.root.findAll(
      (n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function',
    ).find((n) => {
      const texts = n.findAllByType(Text).flatMap((t) => [t.props.children].flat());
      return texts.includes(label);
    })!;
    act(() => chip.props.onPress());
  }

  function send(r: TestRenderer.ReactTestRenderer) {
    const btn = r.root.findAll((n) => n.props.accessibilityLabel === 'Send')[0];
    act(() => btn.props.onPress());
  }

  it('sends the chosen mode while a turn is running', () => {
    hydrateRunning();
    const r = render();
    tapMode(r, 'Redirect');
    type(r, 'actually do the other thing');
    send(r);
    expect(mockSend).toHaveBeenCalledWith('actually do the other thing', 'redirect', []);
  });

  it('sends no mode when nothing is running — there is nothing to queue behind', () => {
    hydrateRunning();
    // A status move is a new version on the server; an equal version is the
    // same row, and the snapshot would leave the streaming one in place.
    const done = { ...streaming(), status: 'complete' as const, version: 2 };
    useChatStore.getState().hydrateSnapshot(useChatStore.getState().chat.threads.t1!.thread, [done]);
    const r = render();
    tapMode(r, 'Queue');
    type(r, 'hello');
    send(r);
    expect(mockSend).toHaveBeenCalledWith('hello', undefined, []);
  });
});
