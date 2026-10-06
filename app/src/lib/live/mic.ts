// Mic capture and the shared audio session for Live on react-native-audio-api
// (the library engine; the native one is ./native.ts). Recorder and playback
// share the library's one AVAudioEngine. The session is configured ONCE per
// Live session: changing category/mode mid-call triggers route changes.

type AudioApi = typeof import('react-native-audio-api');

export const MIC_RATE = 16000;
/** 80 ms at 16 kHz: Deepgram Flux's recommended frame. */
export const MIC_FRAME_SAMPLES = 1280;

async function loadAudioApi(): Promise<AudioApi> {
  return import('react-native-audio-api');
}

export function floatToInt16(samples: Float32Array): ArrayBuffer {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
    out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return out.buffer;
}

/** Speakerphone voice session: play and record, voice-chat processing,
 * Bluetooth (HFP and, where the route supports it, high-quality recording),
 * haptics allowed while recording. */
export async function configureLiveAudio(api: AudioApi): Promise<void> {
  const permission = await api.AudioManager.requestRecordingPermissions();
  if (permission !== 'Granted') throw new Error('Microphone permission is required for Live.');
  api.AudioManager.setAudioSessionOptions({
    iosCategory: 'playAndRecord',
    iosMode: 'voiceChat',
    iosOptions: ['defaultToSpeaker', 'allowBluetoothHFP', 'bluetoothHighQualityRecording'],
    iosAllowHaptics: true,
  });
  await api.AudioManager.setAudioSessionActivity(true);
}

export interface Mic {
  stop(): Promise<void>;
  /** The native recorder's own view of whether it is capturing. */
  isRecording(): boolean;
}

/** 80 ms Int16 frames plus the frame's RMS level (0..1) for the visual. */
export async function startMic(
  onFrame: (pcm: ArrayBuffer, level: number) => void,
  opts: { loadApi?: () => Promise<AudioApi>; onError?: (message: string) => void } = {},
): Promise<Mic> {
  const api = await (opts.loadApi ?? loadAudioApi)();
  const recorder = new api.AudioRecorder();
  // An error is reported, never latched: the recorder re-prepares itself when
  // the input format changes, and a mic silenced on its first error would hear
  // nothing for the rest of the session.
  recorder.onError((e) => opts.onError?.(e?.message ?? 'recorder error'));
  recorder.onAudioReady(
    { sampleRate: MIC_RATE, bufferLength: MIC_FRAME_SAMPLES, channelCount: 1 },
    (event) => {
      const samples = event.buffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
      onFrame(floatToInt16(samples), samples.length ? Math.sqrt(sum / samples.length) : 0);
    },
  );
  const started = await recorder.start();
  if (started?.status === 'error') {
    recorder.clearOnAudioReady();
    recorder.clearOnError();
    throw new Error(`Microphone unavailable: ${started.message}`);
  }
  return {
    async stop() {
      recorder.clearOnAudioReady();
      recorder.clearOnError();
      await recorder.stop();
    },
    isRecording: () => recorder.isRecording(),
  };
}
