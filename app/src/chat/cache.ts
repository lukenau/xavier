// The last thing you saw, kept, so opening a thread paints before the network
// answers.
//
// the user, 2026-09-24: "takes a bit for the most recent ones to load". Nothing was
// stored between launches, so every cold open showed an empty column until the
// REST snapshot came back — and then mounted the whole transcript at once.
// Reading a cached tail first turns that into: the conversation is there, and
// anything newer arrives underneath it a moment later.
//
// The cache is a convenience, never a source of truth. It holds a tail rather
// than a thread, it is dropped silently when it cannot be read, and the
// snapshot that follows overwrites everything it touched.
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChatMessage, Thread } from './types';

/** Enough to fill a screen and scroll back a little; small enough to write on
 * every visit without thinking about it. */
export const CACHED_MESSAGES = 40;
const KEY = (threadId: string) => `chat.tail.${threadId}`;

export interface CachedThread {
  thread: Thread;
  messages: ChatMessage[];
}

export async function saveTail(thread: Thread, messages: ChatMessage[]): Promise<void> {
  try {
    const tail = messages.slice(-CACHED_MESSAGES);
    await AsyncStorage.setItem(KEY(thread.id), JSON.stringify({ thread, messages: tail }));
  } catch {
    // A cache that cannot be written is not an error worth telling anyone
    // about: the thread still loads from the server.
  }
}

export async function loadTail(threadId: string): Promise<CachedThread | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY(threadId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { thread, messages } = parsed as CachedThread;
    if (!thread || typeof thread.id !== 'string' || !Array.isArray(messages)) return null;
    // A cached row that is not shaped like a message would throw somewhere far
    // from here, so it is dropped here instead.
    const usable = messages
      .filter((m) => m && typeof m.id === 'string' && typeof m.seq === 'number' && Array.isArray(m.parts))
      // A tail written before rows carried a version is older than anything
      // the server will say about it.
      .map((m) => (typeof m.version === 'number' ? m : { ...m, version: 0 }));
    return { thread, messages: usable };
  } catch {
    return null;
  }
}

export async function forgetTail(threadId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY(threadId));
  } catch {
    // Same rule: nothing here is worth failing over.
  }
}
