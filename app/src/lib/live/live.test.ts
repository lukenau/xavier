// The Live client: wire protocol, gapless PCM player, and the reconnecting
// socket. Fakes stand in for the socket and for react-native-audio-api.
import { helloFrame, parseLiveFrame } from './protocol';
import { createPcmPlayer, int16ToFloat32, type AudioContextLike } from './player';
import { connectLive, type LiveSocket } from './client';

// ── protocol ───────────────────────────────────────────────────────────────

describe('parseLiveFrame', () => {
  it('parses every server frame and tags binary audio', () => {
    const cases: unknown[] = [
      { type: 'ready', session: 's1' },
      { type: 'state', value: 'speaking' },
      { type: 'heard', text: 'hey', final: true },
      { type: 'turn', message_id: 'm1', seq: 12 },
      { type: 'speak_start', turn_id: 2 },
      { type: 'speak_end', turn_id: 2 },
      { type: 'caption', turn_id: 2, text: 'Five things.' },
      { type: 'cancel', turn_id: 2 },
      { type: 'duck' },
      { type: 'unduck' },
      { type: 'ended', reason: 'idle' },
      { type: 'notice', message: "Xavier didn't get that." },
      { type: 'pong' },
      { type: 'error', message: 'x' },
    ];
    for (const c of cases) expect(parseLiveFrame(JSON.stringify(c))).toEqual(c);
    const buf = new ArrayBuffer(4);
    expect(parseLiveFrame(buf)).toEqual({ type: 'audio', data: buf });
  });

  it('rejects junk and wrong field types', () => {
    expect(parseLiveFrame('not json')).toBeNull();
    expect(parseLiveFrame('[]')).toBeNull();
    expect(parseLiveFrame('{"type":"state","value":"asleep"}')).toBeNull();
    expect(parseLiveFrame('{"type":"speak_start","turn_id":"2"}')).toBeNull();
    expect(parseLiveFrame('{"type":"heard","text":"x"}')).toBeNull();
    expect(parseLiveFrame('{"type":"mystery"}')).toBeNull();
    expect(parseLiveFrame('{"type":"notice"}')).toBeNull();
  });

  it('builds hello with an optional resume cursor', () => {
    const tts = { voice: 'flux-hannah-en', speed: 1, expressivity: 0, enabled: true };
    expect(JSON.parse(helloFrame('t1', false, tts))).toEqual({ type: 'hello', thread_id: 't1', aec: false, tts });
    expect(JSON.parse(helloFrame('t1', true, tts, 40)).resume_seq).toBe(40);
    expect(JSON.parse(helloFrame('t1', true, tts, undefined, 24000)).mic_rate).toBe(24000);
    expect(JSON.parse(helloFrame('t1', true, tts))).not.toHaveProperty('mic_rate');
  });
});

// ── player ─────────────────────────────────────────────────────────────────

