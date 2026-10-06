// The singleton's flush: frames fold in as one batch, and a batch that leaves
// a row stale — or carries the server's own "start over" — asks for the
// thread's snapshot, once.
import { REFETCH_DEBOUNCE_MS, getChatSocket, resetChatSocketForTests } from './socket';
import { useChatStore } from './store';

const mockInvalidate = jest.fn();
jest.mock('../lib/query', () => ({ queryClient: { invalidateQueries: (...a: unknown[]) => mockInvalidate(...a) } }));
jest.mock('./lock', () => ({ useChatLock: { getState: () => ({ lock: jest.fn() }) } }));

type Opts = { onFrame: (frame: unknown) => void; onStatus: (s: string) => void; onLock: (d: string) => void };
let opts: Opts | null = null;
jest.mock('./wsClient', () => ({
  ChatSocketClient: class {
    constructor(o: Opts) {
      opts = o;
    }
    attachAppState() {
      return () => {};
    }
    close() {}
    connect() {}
  },
}));

const opened = {
  type: 'message.upsert', seq: 1, thread_id: 't1', message_id: 'm1', role: 'assistant', author_type: 'agent',
  status: 'streaming', run_id: 'r1', parts: [{ type: 'text', text: 'Found the job.' }],
};
const delta = (seq: number, text: string, offset: number) => ({
  type: 'part.delta', seq, thread_id: 't1', message_id: 'm1', idx: 0, delta: text, offset, length: offset + text.length,
});

beforeEach(() => {
  jest.useFakeTimers();
  mockInvalidate.mockReset();
  resetChatSocketForTests();
  useChatStore.setState({ chat: { threads: {} } });
  getChatSocket();
});

afterEach(() => {
  resetChatSocketForTests();
  jest.useRealTimers();
});

it('folds a batch and asks for nothing when every delta fits', () => {
  opts!.onFrame(opened);
  opts!.onFrame(delta(2, ' Ok.', 14));
  jest.advanceTimersByTime(20);
  expect(useChatStore.getState().chat.threads.t1.messages[0].parts[0]).toEqual({ type: 'text', text: 'Found the job. Ok.' });
  expect(mockInvalidate).not.toHaveBeenCalled();
});

it('asks for the thread snapshot once when a delta does not fit', () => {
  opts!.onFrame(opened);
  opts!.onFrame(delta(2, ' Ok.', 99));
  jest.advanceTimersByTime(20);
  expect(mockInvalidate).toHaveBeenCalledTimes(1);
  // Never cancelling a snapshot already on its way: the heal must finish.
  expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ['chat-thread', 't1'] }, { cancelRefetch: false });

  // The row stays stale until the snapshot lands; the next batch does not ask again.
  opts!.onFrame(delta(3, '!', 103));
  jest.advanceTimersByTime(20);
  expect(mockInvalidate).toHaveBeenCalledTimes(1);

  jest.advanceTimersByTime(REFETCH_DEBOUNCE_MS);
  opts!.onFrame(delta(4, '!', 104));
  jest.advanceTimersByTime(20);
  expect(mockInvalidate).toHaveBeenCalledTimes(2);
});

it('asks for the snapshot when the server says the log cannot replay', () => {
  opts!.onFrame({ type: 'snapshot_required', seq: 50, thread_id: 't1' });
  jest.advanceTimersByTime(20);
  expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ['chat-thread', 't1'] }, { cancelRefetch: false });
});

// The stall (the user, 2026-10-01): "it renders parts of a message, pauses, then
// doesn't show the rest until I close and reopen the chat." The repair used to
// be asked for only for threads named in the batch just applied, so it needed
// MORE frames to arrive — which is exactly what a stalled stream stops doing.
it('keeps asking for the snapshot when the stream stalls and no frames follow', () => {
  opts!.onFrame(opened);
  opts!.onFrame(delta(2, ' Ok.', 99));
  jest.advanceTimersByTime(20);
  expect(mockInvalidate).toHaveBeenCalledTimes(1);

  // Not one frame more. The row must still be repaired.
  jest.advanceTimersByTime(REFETCH_DEBOUNCE_MS * 3);
  expect(mockInvalidate.mock.calls.length).toBeGreaterThan(1);
  expect(mockInvalidate).toHaveBeenLastCalledWith(
    { queryKey: ['chat-thread', 't1'] },
    { cancelRefetch: false },
  );
});

it('stops asking once nothing is stale, so a healthy thread has no timer running', () => {
  opts!.onFrame(opened);
  opts!.onFrame(delta(2, ' Ok.', 14));
  jest.advanceTimersByTime(20);
  jest.advanceTimersByTime(REFETCH_DEBOUNCE_MS * 3);
  expect(mockInvalidate).not.toHaveBeenCalled();
});
