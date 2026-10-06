// The voice catalog for the Live settings picker, plus the
// `hub-live-voice` persistence the sheet writes and the screen reads.
//
// The catalog is Deepgram's featured Flux TTS voices, in the order Deepgram's
// voice list gives them (developers.deepgram.com, Flux TTS voices). Live
// streams through /v2/speak, which only takes flux-* models, so it is Flux
// only. IDs are model strings exactly as the server passes them to Deepgram;
// the first is the default (lib/live/settings.ts).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '../../lib/live/settings';

export const VOICE_SETTINGS_KEY = 'hub-live-voice';

export interface VoiceEntry {
  /** Deepgram model string, e.g. `flux-hannah-en`. */
  id: string;
  name: string;
  accent: string;
  gender: 'female' | 'male';
}

export const FLUX_VOICES: VoiceEntry[] = [
  { id: 'flux-hannah-en', name: 'Hannah', accent: 'American', gender: 'female' },
  { id: 'flux-kit-en', name: 'Kit', accent: 'British', gender: 'male' },
  { id: 'flux-alexis-en', name: 'Alexis', accent: 'American', gender: 'female' },
  { id: 'flux-cliff-en', name: 'Cliff', accent: 'American', gender: 'male' },
  { id: 'flux-sienna-en', name: 'Sienna', accent: 'American', gender: 'female' },
  { id: 'flux-cole-en', name: 'Cole', accent: 'American', gender: 'male' },
  { id: 'flux-brooke-en', name: 'Brooke', accent: 'American', gender: 'female' },
  { id: 'flux-colin-en', name: 'Colin', accent: 'British', gender: 'male' },
  { id: 'flux-gemma-en', name: 'Gemma', accent: 'British', gender: 'female' },
  { id: 'flux-haley-en', name: 'Haley', accent: 'American', gender: 'female' },
  { id: 'flux-heather-en', name: 'Heather', accent: 'American', gender: 'female' },
  { id: 'flux-miles-en', name: 'Miles', accent: 'American', gender: 'male' },
  { id: 'flux-sean-en', name: 'Sean', accent: 'British', gender: 'male' },
];

export function findVoice(id: string): VoiceEntry | null {
  return FLUX_VOICES.find((v) => v.id === id) ?? null;
}

/** Reading storage is always fallible: a missing or malformed blob is the
 * defaults, never a broken Live screen. Shape-checked field by field so an
 * older payload (or one from a future version with extra keys) merges into
 * the defaults instead of leaking `undefined` into the hello frame. */
export async function loadVoiceSettings(): Promise<VoiceSettings> {
  try {
    const raw = await AsyncStorage.getItem(VOICE_SETTINGS_KEY);
    if (!raw) return DEFAULT_VOICE_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_VOICE_SETTINGS;
    const tts = (parsed as { tts?: { voice?: unknown; speed?: unknown; expressivity?: unknown; enabled?: unknown } }).tts;
    const d = DEFAULT_VOICE_SETTINGS.tts;
    return {
      tts: {
        // A voice outside the catalog (a non-Flux model, or one since dropped)
        // cannot be trusted to stream on /v2/speak.
        voice: typeof tts?.voice === 'string' && findVoice(tts.voice) ? tts.voice : d.voice,
        speed: typeof tts?.speed === 'number' && tts.speed >= 0.75 && tts.speed <= 1.25 ? tts.speed : d.speed,
        expressivity:
          typeof tts?.expressivity === 'number' && tts.expressivity >= -2 && tts.expressivity <= 2
            ? tts.expressivity
            : d.expressivity,
        enabled: typeof tts?.enabled === 'boolean' ? tts.enabled : d.enabled,
      },
    };
  } catch {
    return DEFAULT_VOICE_SETTINGS;
  }
}

export async function saveVoiceSettings(settings: VoiceSettings): Promise<void> {
  try {
    await AsyncStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage failure costs persistence, never the session.
  }
}
