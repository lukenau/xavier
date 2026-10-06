// The cached tail: what opening a thread paints before the network answers.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CACHED_MESSAGES, forgetTail, loadTail, saveTail } from './cache';
import type { ChatMessage, Thread } from './types';

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItem: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    getItem: jest.fn(async (k: string) => store.get(k) ?? null),
    removeItem: jest.fn(async (k: string) => void store.delete(k)),
  };
});

const thread = (): Thread =>
  ({
    id: 'thr_1',
    kind: 'chat',
    title: 'CO Trip',
    status: 'idle',
    pinned: false,
    archived: false,
    last_seq: 3,
    created_at: '2026-09-24T00:00:00Z',
    updated_at: '2026-09-24T00:00:00Z',
    last_read_seq: 3,
    unread: 0,
    preview: null,
    preview_role: null,
    hermes_session_id: null,
    origin_thread_id: null,
    origin_message_id: null,
  }) as Thread;

const message = (seq: number): ChatMessage =>
  ({
    id: `m${seq}`,
    thread_id: 'thr_1',
    seq,
    role: 'assistant',
    author_type: 'agent',
    run_id: 'r1',
    status: 'complete',
    client_msg_id: null,
    cron_run_id: null,
    created_at: '2026-09-24T00:00:00Z',
    updated_at: '2026-09-24T00:00:00Z',
    parts: [{ type: 'text', text: `line ${seq}` }],
  }) as ChatMessage;

beforeEach(async () => {
  await forgetTail('thr_1');
  jest.clearAllMocks();
});

it('gives back what was put in', async () => {
  await saveTail(thread(), [message(1), message(2)]);
  const cached = await loadTail('thr_1');
  expect(cached?.thread.title).toBe('CO Trip');
  expect(cached?.messages.map((m) => m.seq)).toEqual([1, 2]);
});

it('keeps the NEWEST messages when a thread is long', async () => {
  const many = Array.from({ length: CACHED_MESSAGES + 25 }, (_, i) => message(i + 1));
  await saveTail(thread(), many);
  const cached = await loadTail('thr_1');
  expect(cached?.messages).toHaveLength(CACHED_MESSAGES);
  // The tail, because the tail is what a thread opens on.
  expect(cached?.messages.at(-1)?.seq).toBe(CACHED_MESSAGES + 25);
});

it('has nothing to say about a thread it has never seen', async () => {
  expect(await loadTail('thr_unknown')).toBeNull();
});

it('drops a cache it cannot read rather than throwing into the screen', async () => {
  (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('{not json');
  expect(await loadTail('thr_1')).toBeNull();
});

it('drops rows that are not shaped like messages', async () => {
  (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
    JSON.stringify({ thread: thread(), messages: [message(1), { id: 'junk' }, null] }),
  );
  const cached = await loadTail('thr_1');
  expect(cached?.messages.map((m) => m.id)).toEqual(['m1']);
});

it('gives a tail written before rows carried a version the lowest one', async () => {
  (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
    JSON.stringify({ thread: thread(), messages: [{ ...message(1), version: undefined }] }),
  );
  const cached = await loadTail('thr_1');
  expect(cached?.messages[0].version).toBe(0);
});

it('never fails a read or a write when storage itself is unavailable', async () => {
  (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
  await expect(saveTail(thread(), [message(1)])).resolves.toBeUndefined();
  (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('unavailable'));
  expect(await loadTail('thr_1')).toBeNull();
});