class FakeNode {
  enqueued: { id: string; length: number }[] = [];
  started = false;
  stopped = false;
  cleared = false;
  onBufferEnded: ((e: { bufferId: string; isLastBufferInQueue: boolean }) => void) | null = null;
  private next = 0;
  connect() {}
  enqueueBuffer(b: { length: number }) {
    const id = String(this.next++);
    this.enqueued.push({ id, length: b.length });
    return id;
  }
  /** Mirrors react-native-audio-api 0.13.6: offset defaults to -1 and a
   * negative offset throws, so a bare start() is a crash on device. */
  start(when = 0, offset = -1) {
    if (when < 0) throw new RangeError('when');
    if (offset && offset < 0) throw new RangeError(`offset must be a finite non-negative number: ${offset}`);
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  clearBuffers() {
    this.cleared = true;
  }
  /** Simulate the native side finishing the oldest buffer. */
  finishNext() {
    const b = this.enqueued.shift()!;
    this.onBufferEnded?.({ bufferId: b.id, isLastBufferInQueue: this.enqueued.length === 0 });
  }
}

function fakeContext() {
  const nodes: FakeNode[] = [];
  const gains: { gain: { value: number } }[] = [];
  const ctx: AudioContextLike = {
    sampleRate: 24000,
    destination: {},
    createBuffer: (_ch: number, length: number, sampleRate: number) => ({
      length,
      duration: length / sampleRate,
      copyToChannel: () => {},
    }),
    createBufferQueueSource: () => {
      const n = new FakeNode();
      nodes.push(n);
      return n;
    },
    createGain: () => {
      const g = { gain: { value: 1 }, connect: () => {} };
      gains.push(g);
      return g;
    },
  } as unknown as AudioContextLike;
  return { ctx, nodes, gains };
}

const pcm = (samples: number) => new Int16Array(samples).buffer;

describe('createPcmPlayer', () => {
  it('converts int16 to float32 symmetrically', () => {
    const f = int16ToFloat32(new Int16Array([32767, -32768, 0, 16384]).buffer);
    expect(f[0]).toBeCloseTo(1, 3);
    expect(f[1]).toBe(-1);
    expect(f[2]).toBe(0);
    expect(f[3]).toBeCloseTo(0.5, 3);
  });

  it('coalesces small pushes and prebuffers before starting', () => {
    const { ctx, nodes } = fakeContext();
    const p = createPcmPlayer(ctx, { onProgress: jest.fn(), onDrained: jest.fn() });
    p.start(1);
    p.push(pcm(2400));
    p.push(pcm(2400));
    expect(nodes[0].enqueued.map((b) => b.length)).toEqual([4800]);
    expect(nodes[0].started).toBe(false);
    p.push(pcm(2400));
    p.push(pcm(2400));
    expect(nodes[0].enqueued.map((b) => b.length)).toEqual([4800, 4800]);
    expect(nodes[0].started).toBe(true);
  });

  it('reports cumulative progress and drains once after end', () => {
    const { ctx, nodes } = fakeContext();
    const onProgress = jest.fn();
    const onDrained = jest.fn();
    const p = createPcmPlayer(ctx, { onProgress, onDrained });
    p.start(3);
    p.push(pcm(4800));
    p.push(pcm(1200));
    p.end();
    expect(nodes[0].started).toBe(true);
    nodes[0].finishNext();
    expect(onProgress).toHaveBeenLastCalledWith(3, 200);
    expect(onDrained).not.toHaveBeenCalled();
    nodes[0].finishNext();
    expect(onProgress).toHaveBeenLastCalledWith(3, 250);
    expect(onDrained).toHaveBeenCalledTimes(1);
    expect(onDrained).toHaveBeenCalledWith(3);
  });

  it('an underrun mid-reply is not a drain', () => {
    const { ctx, nodes } = fakeContext();
    const onDrained = jest.fn();
    const p = createPcmPlayer(ctx, { onProgress: jest.fn(), onDrained });
    p.start(1);
    p.push(pcm(7200));
    nodes[0].finishNext();
    expect(onDrained).not.toHaveBeenCalled();
  });

  it('drops audio after cancel until the next start', () => {
    const { ctx, nodes } = fakeContext();
    const p = createPcmPlayer(ctx, { onProgress: jest.fn(), onDrained: jest.fn() });
    p.start(1);
    p.push(pcm(7200));
    p.cancel(1);
    expect(nodes[0].cleared && nodes[0].stopped).toBe(true);
    p.push(pcm(7200));
    p.end();
    expect(nodes[0].enqueued.length).toBe(1);
    expect(nodes.length).toBe(1);
    p.start(2);
    p.push(pcm(7200));
    expect(nodes.length).toBe(2);
    expect(nodes[1].enqueued.length).toBe(1);
  });

  it('cancel for an older turn leaves the current one alone', () => {
    const { ctx, nodes } = fakeContext();
    const p = createPcmPlayer(ctx, { onProgress: jest.fn(), onDrained: jest.fn() });
    p.start(2);
    p.cancel(1);
    p.push(pcm(7200));
    expect(nodes[0].enqueued.length).toBe(1);
  });

  it('keeps an odd trailing byte for the next chunk', () => {
    const { ctx, nodes } = fakeContext();
    const p = createPcmPlayer(ctx, { onProgress: jest.fn(), onDrained: jest.fn() });
    p.start(1);
    p.push(new ArrayBuffer(4801));
    p.push(new ArrayBuffer(4799));
    p.end();
    expect(nodes[0].enqueued.reduce((n, b) => n + b.length, 0)).toBe(4800);
  });

  it('ducks and restores gain, and reports the output level', () => {
    const { ctx, gains } = fakeContext();
    const p = createPcmPlayer(ctx, { onProgress: jest.fn(), onDrained: jest.fn() });
    p.start(1);
    p.duck(true);
    expect(gains[0].gain.value).toBeLessThan(0.5);
    p.duck(false);
    expect(gains[0].gain.value).toBe(1);
    const loud = new Int16Array(4800).fill(16384).buffer;
    p.push(loud);
    expect(p.level()).toBeGreaterThan(0.3);
  });
});

// ── client ─────────────────────────────────────────────────────────────────

class FakeSocket implements LiveSocket {
  readyState = 0;
  binaryType = 'blob';
  sent: (string | ArrayBuffer)[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(d: string | ArrayBuffer) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
  json() {
    return this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s));
  }
}

