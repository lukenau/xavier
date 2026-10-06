// Chat lock state — a straight port of src/terminal/lock.ts for the chat
// cookie (chat/session.py's `hub_chat_session`, Path=/api/chat, distinct from
// and independent of the terminal's own `hub_term_session`). The session
// cookie is minted only by the real gated write path
// (`api.chatUnlock()`: POST /api/chat/challenge → assertion → POST
// /api/chat/session), so until the Face ID signer registers itself with
// api.ts the challenge still round-trips and the assertion step throws
// GateNotWiredError. Nothing here fakes a session; a failed mint stays locked.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { ApplyError, GateNotWiredError, api } from '../lib/api';
import { queryClient } from '../lib/query';
// Circular with socket.ts on purpose: each only reaches the other inside a
// function, never at module load.
import { getChatSocket } from './socket';

// A distinct key from the terminal's `hub-term-unlock-until` — the two
// cookies are minted, revoked and expire independently, so one stamp must
// never gate the other's socket. HUB_CHAT_SESSION_TTL_S defaults to the same
// 3600s as the terminal's own cookie (chat/session.py), so the same 55-minute
// margin applies for the same reason: a cold app launch can skip Face ID
// while the server cookie is still comfortably inside its hour.
export const UNLOCK_KEY = 'hub-chat-unlock-until';
export const UNLOCK_TTL_MS = 55 * 60_000;

export const NO_PASSKEY_MESSAGE = 'No passkey enrolled. Add one in Config → Security first.';

/** `Number(null)`/`Number('')` are 0 and `Number('nonsense')` is NaN, so a
 * missing or corrupt stamp compares false. */
export async function readUnlockStamp(now = Date.now()): Promise<boolean> {
  return Number(await AsyncStorage.getItem(UNLOCK_KEY)) > now;
}

export async function writeUnlockStamp(now = Date.now()): Promise<void> {
  await AsyncStorage.setItem(UNLOCK_KEY, String(now + UNLOCK_TTL_MS));
}

export async function clearUnlockStamp(): Promise<void> {
  await AsyncStorage.removeItem(UNLOCK_KEY);
}

/** Ported from terminal/lock.ts's `unlockErrorMessage`. `null` means "show no
 * banner" — a cancelled Face ID prompt is a choice, not an error. */
export function unlockErrorMessage(err: unknown): string | null {
  if (err instanceof ApplyError || err instanceof GateNotWiredError) {
    if (err.code === 'cancelled') return null;
    if (err.code === 'no_passkey') return NO_PASSKEY_MESSAGE;
  }
  return (err as Error).message;
}

interface ChatLockState {
  unlocked: boolean;
  hydrated: boolean;
  busy: boolean;
  error: string | null;
  /** Read the stamp once at mount; until then the screen must stay locked. */
  hydrate: () => Promise<void>;
  unlock: () => Promise<void>;
  /** Every re-lock trigger lands here: the padlock button, a WebSocket 1008
   * close (`wsClient.ts`'s `onLock`), and any 401 from a chat REST read. */
  lock: () => Promise<void>;
  /** When the last successful unlock landed; a relock trigger inside
   * RELOCK_GRACE_MS of it is a request that started under the old session. */
  unlockedAt: number;
}

export const RELOCK_GRACE_MS = 2000;

export const useChatLock = create<ChatLockState>((set, get) => ({
  unlocked: false,
  hydrated: false,
  busy: false,
  error: null,
  unlockedAt: 0,

  hydrate: async () => {
    set({ unlocked: await readUnlockStamp(), hydrated: true });
  },

  unlock: async () => {
    // Two gates are mounted (the thread list and the open thread) and both
    // auto-prompt; the second must ride the first's scan, not start another
    // (the user, 2026-09-28: "makes me do face id sometimes more than once").
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      const ok = await api.chatUnlock();
      if (!ok) {
        set({ unlocked: false, busy: false });
        return;
      }
      await writeUnlockStamp();
      // Unlocked FIRST. The refetches used to be awaited before this line,
      // so a stale 1008 from the old socket, or a 401 from a read that was
      // already in flight, called lock() in that window — which logged the
      // brand-new session out and left the screen locked after a successful
      // scan ("it scans but doesn't unlock the page").
      set({ unlocked: true, busy: false, unlockedAt: Date.now() });
      // The socket is still holding the dead cookie; cycle it onto the new one
      // rather than wait for it to discover the difference.
      getChatSocket().reconnect();
      void queryClient.invalidateQueries({ queryKey: ['chat-bootstrap'] });
      void queryClient.invalidateQueries({ queryKey: ['chat-thread'] });
    } catch (err) {
      set({ unlocked: false, busy: false, error: unlockErrorMessage(err) });
    }
  },

  lock: async () => {
    const { unlocked, busy, unlockedAt } = get();
    // Already locked, or an unlock is mid-scan: a second trigger has nothing
    // to add, and logging out here would revoke the session the scan just
    // minted. A trigger that arrives within a beat of an unlock is a request
    // that started under the OLD session and is only now failing.
    if (!unlocked || busy || Date.now() - unlockedAt < RELOCK_GRACE_MS) return;
    set({ unlocked: false, error: null });
    await clearUnlockStamp();
    // Best-effort: chat/session.py's logout revokes server-side regardless of
    // whether this call succeeds (unlike the terminal's own logout, which
    // only ever drops the browser cookie) — clearing the LOCAL stamp is what
    // actually re-locks this client either way.
    await api.chatLogout().catch(() => {});
  },
}));
