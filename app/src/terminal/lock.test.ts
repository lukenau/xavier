import AsyncStorage from '@react-native-async-storage/async-storage';
import { ApiError, ApplyError, GateNotWiredError, api } from '../lib/api';
import {
  NO_PASSKEY_MESSAGE,
  UNLOCK_KEY,
  UNLOCK_TTL_MS,
  clearUnlockStamp,
  readUnlockStamp,
  unlockErrorMessage,
  useTerminalLock,
  writeUnlockStamp,
} from './lock';

const BASE = 'https://hub.example.com/api';

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(async () => {
  global.fetch = jest.fn();
  await AsyncStorage.clear();
  useTerminalLock.setState({ unlocked: false, hydrated: false, busy: false, error: null });
});

afterEach(() => {
  // restoreAllMocks (not resetAllMocks): the AsyncStorage module mock is itself
  // a set of jest.fn()s, and resetting those wipes the in-memory store's
  // implementations for every later test in the file.
  jest.restoreAllMocks();
});

/** The shipped AsyncStorage mock resolves a missing key to `undefined`; the
 * real module resolves `null`. Normalise so "absent" reads the same either way. */
async function stamp(): Promise<string | null> {
  return (await AsyncStorage.getItem(UNLOCK_KEY)) ?? null;
}

describe('unlock stamp (PWA parity: hub-term-unlock-until, 55 min)', () => {
  it('uses the PWA key and TTL', () => {
    expect(UNLOCK_KEY).toBe('hub-term-unlock-until');
    expect(UNLOCK_TTL_MS).toBe(55 * 60_000);
  });

  it('writes now + 55 minutes', async () => {
    await writeUnlockStamp(1_000_000);
    expect(await stamp()).toBe(String(1_000_000 + 3_300_000));
  });

  it('reads a future stamp as unlocked and a past one as locked', async () => {
    await writeUnlockStamp(1_000_000);
    expect(await readUnlockStamp(1_000_000)).toBe(true);
    expect(await readUnlockStamp(1_000_000 + UNLOCK_TTL_MS - 1)).toBe(true);
    expect(await readUnlockStamp(1_000_000 + UNLOCK_TTL_MS)).toBe(false);
    expect(await readUnlockStamp(1_000_000 + UNLOCK_TTL_MS + 1)).toBe(false);
  });

  it('treats a missing or corrupt stamp as locked', async () => {
    expect(await readUnlockStamp()).toBe(false);
    await AsyncStorage.setItem(UNLOCK_KEY, 'nonsense');
    expect(await readUnlockStamp()).toBe(false);
    await AsyncStorage.setItem(UNLOCK_KEY, '');
    expect(await readUnlockStamp()).toBe(false);
  });

  it('clearUnlockStamp removes it', async () => {
    await writeUnlockStamp();
    await clearUnlockStamp();
    expect(await stamp()).toBeNull();
  });

  it('hydrate() reflects the stamp and only then reports hydrated', async () => {
    expect(useTerminalLock.getState().hydrated).toBe(false);
    await useTerminalLock.getState().hydrate();
    expect(useTerminalLock.getState()).toMatchObject({ unlocked: false, hydrated: true });

    await writeUnlockStamp();
    await useTerminalLock.getState().hydrate();
    expect(useTerminalLock.getState().unlocked).toBe(true);
  });
});

