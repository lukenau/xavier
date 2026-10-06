// Entering and leaving the demo. The flag alone is not a switch: whatever the
// app is holding from the other side has to go too — the query cache, the chat
// store, the socket and its cursors, the chat unlock stamp, cached thread tails
// — or real data would show inside the demo, or fictional data after it.
//
// The server address the user saved is left alone: leaving the demo returns to
// it. Navigation is the caller's, since only the caller knows where it is.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { queryClient, OFFLINE_CACHE_KEY } from '../lib/query';
import { resetChatSocket } from '../chat/socket';
import { useChatStore } from '../chat/store';
import { clearUnlockStamp, useChatLock } from '../chat/lock';
import { LAST_SEEN_KEY } from '../components/feed/feedModel';
import { setDemoFlag, useDemoMode } from './mode';
import { isDemoThreadId, resetDemoWorld } from './server';

/** Keys the demo writes through the app's own code that would mislead the real
 * app afterwards: their real values are put aside on the way in and restored on
 * the way out. */
const STASHED_KEYS = [LAST_SEEN_KEY];
const STASH_KEY = 'hub.demo.stash';

async function forgetDemoTails(): Promise<void> {
  const keys = await AsyncStorage.getAllKeys();
  const tails = keys.filter((key) => key.startsWith('chat.tail.') && isDemoThreadId(key.slice('chat.tail.'.length)));
  if (tails.length > 0) await AsyncStorage.multiRemove(tails);
}

async function stash(): Promise<void> {
  const pairs = await AsyncStorage.multiGet(STASHED_KEYS);
  await AsyncStorage.setItem(STASH_KEY, JSON.stringify(Object.fromEntries(pairs)));
  await AsyncStorage.multiRemove(STASHED_KEYS);
}

async function unstash(): Promise<void> {
  const raw = await AsyncStorage.getItem(STASH_KEY);
  const saved = raw ? (JSON.parse(raw) as Record<string, string | null>) : {};
  for (const key of STASHED_KEYS) {
    const value = saved[key];
    if (typeof value === 'string') await AsyncStorage.setItem(key, value);
    else await AsyncStorage.removeItem(key);
  }
  await AsyncStorage.removeItem(STASH_KEY);
}

async function switchTo(active: boolean): Promise<void> {
  await queryClient.cancelQueries();
  resetChatSocket();
  useChatStore.getState().reset();
  resetDemoWorld();
  useChatLock.setState({ unlocked: false, busy: false, error: null, unlockedAt: 0 });
  await setDemoFlag(active);
  await clearUnlockStamp();
  if (active) await stash();
  else await Promise.all([forgetDemoTails(), unstash()]);
  // Every query starts over against the side now in effect. Inactive ones lose
  // their data too, so nothing from before can be shown or persisted again.
  await AsyncStorage.removeItem(OFFLINE_CACHE_KEY);
  void queryClient.resetQueries();
}

/** The demo needs no network, so its reads run with the phone offline too:
 * TanStack otherwise holds every query while NetInfo reports no connection.
 * Applied whenever the flag changes, including when a relaunch reads it. */
function applyNetworkMode(active: boolean): void {
  const defaults = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, networkMode: active ? 'always' : 'online' },
  });
  if (active) void queryClient.refetchQueries({ type: 'active' });
}

useDemoMode.subscribe((state, prev) => {
  if (state.active !== prev.active) applyNetworkMode(state.active);
});

export function enterDemo(): Promise<void> {
  return switchTo(true);
}

export function exitDemo(): Promise<void> {
  return switchTo(false);
}
