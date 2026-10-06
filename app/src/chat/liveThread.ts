// Live's own conversation, remembered across sessions.
//
// The Live page is thread-scoped: a voice turn lands in a chat thread exactly
// as a typed one does (LiveScreen's transcript is the thread's own store). A
// hands-free page cannot ask which thread to use, and binding to whatever was
// last typed in would write a walk-around session into one of your real
// conversations, so Live owns ONE dedicated thread titled "Live", created on
// first open, pinned so it stays at the top of the Chat list, and remembered
// here so every later session accumulates in the same place. The server names
// it "Live · <first real line>" once something worth naming it after is said.
//
// The id lives in AsyncStorage under its own key, beside voices.ts's settings
// blob rather than in the app-wide store (src/lib/store.ts).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ApiError, api } from '../lib/api';

export const LIVE_THREAD_KEY = 'hub-live-thread';
/** The pinned thread every Live session accumulates in (LIVE_BARE_TITLE in
 * server/chat/routes.py). */
export const LIVE_THREAD_TITLE = 'Live';

/** The remembered id, or null when there is none / storage read failed. */
export async function readLiveThreadId(): Promise<string | null> {
  try {
    const value = await AsyncStorage.getItem(LIVE_THREAD_KEY);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

/** Remembered so the next open reuses it; a failed write costs one duplicate
 * thread on the next cold open, never the current session. */
export async function rememberLiveThreadId(threadId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(LIVE_THREAD_KEY, threadId);
  } catch {
    // Persistence failure only.
  }
}

/** Forget the remembered id: the thread was deleted (404) or a test needs a
 * clean slate. The next `resolveLiveThreadId` mints a fresh one. */
export async function forgetLiveThreadId(): Promise<void> {
  try {
    await AsyncStorage.removeItem(LIVE_THREAD_KEY);
  } catch {
    // Nothing to do: an unreadable store already reads as "no id".
  }
}

/** 404 = the thread is gone (deleted from the Chat list); anything else
 * (offline, 401, server down) must NOT be read as "missing", or a flaky
 * moment would mint a second "Live" thread and orphan the first. */
function isMissingThread(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * The Live thread's id, creating + pinning it once on first open.
 *
 * Throws whatever the create call threw; the route renders a `StatePanel`
 * with Retry.
 */
export async function resolveLiveThreadId(): Promise<string> {
  const known = await readLiveThreadId();
  if (known) {
    try {
      await api.chatThreadDetail(known, 0);
      return known;
    } catch (error) {
      if (!isMissingThread(error)) return known; // Transient: let the screen try.
      await forgetLiveThreadId();
    }
  }
  return createLiveThread();
}

/**
 * A FRESH Live thread: the "New session" button.
 *
 * The dedicated thread is a convenience, not a constraint: for a clean
 * transcript mid-conversation, this mints another "Live" thread, pins it, and
 * remembers it. The previous one is unpinned (best effort) so the pinned slot
 * keeps meaning "the session I am in"; it stays in the Chat list as its own
 * history, which is the point of starting a new one instead of editing.
 */
export async function createLiveThread(): Promise<string> {
  const previous = await readLiveThreadId();
  const { thread } = await api.chatCreateThread(LIVE_THREAD_TITLE);
  await rememberLiveThreadId(thread.id);
  try {
    await api.chatPatchThread(thread.id, { pinned: true });
  } catch {
    // Pinning is a convenience (Chat-list ordering); the page works without
    // it and the next resolve still finds the remembered id.
  }
  if (previous && previous !== thread.id) {
    try {
      await api.chatPatchThread(previous, { pinned: false });
    } catch {
      // The old thread keeps its pin: harmless (it still opens from the list).
    }
  }
  return thread.id;
}
