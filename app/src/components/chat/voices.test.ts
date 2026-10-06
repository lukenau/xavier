import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_VOICE_SETTINGS } from '../../lib/live/settings';
import { FLUX_VOICES, VOICE_SETTINGS_KEY, findVoice, loadVoiceSettings, saveVoiceSettings } from './voices';

beforeEach(async () => {
  await AsyncStorage.clear();
});

test('round-trips the tts block', async () => {
  const s = { tts: { voice: 'flux-kit-en', speed: 1.15, expressivity: 1, enabled: false } };
  await saveVoiceSettings(s);
  expect(await loadVoiceSettings()).toEqual(s);
});

test('a saved voice outside the catalog falls back to the default Flux voice', async () => {
  await AsyncStorage.setItem(
    VOICE_SETTINGS_KEY,
    JSON.stringify({ stt: { model: 'nova-3' }, tts: { voice: 'aura-2-thalia-en', speed: 1.0, mode: 'short' }, auto_listen: true }),
  );
  const loaded = await loadVoiceSettings();
  expect(loaded.tts.voice).toBe(DEFAULT_VOICE_SETTINGS.tts.voice);
  expect(loaded).toEqual({ tts: { ...DEFAULT_VOICE_SETTINGS.tts } });
});

test('out-of-range or missing fields are the defaults', async () => {
  await AsyncStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify({ tts: { speed: 9, expressivity: 'x' } }));
  expect(await loadVoiceSettings()).toEqual(DEFAULT_VOICE_SETTINGS);
  await AsyncStorage.setItem(VOICE_SETTINGS_KEY, 'nope');
  expect(await loadVoiceSettings()).toEqual(DEFAULT_VOICE_SETTINGS);
});

test('the catalog is Flux only, without duplicates, and leads with the default', () => {
  const ids = FLUX_VOICES.map((v) => v.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.every((id) => /^flux-[a-z]+-en$/.test(id))).toBe(true);
  expect(ids[0]).toBe(DEFAULT_VOICE_SETTINGS.tts.voice);
  expect(findVoice(DEFAULT_VOICE_SETTINGS.tts.voice)?.name).toBe('Hannah');
  expect(findVoice('flux-unknown-en')).toBeNull();
});
