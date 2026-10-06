// What a Live session can be configured with: exactly the `tts` block the
// /api/live `hello` frame carries. Persisted by components/chat/voices.ts.
import type { LiveTts } from './protocol';

export interface VoiceSettings {
  tts: LiveTts;
}

/** The voice is the first of Deepgram's featured Flux voices; the server falls
 * back to the same one (DEFAULT_VOICE in server/live_deepgram.py). */
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  tts: { voice: 'flux-hannah-en', speed: 1.0, expressivity: 0, enabled: true },
};
