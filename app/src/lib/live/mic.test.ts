import { configureLiveAudio, floatToInt16, MIC_FRAME_SAMPLES, startMic } from './mic';
import { EARCONS, playEarcon, type ToneContextLike } from './earcons';

function fakeApi() {
  const calls: unknown[] = [];
  let onReady: ((e: { buffer: { getChannelData(i: number): Float32Array } }) => void) | null = null;
  let onErr: ((e: { message: string }) => void) | null = null;
  let readyOpts: unknown = null;
  const api = {
    AudioManager: {
      requestRecordingPermissions: jest.fn(async () => 'Granted'),
      setAudioSessionOptions: jest.fn((o: unknown) => calls.push(o)),
      setAudioSessionActivity: jest.fn(async () => true),
    },
    AudioRecorder: class {
      onError(cb: typeof onErr) {
        onErr = cb;
      }
      onAudioReady(o: unknown, cb: typeof onReady) {
        readyOpts = o;
        onReady = cb;
      }
      async start() {
        return { status: 'success' };
      }
      async stop() {}
      clearOnAudioReady() {}
      clearOnError() {}
    },
  };
  return {
    api: api as unknown as typeof import('react-native-audio-api'),
    calls,
    readyOpts: () => readyOpts,
    emit: (s: Float32Array) => onReady?.({ buffer: { getChannelData: () => s } }),
    error: (message: string) => onErr?.({ message }),
  };
}

describe('mic', () => {
  it('clamps and scales float samples to int16', () => {
    expect(Array.from(new Int16Array(floatToInt16(new Float32Array([1, -1, 2, -2, 0]))))).toEqual([
      32767, -32768, 32767, -32768, 0,
    ]);
  });

  it('configures the voice session once with Bluetooth HQ recording and haptics', async () => {
    const f = fakeApi();
    await configureLiveAudio(f.api);
    expect(f.calls).toEqual([
      {
        iosCategory: 'playAndRecord',
        iosMode: 'voiceChat',
        iosOptions: ['defaultToSpeaker', 'allowBluetoothHFP', 'bluetoothHighQualityRecording'],
        iosAllowHaptics: true,
      },
    ]);
  });

  it('refuses without mic permission', async () => {
    const f = fakeApi();
    (f.api.AudioManager.requestRecordingPermissions as jest.Mock).mockResolvedValueOnce('Denied');
    await expect(configureLiveAudio(f.api)).rejects.toThrow(/permission/);
  });

  it('emits 80 ms frames with their level and never reconfigures the session', async () => {
    const f = fakeApi();
    const frames: [number, number][] = [];
    await startMic((pcm, level) => frames.push([pcm.byteLength, level]), { loadApi: async () => f.api });
    expect(f.readyOpts()).toMatchObject({ sampleRate: 16000, bufferLength: MIC_FRAME_SAMPLES, channelCount: 1 });
    f.emit(new Float32Array(MIC_FRAME_SAMPLES).fill(0.5));
    expect(frames[0][0]).toBe(2560);
    expect(frames[0][1]).toBeCloseTo(0.5, 3);
    expect(f.calls).toEqual([]);
  });
});

describe('earcons', () => {
  it('schedules one oscillator per note with an envelope', () => {
    const started: number[] = [];
    const ctx: ToneContextLike = {
      currentTime: 10,
      destination: {},
      createOscillator: () => ({
        type: '',
        frequency: { setValueAtTime: () => {} },
        connect: () => {},
        start: (t: number) => started.push(t),
        stop: () => {},
      }),
      createGain: () => ({ gain: { setValueAtTime: () => {}, linearRampToValueAtTime: () => {} }, connect: () => {} }),
    };
    playEarcon(ctx, 'start');
    expect(started).toEqual(EARCONS.start.map(([, at]) => 10 + at));
  });
});

describe('mic errors', () => {
  it('a recorder error is reported and does NOT silence the mic', async () => {
    const f = fakeApi();
    const frames: number[] = [];
    const errors: string[] = [];
    await startMic((pcm) => frames.push(pcm.byteLength), { loadApi: async () => f.api, onError: (m) => errors.push(m) });
    f.emit(new Float32Array(MIC_FRAME_SAMPLES));
    f.error('input format changed');
    f.emit(new Float32Array(MIC_FRAME_SAMPLES));
    expect(errors).toEqual(['input format changed']);
    expect(frames.length).toBe(2);
  });
});
