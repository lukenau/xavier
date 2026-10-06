// The Live thread's identity: created once, pinned, remembered — and never
// reborn because of a flaky read.
import { ApiError, api } from '../lib/api';
import {
  LIVE_THREAD_KEY,
  LIVE_THREAD_TITLE,
  createLiveThread,
  forgetLiveThreadId,
  readLiveThreadId,
  resolveLiveThreadId,
} from './liveThread';

jest.mock('../lib/api', () => {
  const actual = jest.requireActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    api: {
      chatCreateThread: jest.fn(),
      chatPatchThread: jest.fn(),
      chatThreadDetail: jest.fn(),
    },
  };
});

const mocked = api as unknown as {
  chatCreateThread: jest.Mock;
  chatPatchThread: jest.Mock;
  chatThreadDetail: jest.Mock;
};

const mockStorage = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (key: string) => Promise.resolve(mockStorage.get(key) ?? null),
  setItem: (key: string, value: string) => {
    mockStorage.set(key, value);
    return Promise.resolve();
  },
  removeItem: (key: string) => {
    mockStorage.delete(key);
    return Promise.resolve();
  },
}));

const thread = (id: string) => ({ id, title: LIVE_THREAD_TITLE, pinned: true }) as never;

beforeEach(() => {
  mockStorage.clear();
  mocked.chatCreateThread.mockReset().mockResolvedValue({ thread: thread('th-live-1') });
  mocked.chatPatchThread.mockReset().mockResolvedValue({ thread: thread('th-live-1') });
  mocked.chatThreadDetail.mockReset().mockResolvedValue({ thread: thread('th-live-1'), messages: [] });
});

test('first open creates one thread titled Live, pins it, and remembers the id', async () => {
  const id = await resolveLiveThreadId();
  expect(id).toBe('th-live-1');
  expect(mocked.chatCreateThread).toHaveBeenCalledWith(LIVE_THREAD_TITLE);
  expect(mocked.chatPatchThread).toHaveBeenCalledWith('th-live-1', { pinned: true });
  expect(await readLiveThreadId()).toBe('th-live-1');
});

test('the remembered thread is reused — no second create, and no re-pin', async () => {
  mockStorage.set(LIVE_THREAD_KEY, 'th-live-1');
  const id = await resolveLiveThreadId();
  expect(id).toBe('th-live-1');
  expect(mocked.chatCreateThread).not.toHaveBeenCalled();
  expect(mocked.chatPatchThread).not.toHaveBeenCalled();
});

test('a deleted Live thread (404) is forgotten and replaced, not reused', async () => {
  mockStorage.set(LIVE_THREAD_KEY, 'th-gone');
  mocked.chatThreadDetail.mockRejectedValueOnce(new ApiError(404, 'no such thread'));
  const id = await resolveLiveThreadId();
  expect(id).toBe('th-live-1');
  expect(mocked.chatCreateThread).toHaveBeenCalledTimes(1);
});

test('a transient read failure keeps the remembered id — no duplicate thread', async () => {
  mockStorage.set(LIVE_THREAD_KEY, 'th-live-1');
  mocked.chatThreadDetail.mockRejectedValueOnce(new ApiError(503, 'gateway down'));
  const id = await resolveLiveThreadId();
  expect(id).toBe('th-live-1');
  expect(mocked.chatCreateThread).not.toHaveBeenCalled();
});

test('a failed create surfaces to the caller (the route shows Retry)', async () => {
  mocked.chatCreateThread.mockRejectedValueOnce(new ApiError(500, 'create failed'));
  await expect(resolveLiveThreadId()).rejects.toThrow('create failed');
  expect(await readLiveThreadId()).toBeNull();
});

test('forgetLiveThreadId clears the remembered id', async () => {
  mockStorage.set(LIVE_THREAD_KEY, 'th-live-1');
  await forgetLiveThreadId();
  expect(await readLiveThreadId()).toBeNull();
});

test('createLiveThread mints a fresh pinned thread and remembers it', async () => {
  mockStorage.set(LIVE_THREAD_KEY, 'th-old');
  mocked.chatCreateThread.mockResolvedValue({ thread: thread('th-new') });
  const id = await createLiveThread();
  expect(id).toBe('th-new');
  expect(mocked.chatCreateThread).toHaveBeenCalledWith(LIVE_THREAD_TITLE);
  expect(mocked.chatPatchThread).toHaveBeenCalledWith('th-new', { pinned: true });
  // The session in progress owns the pinned slot; the old thread keeps its
  // history in the Chat list without a second pin.
  expect(mocked.chatPatchThread).toHaveBeenCalledWith('th-old', { pinned: false });
  expect(await readLiveThreadId()).toBe('th-new');
});

test('createLiveThread never touches the previous thread when there is none', async () => {
  const id = await createLiveThread();
  expect(id).toBe('th-live-1');
  expect(mocked.chatPatchThread).toHaveBeenCalledTimes(1);
});
