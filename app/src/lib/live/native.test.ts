import type { LiveAudioEvents, LiveAudioNative } from '../../../modules/live-audio';
import { bytesToBase64 } from '../../terminal/base64';
import { base64ToBytes, createNativeLiveAudio, earconPcm, NATIVE_RATE } from './native';

jest.mock('../../../modules/live-audio', () => ({ LiveAudio: null }));

function fakeModule() {
  const listeners = new Map<string, Set<(e: never) => void>>();
  const enqueued: { bytes: number; tag: number }[] = [];
  const mod = {
    requestPermission: jest.fn(async () => true),
    start: jest.fn(async () => ({
      voiceProcessing: true,
      inputFormat: 'x',
      route: 'iPhone Microphone',
      sampleRate: 24000,
    })),
    stop: jest.fn(async () => {}),
    enqueue: jest.fn((b64: string, tag: number) => enqueued.push({ bytes: base64ToBytes(b64).length, tag })),
    playTone: jest.fn(),
    clear: jest.fn(),
    setDucked: jest.fn(),
    addListener(name: string, cb: (e: never) => void) {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set);
      set.add(cb);
      return { remove: () => set.delete(cb) };
    },
  };
  const fire = <K extends keyof LiveAudioEvents>(name: K, e: Parameters<LiveAudioEvents[K]>[0]) => {
    for (const cb of listeners.get(name) ?? []) (cb as (x: typeof e) => void)(e);
  };
  return {
    mod: mod as unknown as LiveAudioNative,
    raw: mod,
    enqueued,
    fire,
    count: (n: keyof LiveAudioEvents) => listeners.get(n)?.size ?? 0,
  };
}

const ms = (n: number) => new ArrayBuffer(n * 48);

describe('base64', () => {
  it('round-trips against Node for every tail length', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 3840]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
      const b64 = Buffer.from(bytes).toString('base64');
      expect(bytesToBase64(bytes)).toBe(b64);
      expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes));
    }
  });
});

describe('earcons on the native engine', () => {
  it('renders each tone as 24 kHz PCM spanning its notes', () => {
    const pcm = earconPcm('start');
    expect(pcm.length / 2 / NATIVE_RATE).toBeCloseTo(0.24, 2);
    const s = new Int16Array(pcm.buffer);
    expect(Math.max(...Array.from(s))).toBeGreaterThan(3000);
    expect(s[0]).toBe(0);
  });

  it('plays a tone through the module and caches it', () => {
    const f = fakeModule();
    const a = createNativeLiveAudio(f.mod);
    a.tone('heard');
    a.tone('heard');
    expect(f.raw.playTone).toHaveBeenCalledTimes(2);
    expect(f.raw.playTone.mock.calls[0][0]).toBe(f.raw.playTone.mock.calls[1][0]);
  });
});

describe('native mic', () => {
  it('decodes frames and stops listening on stop', async () => {
    const f = fakeModule();
    const a = createNativeLiveAudio(f.mod);
    const got: [number, number][] = [];
    const info = await a.start((pcm, level) => got.push([pcm.byteLength, level]));
    expect(info.voiceProcessing).toBe(true);
    f.fire('onFrame', { pcm: bytesToBase64(new Uint8Array(3840)), level: 0.3 });
    expect(got).toEqual([[3840, 0.3]]);
    await a.stop();
    f.fire('onFrame', { pcm: bytesToBase64(new Uint8Array(3840)), level: 0.3 });
    expect(got.length).toBe(1);
    expect(f.raw.stop).toHaveBeenCalled();
    expect(f.count('onFrame')).toBe(0);
  });
});

describe('native restart', () => {
  it('a start without a stop in between (End then Start at once) sends each frame once', async () => {
    const f = fakeModule();
    const a = createNativeLiveAudio(f.mod);
    const got: number[] = [];
    await a.start((pcm) => got.push(pcm.byteLength));
    await a.start((pcm) => got.push(pcm.byteLength));
    expect(f.count('onFrame')).toBe(1);
    f.fire('onFrame', { pcm: bytesToBase64(new Uint8Array(3840)), level: 0.2 });
    expect(got).toEqual([3840]);
  });
});

describe('native permission', () => {
  it('refuses without mic permission and never starts the engine', async () => {
    const f = fakeModule();
    f.raw.requestPermission.mockResolvedValueOnce(false);
    await expect(createNativeLiveAudio(f.mod).start(() => {})).rejects.toThrow(/permission/);
    expect(f.raw.start).not.toHaveBeenCalled();
  });
});

