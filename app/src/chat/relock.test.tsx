// The two ways back to Face ID, both of which were missing when the user hit
// "Chat unavailable — chat locked" with no button on it (2026-09-22):
// a 401 from a chat read must re-lock, and a locked gate must prompt itself.
import TestRenderer, { act } from 'react-test-renderer';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { ApiError } from '../lib/api';
import { ChatLockGate } from '../components/chat/ChatLockGate';
import { useChatBootstrap } from './hooks';
import { useChatLock } from './lock';

let mockQuery: { data?: unknown; error?: unknown; isLoading: boolean } = { isLoading: false };
jest.mock('../lib/query', () => ({ usePoll: () => mockQuery }));
jest.mock('expo-router', () => ({ useIsFocused: () => true, useScrollToTop: () => {} }));

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

let active: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => {
  act(() => active?.unmount());
  active = null;
});

function Probe() {
  useChatBootstrap();
  return null;
}

test('a 401 from a chat read re-locks, so the gate can offer Face ID again', () => {
  const lock = jest.fn();
  useChatLock.setState({ lock });
  mockQuery = { error: new ApiError(401, 'chat locked — unlock with Face ID', 'chat_locked'), isLoading: false };
  act(() => {
    active = TestRenderer.create(<Probe />);
  });
  expect(lock).toHaveBeenCalledTimes(1);
});

test('any other error is left alone — only a dead session re-locks', () => {
  const lock = jest.fn();
  useChatLock.setState({ lock });
  mockQuery = { error: new ApiError(503, 'hub-api down'), isLoading: false };
  act(() => {
    active = TestRenderer.create(<Probe />);
  });
  expect(lock).not.toHaveBeenCalled();
});

test('a locked gate prompts Face ID itself, once, and not again after a cancel', () => {
  const unlock = jest.fn();
  useChatLock.setState({ hydrate: jest.fn(), hydrated: true, unlocked: false, busy: false, error: null, unlock });
  act(() => {
    active = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ChatLockGate>{null}</ChatLockGate>
      </SafeAreaProvider>,
    );
  });
  expect(unlock).toHaveBeenCalledTimes(1);
  // Cancelled: the store reports an error and the button stays — no re-prompt.
  act(() => useChatLock.setState({ error: 'cancelled' }));
  expect(unlock).toHaveBeenCalledTimes(1);
});

test('an unlocked gate never prompts', () => {
  const unlock = jest.fn();
  useChatLock.setState({ hydrate: jest.fn(), hydrated: true, unlocked: true, busy: false, error: null, unlock });
  act(() => {
    active = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ChatLockGate>{null}</ChatLockGate>
      </SafeAreaProvider>,
    );
  });
  expect(unlock).not.toHaveBeenCalled();
});