describe('connectLive', () => {
  const tts = { voice: 'flux-hannah-en', speed: 1, expressivity: 0, enabled: true };
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function setup() {
    const sockets: FakeSocket[] = [];
    const onStatus = jest.fn();
    const onFrame = jest.fn();
    const live = connectLive({
      threadId: 't1',
      aec: false,
      tts,
      onFrame,
      onStatus,
      socketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });
    return { live, sockets, onStatus, onFrame };
  }

  it('sends hello on open, sets arraybuffer, and pings every 10 s', () => {
    const { sockets } = setup();
    expect(sockets[0].binaryType).toBe('arraybuffer');
    sockets[0].open();
    expect(sockets[0].json()[0]).toMatchObject({ type: 'hello', thread_id: 't1', aec: false });
    jest.advanceTimersByTime(10_000);
    expect(sockets[0].json().some((f) => f.type === 'ping')).toBe(true);
  });

  it('reconnects after close with backoff and resumes from the last turn', () => {
    const { live, sockets, onStatus, onFrame } = setup();
    sockets[0].open();
    sockets[0].onmessage?.({ data: JSON.stringify({ type: 'turn', message_id: 'm', seq: 33 }) });
    sockets[0].onmessage?.({ data: JSON.stringify({ type: 'state', value: 'thinking' }) });
    expect(onFrame).toHaveBeenCalledWith({ type: 'turn', message_id: 'm', seq: 33 });
    sockets[0].drop();
    expect(onStatus).toHaveBeenLastCalledWith('reconnecting');
    jest.advanceTimersByTime(999);
    expect(sockets.length).toBe(1);
    jest.advanceTimersByTime(1);
    expect(sockets.length).toBe(2);
    sockets[1].drop();
    jest.advanceTimersByTime(1999);
    expect(sockets.length).toBe(2);
    jest.advanceTimersByTime(1);
    expect(sockets.length).toBe(3);
    sockets[2].open();
    expect(onStatus).toHaveBeenLastCalledWith('open');
    expect(sockets[2].json()[0]).toMatchObject({ type: 'hello', resume_seq: 33 });
    live.stop();
  });

  it('does not resume once the reply finished', () => {
    const { sockets } = setup();
    sockets[0].open();
    sockets[0].onmessage?.({ data: JSON.stringify({ type: 'turn', message_id: 'm', seq: 33 }) });
    sockets[0].onmessage?.({ data: JSON.stringify({ type: 'state', value: 'listening' }) });
    sockets[0].drop();
    jest.advanceTimersByTime(1000);
    sockets[1].open();
    expect(sockets[1].json()[0].resume_seq).toBeUndefined();
  });

  it('does not reconnect after stop, and sends stop', () => {
    const { live, sockets } = setup();
    sockets[0].open();
    live.stop();
    expect(sockets[0].json().pop()).toEqual({ type: 'stop' });
    sockets[0].drop();
    jest.advanceTimersByTime(30_000);
    expect(sockets.length).toBe(1);
  });

  it('sends audio only while open, and playback/drained/interrupt as JSON', () => {
    const { live, sockets } = setup();
    live.sendAudio(new ArrayBuffer(2));
    expect(sockets[0].sent.length).toBe(0);
    sockets[0].open();
    live.sendAudio(new ArrayBuffer(2));
    live.playback(2, 420);
    live.drained(2);
    live.interrupt();
    const json = sockets[0].json().slice(1);
    expect(json).toEqual([
      { type: 'playback', turn_id: 2, played_ms: 420 },
      { type: 'drained', turn_id: 2 },
      { type: 'interrupt' },
    ]);
    expect(sockets[0].sent.filter((s) => s instanceof ArrayBuffer).length).toBe(1);
  });

  it('an ended frame stops reconnecting', () => {
    const { sockets, onFrame } = setup();
    sockets[0].open();
    sockets[0].onmessage?.({ data: JSON.stringify({ type: 'ended', reason: 'idle' }) });
    expect(onFrame).toHaveBeenCalledWith({ type: 'ended', reason: 'idle' });
    sockets[0].drop();
    jest.advanceTimersByTime(30_000);
    expect(sockets.length).toBe(1);
  });
});

