// The lock store's guards. the user, 2026-09-28: "makes me do face id sometimes
// more than once", and "when i hit unlock chat it scans but doesnt unlock the
// page". Two gates are mounted and three things can call lock(); the store
// has to be the one place that reasons about it.
import { RELOCK_GRACE_MS, useChatLock } from './lock';

const mockUnlock = jest.fn();
const mockLogout = jest.fn();
const mockInvalidate = jest.fn();
const mockReconnect = jest.fn();

jest.mock('../lib/api', () => ({
  ApplyError: class ApplyError extends Error { code = ''; },
  GateNotWiredError: class GateNotWiredError extends Error { code = ''; },
  api: {
    chatUnlock: (...a: unknown[]) => mockUnlock(...a),
    chatLogout: (...a: unknown[]) => mockLogout(...a),
  },
}));
jest.mock('../lib/query', () => ({ queryClient: { invalidateQueries: (...a: unknown[]) => mockInvalidate(...a) } }));
jest.mock('./socket', () => ({ getChatSocket: () => ({ reconnect: (...a: unknown[]) => mockReconnect(...a) }) }));
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    setItem: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    getItem: jest.fn(async (k: string) => store.get(k) ?? null),
    removeItem: jest.fn(async (k: string) => void store.delete(k)),
  };
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLogout.mockResolvedValue(undefined);
  mockInvalidate.mockResolvedValue(undefined);
  useChatLock.setState({ unlocked: false, hydrated: true, busy: false, error: null, unlockedAt: 0 });
});

it('two gates asking at once produce one Face ID scan', async () => {
  const scan = deferred<boolean>();
  mockUnlock.mockReturnValue(scan.promise);
  const a = useChatLock.getState().unlock();
  const b = useChatLock.getState().unlock();
  scan.resolve(true);
  await Promise.all([a, b]);
  expect(mockUnlock).toHaveBeenCalledTimes(1);
  expect(useChatLock.getState().unlocked).toBe(true);
});

it('is unlocked before the refetches, and cycles the socket onto the new cookie', async () => {
  const order: string[] = [];
  mockUnlock.mockResolvedValue(true);
  mockInvalidate.mockImplementation(async () => {
    order.push(`invalidate:${useChatLock.getState().unlocked}`);
  });
  mockReconnect.mockImplementation(() => order.push(`reconnect:${useChatLock.getState().unlocked}`));
  await useChatLock.getState().unlock();
  expect(order[0]).toBe('reconnect:true');
  expect(order.slice(1)).toEqual(['invalidate:true', 'invalidate:true']);
});

it('ignores a relock that lands while the scan is still in flight', async () => {
  const scan = deferred<boolean>();
  mockUnlock.mockReturnValue(scan.promise);
  useChatLock.setState({ unlocked: true, unlockedAt: 0 });
  const unlocking = useChatLock.getState().unlock();
  await useChatLock.getState().lock(); // a stale 1008 from the old socket
  expect(mockLogout).not.toHaveBeenCalled();
  scan.resolve(true);
  await unlocking;
  expect(useChatLock.getState().unlocked).toBe(true);
});

it('ignores a relock within a beat of a successful unlock — that is an old request failing', async () => {
  mockUnlock.mockResolvedValue(true);
  await useChatLock.getState().unlock();
  await useChatLock.getState().lock();
  expect(useChatLock.getState().unlocked).toBe(true);
  expect(mockLogout).not.toHaveBeenCalled();
});

it('still locks for a real trigger after the grace has passed', async () => {
  mockUnlock.mockResolvedValue(true);
  await useChatLock.getState().unlock();
  useChatLock.setState({ unlockedAt: Date.now() - RELOCK_GRACE_MS - 1 });
  await useChatLock.getState().lock();
  expect(useChatLock.getState().unlocked).toBe(false);
  expect(mockLogout).toHaveBeenCalledTimes(1);
});

it('a second lock while already locked does not log out again', async () => {
  useChatLock.setState({ unlocked: false });
  await useChatLock.getState().lock();
  await useChatLock.getState().lock();
  expect(mockLogout).not.toHaveBeenCalled();
});
