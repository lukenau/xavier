// Which audio engine Live runs on.
//
// 'native': modules/live-audio, Apple voice processing (echo cancellation) on
// one AVAudioEngine, built the way Apple's sample builds it. You can talk over
// Xavier: speech that starts during his reply ducks it, and real words cut it.
// 'library': react-native-audio-api, unpatched: no echo cancellation, so the
// server ignores speech that starts while Xavier talks (it would be his own
// voice coming back through the mic).
//
// The switch ships over the air: if the native engine misbehaves on a phone,
// an update flips this to 'library' without a new build. A build without the
// native module falls back to 'library' on its own.
import { LiveAudio, type LiveAudioNative } from '../../../modules/live-audio';

export const LIVE_AUDIO_ENGINE: 'native' | 'library' = 'native';

/** The native engine when it is chosen and this build has it, else null. */
export function nativeLiveAudio(): LiveAudioNative | null {
  return LIVE_AUDIO_ENGINE === 'native' ? LiveAudio : null;
}