describe('connectLive liveness and hold', () => {
  const tts = { voice: 'flux-hannah-en', speed: 1, expressivity: 0, enabled: true };
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('a half-open socket (no traffic for 25 s) is dropped and re-dialled', () => {
    const sockets: FakeSocket[] = [];
    const onStatus = jest.fn();
    connectLive({
      threadId: 't1', aec: false, tts, onFrame: jest.fn(), onStatus,
      socketFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    });
    sockets[0].open();
    jest.advanceTimersByTime(20_000);
    expect(sockets.length).toBe(1);
    jest.advanceTimersByTime(10_000);
    expect(onStatus).toHaveBeenCalledWith('reconnecting');
    expect(sockets[0].closed).toBe(true);
    jest.advanceTimersByTime(1000);
    expect(sockets.length).toBe(2);
  });

  it('traffic keeps the socket alive', () => {
    const sockets: FakeSocket[] = [];
    connectLive({
      threadId: 't1', aec: false, tts, onFrame: jest.fn(), onStatus: jest.fn(),
      socketFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    });
    sockets[0].open();
    for (let i = 0; i < 6; i += 1) {
      jest.advanceTimersByTime(10_000);
      sockets[0].onmessage?.({ data: '{"type":"pong"}' });
    }
    expect(sockets.length).toBe(1);
  });

  it('hold tells the server to stop speaking without ending the run', () => {
    const sockets: FakeSocket[] = [];
    const live = connectLive({
      threadId: 't1', aec: false, tts, onFrame: jest.fn(), onStatus: jest.fn(),
      socketFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    });
    sockets[0].onmessage?.({ data: JSON.stringify({ type: 'turn', message_id: 'm', seq: 5 }) });
    sockets[0].open();
    live.hold();
    expect(sockets[0].json().pop()).toEqual({ type: 'hold' });
  });
});

