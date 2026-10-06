// Live on the native voice-processing engine (modules/live-audio): the same
// mic / player / earcon surface the hook uses with react-native-audio-api,
// so the hook only chooses a path. Audio is 24 kHz mono both ways.
import type { LiveAudioNative, LiveAudioStart } from '../../../modules/live-audio';
import { bytesToBase64 } from '../../terminal/base64';
import { EARCONS, type Earcon } from './earcons';
import { int16ToFloat32, rms, type PcmPlayer } from './player';

export const NATIVE_RATE = 24000;
const BYTES_PER_MS = (NATIVE_RATE * 2) / 1000;
const CHUNK_BYTES = 200 * BYTES_PER_MS;
const PREBUFFER_BYTES = 250 * BYTES_PER_MS;
const TONE_PEAK = 0.12;

const LOOKUP = new Int16Array(128).fill(-1);
'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((c, i) => {
  LOOKUP[c.charCodeAt(0)] = i;
});

export function base64ToBytes(b64: string): Uint8Array {
  let len = b64.length;
  while (len > 0 && b64[len - 1] === '=') len -= 1;
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < len; i += 1) {
    const v = LOOKUP[b64.charCodeAt(i)];
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o] = (acc >> bits) & 0xff;
      o += 1;
    }
  }
  return o === out.length ? out : out.slice(0, o);
}

/** The earcon as 16-bit PCM: the oscillator envelope earcons.ts schedules,
 * rendered so it plays through the voice-processing engine. */
export function earconPcm(kind: Earcon): Uint8Array {
  const notes = EARCONS[kind];
  const total = Math.max(...notes.map(([, at, dur]) => at + dur)) + 0.02;
  const samples = new Float32Array(Math.ceil(total * NATIVE_RATE));
  for (const [freq, at, dur] of notes) {
    const from = Math.round(at * NATIVE_RATE);
    const count = Math.round(dur * NATIVE_RATE);
    const attack = Math.round(0.01 * NATIVE_RATE);
    for (let i = 0; i < count; i += 1) {
      const env = i < attack ? i / attack : Math.max(0, (count - i) / (count - attack));
      samples[from + i] += TONE_PEAK * env * Math.sin((2 * Math.PI * freq * i) / NATIVE_RATE);
    }
  }
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767);
  return new Uint8Array(out.buffer);
}

export interface NativeLiveAudio {
  /** Session + engine up; mic frames flow from here until stop(). */
  start(onFrame: (pcm: ArrayBuffer, level: number) => void): Promise<LiveAudioStart>;
  stop(): Promise<void>;
  createPlayer(cb: { onProgress(turnId: number, playedMs: number): void; onDrained(turnId: number): void }): PcmPlayer;
  tone(kind: Earcon): void;
  onDiag(cb: (message: string) => void): { remove(): void };
  onInterruption(cb: (began: boolean) => void): { remove(): void };
}

export function createNativeLiveAudio(mod: LiveAudioNative, now: () => number = Date.now): NativeLiveAudio {
  const subs: { remove(): void }[] = [];
  const tones = new Map<Earcon, string>();
  let nextTag = 0;

  return {
    async start(onFrame) {
      // A session ended and restarted within moments never ran stop(): drop its
      // listeners, or every mic frame would be sent twice.
      for (const s of subs.splice(0)) s.remove();
      if (!(await mod.requestPermission())) throw new Error('Microphone permission is required for Live.');
      subs.push(
        mod.addListener('onFrame', (e) => {
          const bytes = base64ToBytes(e.pcm);
          onFrame(bytes.buffer as ArrayBuffer, e.level);
        }),
      );
      return mod.start();
    },
    async stop() {
      for (const s of subs.splice(0)) s.remove();
      await mod.stop();
    },
    tone(kind) {
      let pcm = tones.get(kind);
      if (!pcm) {
        pcm = bytesToBase64(earconPcm(kind));
        tones.set(kind, pcm);
      }
      mod.playTone(pcm);
    },
    onDiag(cb) {
      return mod.addListener('onDiag', (e) => cb(e.message));
    },
    onInterruption(cb) {
      return mod.addListener('onInterruption', (e) => cb(e.type === 'began'));
    },
    createPlayer(cb) {
      let turn: number | null = null;
      let tag = -1;
      let pending: Uint8Array[] = [];
      let pendingBytes = 0;
      let carry: Uint8Array | null = null;
      let queuedMs = 0;
      let playedMs = 0;
      let playedAt = 0;
      let started = false;
      let ended = false;
      let outstanding = 0;
      let lastLevel = 0;

      function reset(): void {
        turn = null;
        pending = [];
        pendingBytes = 0;
        carry = null;
        queuedMs = 0;
        playedMs = 0;
        playedAt = 0;
        started = false;
        ended = false;
        outstanding = 0;
        lastLevel = 0;
      }

      function flush(): void {
        if (pendingBytes === 0) return;
        const joined = new Uint8Array(pendingBytes);
        let at = 0;
        for (const p of pending) {
          joined.set(p, at);
          at += p.length;
        }
        pending = [];
        pendingBytes = 0;
        mod.enqueue(bytesToBase64(joined), tag);
        outstanding += 1;
        queuedMs += joined.length / BYTES_PER_MS;
        if (!started) {
          started = true;
          playedAt = now();
        }
      }

      function finish(): void {
        const t = turn;
        reset();
        if (t !== null) cb.onDrained(t);
      }

      subs.push(
        mod.addListener('onPlayed', (e) => {
          if (e.tag !== tag || turn === null) return;
          playedMs += e.ms;
          playedAt = now();
          outstanding -= 1;
          cb.onProgress(turn, Math.round(playedMs));
          if (ended && outstanding === 0 && pendingBytes === 0) finish();
        }),
      );

      return {
        start(turnId) {
          if (turn !== null) mod.clear();
          reset();
          turn = turnId;
          nextTag += 1;
          tag = nextTag;
        },
        push(pcm) {
          if (turn === null || ended) return;
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
          lastLevel = rms(int16ToFloat32(bytes.slice().buffer));
          pending.push(bytes);
          pendingBytes += bytes.length;
          if (pendingBytes >= (started ? CHUNK_BYTES : PREBUFFER_BYTES)) flush();
        },
        end() {
          if (turn === null || ended) return;
          ended = true;
          flush();
          if (outstanding === 0) finish();
        },
        cancel(turnId) {
          if (turnId !== undefined && turnId !== turn) return;
          if (turn !== null) mod.clear();
          reset();
        },
        duck(on) {
          mod.setDucked(on);
        },
        level() {
          return turn === null ? 0 : lastLevel;
        },
        playedMsNow() {
          if (!started) return 0;
          return Math.min(queuedMs, playedMs + Math.max(0, now() - playedAt));
        },
        receivedMs() {
          return queuedMs + pendingBytes / BYTES_PER_MS;
        },
        complete() {
          return ended;
        },
      };
    },
  };
}
