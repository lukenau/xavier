// Gapless playback of Xavier's streamed reply. One AudioBufferQueueSourceNode
// per spoken turn: PCM arrives in small websocket frames, is coalesced into
// ~200 ms buffers (enqueuing every 2 KB frame floods the bridge), and the node
// starts once ~250 ms is queued so a network hiccup does not stutter. An empty
// queue plays silence and resumes on the next buffer, so an underrun is not
// the end — only `end()` followed by the last buffer finishing is.

export const TTS_RATE = 24000;
const CHUNK_SAMPLES = 4800; // 200 ms
const PREBUFFER_SAMPLES = 6000; // 250 ms
const DUCK_GAIN = 0.2;

interface BufferLike {
  length: number;
  duration: number;
  copyToChannel(source: Float32Array, channel: number): void;
}
interface QueueNodeLike {
  connect(dest: unknown): void;
  enqueueBuffer(buffer: BufferLike): string;
  start(when: number, offset: number): void;
  stop(): void;
  clearBuffers(): void;
  onBufferEnded: ((e: { bufferId: string; isLastBufferInQueue: boolean }) => void) | null;
}
interface GainLike {
  gain: { value: number };
  connect(dest: unknown): void;
}
/** The slice of react-native-audio-api's AudioContext the player uses. */
export interface AudioContextLike {
  destination: unknown;
  createBuffer(channels: number, length: number, sampleRate: number): BufferLike;
  createBufferQueueSource(): QueueNodeLike;
  createGain(): GainLike;
}

export interface PcmPlayer {
  start(turnId: number): void;
  push(pcm: ArrayBuffer): void;
  end(): void;
  /** Stop and drop a turn now. A cancel for an older turn is ignored. */
  cancel(turnId?: number): void;
  duck(on: boolean): void;
  /** RMS of the most recent audio handed to the speaker, 0..1 (drives the visual). */
  level(): number;
  /** ms of this turn actually heard so far, interpolated between buffer events. */
  playedMsNow(): number;
  /** ms of this turn's audio received so far. */
  receivedMs(): number;
  /** Every byte of this turn has arrived (`end()` was called). */
  complete(): boolean;
}

export function int16ToFloat32(pcm: ArrayBuffer): Float32Array {
  const src = new Int16Array(pcm);
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 1) out[i] = src[i] / 32768;
  return out;
}

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export function createPcmPlayer(
  ctx: AudioContextLike,
  cb: { onProgress(turnId: number, playedMs: number): void; onDrained(turnId: number): void },
  now: () => number = Date.now,
): PcmPlayer {
  let turn: number | null = null;
  let node: QueueNodeLike | null = null;
  let gain: GainLike | null = null;
  let pending: Float32Array[] = [];
  let pendingSamples = 0;
  let carry: Uint8Array | null = null;
  let queuedSamples = 0;
  let started = false;
  let ended = false;
  let outstanding = 0;
  let playedMs = 0;
  let ducked = false;
  let lastLevel = 0;
  // Wall-clock anchor for interpolating playback between onBufferEnded events.
  let playedAt = 0;
  const bufferMs = new Map<string, number>();

  function reset(): void {
    turn = null;
    node = null;
    pending = [];
    pendingSamples = 0;
    carry = null;
    queuedSamples = 0;
    started = false;
    ended = false;
    outstanding = 0;
    playedMs = 0;
    bufferMs.clear();
    lastLevel = 0;
    playedAt = 0;
  }

  function enqueuePending(): void {
    if (!node || pendingSamples === 0) return;
    const joined = new Float32Array(pendingSamples);
    let at = 0;
    for (const p of pending) {
      joined.set(p, at);
      at += p.length;
    }
    pending = [];
    pendingSamples = 0;
    const buffer = ctx.createBuffer(1, joined.length, TTS_RATE);
    buffer.copyToChannel(joined, 0);
    const id = node.enqueueBuffer(buffer);
    bufferMs.set(id, (joined.length / TTS_RATE) * 1000);
    outstanding += 1;
    queuedSamples += joined.length;
  }

  function maybeStart(force: boolean): void {
    if (node && !started && (queuedSamples >= PREBUFFER_SAMPLES || (force && queuedSamples > 0))) {
      started = true;
      playedAt = now();
      // Explicit offset: 0.13.6 defaults it to -1 and throws on a bare start().
      node.start(0, 0);
    }
  }

  function finishTurn(): void {
    const t = turn;
    try {
      node?.stop();
    } catch {
      /* already stopped */
    }
    reset();
    if (t !== null) cb.onDrained(t);
  }

  return {
    start(turnId) {
      if (node) {
        node.clearBuffers();
        node.stop();
      }
      reset();
      turn = turnId;
      gain = ctx.createGain();
      gain.gain.value = ducked ? DUCK_GAIN : 1;
      gain.connect(ctx.destination);
      node = ctx.createBufferQueueSource();
      node.connect(gain);
      const thisNode = node;
      node.onBufferEnded = ({ bufferId }) => {
        if (node !== thisNode || turn === null) return;
        playedMs += bufferMs.get(bufferId) ?? 0;
        playedAt = now();
        bufferMs.delete(bufferId);
        outstanding -= 1;
        cb.onProgress(turn, Math.round(playedMs));
        if (ended && outstanding === 0 && pendingSamples === 0) finishTurn();
      };
    },
    push(pcm) {
      if (!node || ended) return;
      let bytes = new Uint8Array(pcm);
      if (carry) {
        const merged = new Uint8Array(carry.length + bytes.length);
        merged.set(carry);
        merged.set(bytes, carry.length);
        bytes = merged;
        carry = null;
      }
      if (bytes.length % 2 === 1) {
        carry = bytes.slice(bytes.length - 1);
        bytes = bytes.slice(0, bytes.length - 1);
      }
      if (bytes.length === 0) return;
      const samples = int16ToFloat32(bytes.slice().buffer);
      lastLevel = rms(samples);
      pending.push(samples);
      pendingSamples += samples.length;
      if (pendingSamples >= CHUNK_SAMPLES) enqueuePending();
      maybeStart(false);
    },
    end() {
      if (!node || ended) return;
      ended = true;
      enqueuePending();
      maybeStart(true);
      if (outstanding === 0) finishTurn();
    },
    cancel(turnId) {
      if (turnId !== undefined && turnId !== turn) return;
      if (node) {
        node.clearBuffers();
        try {
          node.stop();
        } catch {
          /* already stopped */
        }
      }
      reset();
    },
    duck(on) {
      ducked = on;
      if (gain) gain.gain.value = on ? DUCK_GAIN : 1;
    },
    level() {
      return turn === null ? 0 : lastLevel;
    },
    playedMsNow() {
      if (!started) return 0;
      const queuedMs = (queuedSamples / TTS_RATE) * 1000;
      return Math.min(queuedMs, playedMs + Math.max(0, now() - playedAt));
    },
    receivedMs() {
      return ((queuedSamples + pendingSamples) / TTS_RATE) * 1000;
    },
    complete() {
      return ended;
    },
  };
}