describe('player clock (caption sync)', () => {
  it('interpolates played time between buffer events, never past what is queued', () => {
    const { ctx, nodes } = fakeContext();
    let now = 1000;
    const p = createPcmPlayer(ctx, { onProgress: jest.fn(), onDrained: jest.fn() }, () => now);
    p.start(1);
    p.push(pcm(7200)); // 300 ms, starts playing
    expect(p.receivedMs()).toBe(300);
    expect(p.playedMsNow()).toBe(0);
    now += 120;
    expect(p.playedMsNow()).toBe(120);
    nodes[0].finishNext(); // the 300 ms buffer ended
    expect(p.playedMsNow()).toBe(300);
    now += 500;
    expect(p.playedMsNow()).toBe(300); // nothing more queued: stays put
  });

  it('knows when every byte of the turn has arrived', () => {
    const { ctx } = fakeContext();
    const p = createPcmPlayer(ctx, { onProgress: jest.fn(), onDrained: jest.fn() }, () => 0);
    p.start(1);
    p.push(pcm(4800));
    expect(p.complete()).toBe(false);
    p.end();
    expect(p.complete()).toBe(true);
  });
});

describe('connectLive diagnostics', () => {
  it('sends diag lines to the server', () => {
    const sockets: FakeSocket[] = [];
    const live = connectLive({
      threadId: 't1', aec: true, tts: { voice: 'flux-hannah-en', speed: 1, expressivity: 0, enabled: true },
      onFrame: jest.fn(), onStatus: jest.fn(),
      socketFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    });
    sockets[0].open();
    live.diag('mic error: input format changed');
    expect(sockets[0].json().pop()).toEqual({ type: 'diag', message: 'mic error: input format changed' });
    live.stop();
  });
});

describe('connectLive refused sessions', () => {
  const tts = { voice: 'flux-hannah-en', speed: 1, expressivity: 0, enabled: true };
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('a 1008 close is "locked": no reconnect ladder against a refused session', () => {
    const sockets: FakeSocket[] = [];
    const onStatus = jest.fn();
    connectLive({
      threadId: 't1', aec: false, tts, onFrame: jest.fn(), onStatus,
      socketFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    });
    sockets[0].open();
    sockets[0].readyState = 3;
    sockets[0].onclose?.({ code: 1008 });
    expect(onStatus).toHaveBeenLastCalledWith('locked');
    expect(onStatus).not.toHaveBeenCalledWith('reconnecting');
    jest.advanceTimersByTime(30_000);
    expect(sockets.length).toBe(1);
  });

  it('a 4403 close (Origin refused) is "refused", not "locked", and does not retry', () => {
    const sockets: FakeSocket[] = [];
    const onStatus = jest.fn();
    connectLive({
      threadId: 't1', aec: false, tts, onFrame: jest.fn(), onStatus,
      socketFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    });
    sockets[0].open();
    sockets[0].readyState = 3;
    sockets[0].onclose?.({ code: 4403 });
    expect(onStatus).toHaveBeenLastCalledWith('refused');
    expect(onStatus).not.toHaveBeenCalledWith('locked');
    jest.advanceTimersByTime(30_000);
    expect(sockets.length).toBe(1);
  });

  it('re-reads the server address on every dial, so a changed address applies on reconnect', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { setUserApiBase, clearUserApiBase } = require('../api') as typeof import('../api');
    const sockets: FakeSocket[] = [];
    const urls: string[] = [];
    const live = connectLive({
      threadId: 't1', aec: false, tts, onFrame: jest.fn(), onStatus: jest.fn(),
      socketFactory: (url) => { urls.push(url); const s = new FakeSocket(); sockets.push(s); return s; },
    });
    try {
      sockets[0].open();
      expect(urls[0]).toMatch(/^wss?:\/\/.+\/api\/live$/);
      expect((await setUserApiBase('https://moved.example.test')).ok).toBe(true);
      sockets[0].drop();
      jest.advanceTimersByTime(1000);
      expect(urls[1]).toBe('wss://moved.example.test/api/live');
    } finally {
      live.stop();
      await clearUserApiBase();
    }
  });
});
