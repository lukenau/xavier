import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clampFontSize,
  DEFAULT_FONT_SIZE,
  FONT_KEY,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  readFontSize,
  writeFontSize,
} from './fontSize';

beforeEach(async () => {
  await AsyncStorage.clear();
});

test('uses the PWA key, default and bounds', () => {
  expect(FONT_KEY).toBe('hub-term-font');
  expect(DEFAULT_FONT_SIZE).toBe(13);
  expect(MIN_FONT_SIZE).toBe(10);
  expect(MAX_FONT_SIZE).toBe(20);
});

test('clamps to 10-20', () => {
  expect(clampFontSize(9)).toBe(10);
  expect(clampFontSize(21)).toBe(20);
  expect(clampFontSize(13)).toBe(13);
});

test('a missing or corrupt stamp reads as the default', () => {
  // `Number(null) || 13` and `Number('huge') || 13` — the PWA's own coercion.
  return readFontSize()
    .then((size) => expect(size).toBe(13))
    .then(() => AsyncStorage.setItem(FONT_KEY, 'huge'))
    .then(() => readFontSize())
    .then((size) => expect(size).toBe(13));
});

test('a stored size survives a relaunch, clamped', async () => {
  await writeFontSize(17);
  expect(await readFontSize()).toBe(17);

  await AsyncStorage.setItem(FONT_KEY, '99');
  expect(await readFontSize()).toBe(MAX_FONT_SIZE);
});
