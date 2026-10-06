// Live settings tests: the BODY's controls (Flux voice, speed, expressivity,
// voice replies) render from the defaults, and every change hands the caller
// the next whole settings object. The container is a native route sheet
// (app/(home)/live-settings.tsx) over the shared store
// (src/chat/voiceSettings.ts), so the store's persistence contract is pinned
// here too: update → hub-live-voice, hydrate → the saved blob.
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { VoiceSettingsBody, SPEED_STEPS, EXPRESSIVITY_STEPS } from './LiveSettingsSheet';
import { DEFAULT_VOICE_SETTINGS } from '../../lib/live/settings';
import { FLUX_VOICES, loadVoiceSettings, saveVoiceSettings } from './voices';
import { useVoiceSettings } from '../../chat/voiceSettings';
import type { VoiceSettings } from '../../lib/live/settings';

const mockStorage = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (key: string) => Promise.resolve(mockStorage.get(key) ?? null),
  setItem: (key: string, value: string) => {
    mockStorage.set(key, value);
    return Promise.resolve();
  },
  removeItem: (key: string) => {
    mockStorage.delete(key);
    return Promise.resolve();
  },
}));

let changes: VoiceSettings[] = [];
const samples: string[] = [];
function render(settings: VoiceSettings = DEFAULT_VOICE_SETTINGS, withSamples = true) {
  return TestRenderer.create(
    <VoiceSettingsBody
      settings={settings}
      onChange={(next) => changes.push(next)}
      onSample={withSamples ? (id) => samples.push(id) : undefined}
    />,
  );
}

beforeEach(() => {
  changes = [];
  useVoiceSettings.setState({ settings: DEFAULT_VOICE_SETTINGS, hydrated: false, hydrating: false });
});

test('renders only the controls Live honours', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = render();
  });
  const text = renderer.root.findAllByType(Text).map((t) => String(t.props.children ?? '')).join(' | ');
  expect(text).toContain('VOICE — Hannah');
  expect(FLUX_VOICES[0].id).toBe(DEFAULT_VOICE_SETTINGS.tts.voice);
  expect(FLUX_VOICES.every((v) => v.id.startsWith('flux-'))).toBe(true);
  expect(SPEED_STEPS).toContain(0.75);
  expect(EXPRESSIVITY_STEPS).toContain(2);
  for (const label of ['Sample Hannah', 'Voice replies']) {
    expect(renderer.root.findByProps({ accessibilityLabel: label })).toBeTruthy();
  }
  expect(text).toContain('SPEED');
  expect(text).toContain('EXPRESSIVITY');
  for (const gone of ['STT MODEL', 'LANGUAGE', 'VERBOSITY', 'Aura-2']) expect(text).not.toContain(gone);
  expect(renderer.root.findAllByProps({ accessibilityLabel: 'Auto-listen' })).toHaveLength(0);
  renderer.unmount();
});

test('picking a voice and toggling a switch emits whole merged settings objects', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = render();
  });
  act(() => renderer.root.findByProps({ accessibilityLabel: 'Voice Kit' }).props.onPress());
  expect(changes[0].tts.voice).toBe('flux-kit-en');
  expect(changes[0].tts.speed).toBe(DEFAULT_VOICE_SETTINGS.tts.speed); // untouched fields survive
  const after = changes[0];
  renderer.unmount();

  changes = [];
  act(() => {
    renderer = render(after);
  });
  act(() => renderer.root.findByProps({ accessibilityLabel: 'Voice replies' }).props.onValueChange(false));
  expect(changes[0].tts.enabled).toBe(false);
  expect(changes[0].tts.voice).toBe('flux-kit-en');
  renderer.unmount();
});

test('sample buttons fire with the voice id', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = render();
  });
  act(() => renderer.root.findByProps({ accessibilityLabel: 'Sample Kit' }).props.onPress());
  expect(samples).toContain('flux-kit-en');
  renderer.unmount();
});

test('without a sample player there is no sample button, not a dead one', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = render(DEFAULT_VOICE_SETTINGS, false);
  });
  expect(renderer.root.findAllByProps({ accessibilityLabel: 'Sample Kit' })).toHaveLength(0);
  expect(renderer.root.findByProps({ accessibilityLabel: 'Voice Kit' })).toBeTruthy();
  renderer.unmount();
});

test('settings persist under hub-live-voice and load back; garbage in storage is the defaults', async () => {
  await saveVoiceSettings({ ...DEFAULT_VOICE_SETTINGS, tts: { ...DEFAULT_VOICE_SETTINGS.tts, voice: 'flux-miles-en', speed: 1.15 } });
  expect(JSON.parse(mockStorage.get('hub-live-voice') ?? '{}').tts.voice).toBe('flux-miles-en');
  const loaded = await loadVoiceSettings();
  expect(loaded.tts.voice).toBe('flux-miles-en');
  expect(loaded.tts.speed).toBe(1.15);

  mockStorage.set('hub-live-voice', '{not json');
  const fallback = await loadVoiceSettings();
  expect(fallback).toEqual(DEFAULT_VOICE_SETTINGS);
});

test('the shared store writes through on update and hydrates the saved blob', async () => {
  await act(async () => {
    await useVoiceSettings.getState().hydrate();
  });
  act(() => {
    useVoiceSettings.getState().update({
      ...DEFAULT_VOICE_SETTINGS,
      tts: { ...DEFAULT_VOICE_SETTINGS.tts, voice: 'flux-miles-en' },
    });
  });
  // update() persists the whole object (voices.ts)…
  expect(JSON.parse(mockStorage.get('hub-live-voice') ?? '{}').tts.voice).toBe('flux-miles-en');
  // …and a fresh store state reads it back: one source of truth across the
  // Live screen and the sheet route.
  useVoiceSettings.setState({ settings: DEFAULT_VOICE_SETTINGS, hydrated: false, hydrating: false });
  await act(async () => {
    await useVoiceSettings.getState().hydrate();
  });
  expect(useVoiceSettings.getState().settings.tts.voice).toBe('flux-miles-en');
});
