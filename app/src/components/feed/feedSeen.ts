// The Feed's "new" marker (Feed.tsx:24, 119, 123-126 / PARITY-INVENTORY
// FEED-02). AsyncStorage stands in for localStorage; the key and the value
// (the newest item's epoch-seconds ts, as a string) are the PWA's.
//
// The PWA reads the key SYNCHRONOUSLY in a useState initialiser, so the value
// it compares against is always the one from the previous visit. AsyncStorage
// has no synchronous read, so FeedScreen starts the read once on mount and
// holds the promise: until it settles, no card is "new" (rather than every
// card being new against a placeholder 0), and the write below is chained
// behind that same promise so a fast first payload can never overwrite the
// value the read is still on its way to fetch.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LAST_SEEN_KEY } from './feedModel';

/** `Number(localStorage.getItem(KEY) ?? 0)` (Feed.tsx:119), quirks included:
 * a missing key is 0 (everything is new), and an unparsable value is NaN —
 * against which every `item.ts > lastSeen` is false, so NOTHING is new. Both
 * are the PWA's behaviour and neither is "fixed" here. A rejected read (no
 * storage at all) is the missing-key case. */
export async function readFeedSeenTs(): Promise<number> {
  try {
    return Number((await AsyncStorage.getItem(LAST_SEEN_KEY)) ?? 0);
  } catch {
    return 0;
  }
}

/** Feed.tsx:123-126 — the newest item's ts, written on every data load. */
export async function writeFeedSeenTs(ts: number): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_SEEN_KEY, String(ts));
  } catch {
    // Same as the PWA: a storage failure costs the dot, never the screen.
  }
}