describe('unlock() goes through the real gated write path', () => {
  it('POSTs the terminal challenge before the assertion seam throws, and stays locked', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonRes({ challenge: 'c', rp_id: 'r' }));

    await useTerminalLock.getState().unlock();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/terminal/challenge`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    // No session was minted, so nothing is unlocked and nothing is stamped.
    expect(useTerminalLock.getState()).toMatchObject({ unlocked: false, busy: false });
    expect(useTerminalLock.getState().error).toBe(new GateNotWiredError().message);
    expect(await stamp()).toBeNull();
  });

  it('never mints a session locally — POST /api/terminal/session is the only source', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonRes({ challenge: 'c' }));
    await useTerminalLock.getState().unlock();
    const paths = (global.fetch as jest.Mock).mock.calls.map((c) => c[0]);
    expect(paths).not.toContain(`${BASE}/terminal/session`);
    expect(useTerminalLock.getState().unlocked).toBe(false);
  });

  it('stamps and unlocks once the gate is wired and the session POST succeeds', async () => {
    jest.spyOn(api, 'terminalUnlock').mockResolvedValueOnce(true);
    await useTerminalLock.getState().unlock();
    expect(useTerminalLock.getState()).toMatchObject({ unlocked: true, busy: false, error: null });
    expect(Number(await stamp())).toBeGreaterThan(Date.now());
  });

  it('a mint that resolves false leaves the terminal locked and unstamped', async () => {
    jest.spyOn(api, 'terminalUnlock').mockResolvedValueOnce(false);
    await useTerminalLock.getState().unlock();
    expect(useTerminalLock.getState()).toMatchObject({ unlocked: false, busy: false, error: null });
    expect(await stamp()).toBeNull();
  });

  it('clears busy on both the success and the failure path', async () => {
    jest.spyOn(api, 'terminalUnlock').mockRejectedValueOnce(new ApplyError('bridge_error', 'nope'));
    await useTerminalLock.getState().unlock();
    expect(useTerminalLock.getState().busy).toBe(false);
    expect(useTerminalLock.getState().error).toBe('nope');
  });

  it('a 412 from the challenge surfaces as no_passkey guidance', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      jsonRes({ detail: { code: 'no_passkey', detail: 'No passkey registered.' } }, 412),
    );
    await useTerminalLock.getState().unlock();
    expect(useTerminalLock.getState().error).toBe(NO_PASSKEY_MESSAGE);
  });
});

describe('unlockErrorMessage (Terminal.tsx:16-36 parity)', () => {
  it('shows no banner for a cancelled prompt', () => {
    expect(unlockErrorMessage(new ApplyError('cancelled', 'User cancelled'))).toBeNull();
    expect(unlockErrorMessage(new GateNotWiredError('cancelled'))).toBeNull();
  });

  it('rewrites no_passkey into enrolment guidance', () => {
    expect(unlockErrorMessage(new ApplyError('no_passkey', 'No passkey registered.'))).toBe(
      NO_PASSKEY_MESSAGE,
    );
    expect(unlockErrorMessage(new GateNotWiredError('no_passkey'))).toBe(NO_PASSKEY_MESSAGE);
  });

  it('passes any other gate code through as its own message', () => {
    expect(unlockErrorMessage(new ApplyError('assertion_invalid', 'Passkey verification failed.'))).toBe(
      'Passkey verification failed.',
    );
  });

  it('passes a non-gate error through as its message', () => {
    expect(unlockErrorMessage(new ApiError(502, 'bridge down'))).toBe('bridge down');
    expect(unlockErrorMessage(new Error('Network request failed'))).toBe('Network request failed');
  });

  it('does not swallow a plain object that merely carries code="cancelled"', () => {
    expect(unlockErrorMessage({ code: 'cancelled', message: 'not a gate error' })).toBe(
      'not a gate error',
    );
  });
});

describe('lock()', () => {
  it('clears the stamp, drops the flag, and best-effort logs out', async () => {
    await writeUnlockStamp();
    useTerminalLock.setState({ unlocked: true, error: 'stale' });
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonRes({ ok: true }));

    await useTerminalLock.getState().lock();

    expect(useTerminalLock.getState()).toMatchObject({ unlocked: false, error: null });
    expect(await stamp()).toBeNull();
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/terminal/logout`, expect.anything());
  });

  it('still locks when the logout POST fails', async () => {
    await writeUnlockStamp();
    useTerminalLock.setState({ unlocked: true });
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('offline'));

    await expect(useTerminalLock.getState().lock()).resolves.toBeUndefined();

    expect(useTerminalLock.getState().unlocked).toBe(false);
    expect(await stamp()).toBeNull();
  });

  it('is what every re-lock trigger calls: repeated locks are idempotent', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonRes({ ok: true }));
    await useTerminalLock.getState().lock();
    await useTerminalLock.getState().lock();
    expect(useTerminalLock.getState().unlocked).toBe(false);
    expect(await stamp()).toBeNull();
  });
});