describe('native player', () => {
  function setup() {
    let t = 1000;
    const f = fakeModule();
    const a = createNativeLiveAudio(f.mod, () => t);
    const events: string[] = [];
    const p = a.createPlayer({
      onProgress: (turn, played) => events.push(`progress ${turn} ${played}`),
      onDrained: (turn) => events.push(`drained ${turn}`),
    });
    return { f, p, events, advance: (d: number) => (t += d) };
  }

  it('prebuffers 250 ms, then sends 200 ms chunks tagged per turn', () => {
    const { f, p } = setup();
    p.start(7);
    p.push(ms(200));
    expect(f.enqueued).toEqual([]);
    p.push(ms(100));
    expect(f.enqueued).toEqual([{ bytes: 300 * 48, tag: 1 }]);
    p.push(ms(150));
    expect(f.enqueued.length).toBe(1);
    p.push(ms(50));
    expect(f.enqueued[1]).toEqual({ bytes: 200 * 48, tag: 1 });
  });

  it('drains only after the last chunk is heard', () => {
    const { f, p, events } = setup();
    p.start(3);
    p.push(ms(300));
    p.push(ms(40));
    p.end();
    expect(f.enqueued.map((e) => e.bytes)).toEqual([300 * 48, 40 * 48]);
    f.fire('onPlayed', { tag: 1, ms: 300 });
    expect(events).toEqual(['progress 3 300']);
    f.fire('onPlayed', { tag: 1, ms: 40 });
    expect(events).toEqual(['progress 3 300', 'progress 3 340', 'drained 3']);
  });

  it('a short reply that never reached the prebuffer still plays and drains', () => {
    const { f, p, events } = setup();
    p.start(4);
    p.push(ms(80));
    p.end();
    expect(f.enqueued).toEqual([{ bytes: 80 * 48, tag: 1 }]);
    f.fire('onPlayed', { tag: 1, ms: 80 });
    expect(events).toEqual(['progress 4 80', 'drained 4']);
  });

  it('cancel clears the engine and ignores the stopped buffers it reports', () => {
    const { f, p, events } = setup();
    p.start(5);
    p.push(ms(400));
    p.cancel(5);
    expect(f.raw.clear).toHaveBeenCalledTimes(1);
    f.fire('onPlayed', { tag: 1, ms: 400 });
    p.start(6);
    p.push(ms(300));
    expect(f.enqueued[1].tag).toBe(2);
    expect(events).toEqual([]);
  });

  it('a cancel for an older turn is ignored', () => {
    const { f, p } = setup();
    p.start(8);
    p.push(ms(300));
    p.cancel(7);
    expect(f.raw.clear).not.toHaveBeenCalled();
  });

  it('interpolates heard time between buffer events, capped at what was queued', () => {
    const { f, p, advance } = setup();
    p.start(9);
    p.push(ms(300));
    advance(120);
    expect(p.playedMsNow()).toBe(120);
    advance(1000);
    expect(p.playedMsNow()).toBe(300);
    f.fire('onPlayed', { tag: 1, ms: 300 });
    expect(p.receivedMs()).toBe(300);
  });

  it('keeps an odd trailing byte for the next frame', () => {
    const { f, p } = setup();
    p.start(10);
    p.push(new ArrayBuffer(300 * 48 + 1));
    p.push(new ArrayBuffer(1));
    p.end();
    expect(f.enqueued.reduce((n, e) => n + e.bytes, 0)).toBe(300 * 48 + 2);
  });

  it('ducks through the engine', () => {
    const { f, p } = setup();
    p.duck(true);
    expect(f.raw.setDucked).toHaveBeenCalledWith(true);
  });
});

describe('native playback clock', () => {
  it('captions follow the speaker clock, not the enqueue time', () => {
    const f = fakeModule();
    let clock = -1;
    const playedMs = jest.fn(() => clock);
    (f.raw as unknown as { playedMs: (tag: number) => number }).playedMs = playedMs;
    let t = 0;
    const p = createNativeLiveAudio(f.mod, () => t).createPlayer({ onProgress: () => {}, onDrained: () => {} });
    p.start(1);
    p.push(ms(300));
    t = 200;
    // Queued but not yet out of the speaker: the estimate would say 200 ms.
    expect(p.playedMsNow()).toBe(0);
    clock = 120;
    expect(p.playedMsNow()).toBe(120);
    // Never past what was queued.
    clock = 900;
    expect(p.playedMsNow()).toBe(300);
    expect(playedMs).toHaveBeenCalledWith(1);
  });

  it('a module without the clock keeps the estimate', () => {
    const f = fakeModule();
    let t = 0;
    const p = createNativeLiveAudio(f.mod, () => t).createPlayer({ onProgress: () => {}, onDrained: () => {} });
    p.start(1);
    p.push(ms(300));
    t = 200;
    expect(p.playedMsNow()).toBe(200);
  });
});
