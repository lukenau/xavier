// Terminal lock state. The session cookie is minted only by the real gated
// write path (`api.terminalUnlock()`: POST /api/terminal/challenge → assertion
// → POST /api/terminal/session), so until the Face ID signer registers itself
// with api.ts the challenge still round-trips and the assertion step throws
// GateNotWiredError. Nothing here fakes a session; a failed mint stays locked.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { ApplyError, GateNotWiredError, api } from '../lib/api';

// Same key and TTL as the PWA (apps/hub/src/store/index.ts). The server cookie
// lives 3600 s; a 55-minute stamp lets a cold app launch skip Face ID while
// that cookie is still valid, and a stale stamp just bounces off the
// 'session expired' path back to the lock screen. AsyncStorage rather than
// sessionStorage because NSHTTPCookieStorage also survives a relaunch — the
// stamp has to model the cookie's lifetime, not the process's.
export const UNLOCK_KEY = 'hub-term-unlock-until';
export const UNLOCK_TTL_MS = 55 * 60_000;

export const NO_PASSKEY_MESSAGE = 'No passkey enrolled. Add one in Config → Security first.';

/** `Number(null)`/`Number('')` are 0 and `Number('nonsense')` is NaN, so a
 * missing or corrupt stamp compares false — same coercion the PWA relies on. */
export async function readUnlockStamp(now = Date.now()): Promise<boolean> {
  return Number(await AsyncStorage.getItem(UNLOCK_KEY)) > now;
}

export async function writeUnlockStamp(now = Date.now()): Promise<void> {
  await AsyncStorage.setItem(UNLOCK_KEY, String(now + UNLOCK_TTL_MS));
}

export async function clearUnlockStamp(): Promise<void> {
  await AsyncStorage.removeItem(UNLOCK_KEY);
}

/** Ported from Terminal.tsx:16-36. `null` means "show no banner" — a cancelled
 * Face ID prompt is a choice, not an error. */
export function unlockErrorMessage(err: unknown): string | null {
  if (err instanceof ApplyError || err instanceof GateNotWiredError) {
    if (err.code === 'cancelled') return null;
    if (err.code === 'no_passkey') return NO_PASSKEY_MESSAGE;
  }
  return (err as Error).message;
}

interface TerminalLockState {
  unlocked: boolean;
  hydrated: boolean;
  busy: boolean;
  error: string | null;
  /** Read the stamp once at mount; until then the screen must stay locked. */
  hydrate: () => Promise<void>;
  unlock: () => Promise<void>;
  /** Every re-lock trigger lands here: the padlock button, a 1008 close, and a
   * 401 from /terminal/token. */
  lock: () => Promise<void>;
}

export const useTerminalLock = create<TerminalLockState>((set) => ({
  unlocked: false,
  hydrated: false,
  busy: false,
  error: null,

  hydrate: async () => {
    set({ unlocked: await readUnlockStamp(), hydrated: true });
  },

  unlock: async () => {
    set({ busy: true, error: null });
    try {
      const ok = await api.terminalUnlock();
      if (ok) await writeUnlockStamp();
      set({ unlocked: ok, busy: false });
    } catch (err) {
      set({ unlocked: false, busy: false, error: unlockErrorMessage(err) });
    }
  },

  lock: async () => {
    set({ unlocked: false, error: null });
    await clearUnlockStamp();
    // Best-effort: the cookie is Path=/terminal so the browser-shaped logout
    // POST under /api never carries it and the server-side token survives to
    // its TTL either way (inventory §1.4). Clearing the stamp is what locks us.
    await api.terminalLogout().catch(() => {});
  },
}));
