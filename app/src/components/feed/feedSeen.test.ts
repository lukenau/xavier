import AsyncStorage from '@react-native-async-storage/async-storage';
import { LAST_SEEN_KEY } from './feedModel';
import { readFeedSeenTs, writeFeedSeenTs } from './feedSeen';

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.restoreAllMocks();
});

test('the key is the PWA\'s, so a device that ran both agrees on what is new', () => {
  expect(LAST_SEEN_KEY).toBe('hub-feed-seen-ts');
});

test('a missing key reads 0 — everything is new on a first visit', async () => {
  await expect(readFeedSeenTs()).resolves.toBe(0);
});

test('a stored value round-trips as a number', async () => {
  await writeFeedSeenTs(1_757_000_000);
  await expect(readFeedSeenTs()).resolves.toBe(1_757_000_000);
});

test('an unparsable stored value reads NaN, against which NOTHING is new — the PWA\'s Number() quirk, reproduced', async () => {
  await AsyncStorage.setItem(LAST_SEEN_KEY, 'corrupt');
  const lastSeen = await readFeedSeenTs();
  expect(Number.isNaN(lastSeen)).toBe(true);
  expect(1_757_000_000 > lastSeen).toBe(false);
});

test('a storage failure costs the dot, never the screen', async () => {
  jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('no storage'));
  await expect(readFeedSeenTs()).resolves.toBe(0);
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('no storage'));
  await expect(writeFeedSeenTs(1)).resolves.toBeUndefined();
});
