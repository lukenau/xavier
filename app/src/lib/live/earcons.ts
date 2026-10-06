// Short tones that say what Live is doing without a look at the screen:
// synthesised with an oscillator through the same AudioContext as the reply,
// so they share the voice session and its echo path.

export type Earcon = 'start' | 'heard' | 'working' | 'end';

interface OscLike {
  type: string;
  frequency: { setValueAtTime(v: number, t: number): void };
  connect(dest: unknown): void;
  start(t: number): void;
  stop(t: number): void;
}
interface EnvLike {
  gain: { setValueAtTime(v: number, t: number): void; linearRampToValueAtTime(v: number, t: number): void };
  connect(dest: unknown): void;
}
export interface ToneContextLike {
  currentTime: number;
  destination: unknown;
  createOscillator(): OscLike;
  createGain(): EnvLike;
}

/** Each tone is a list of [frequency Hz, start offset s, duration s]. */
export const EARCONS: Record<Earcon, [number, number, number][]> = {
  start: [[660, 0, 0.09], [990, 0.1, 0.12]],
  heard: [[880, 0, 0.07]],
  working: [[523, 0, 0.05]],
  end: [[990, 0, 0.09], [660, 0.1, 0.14]],
};

const PEAK = 0.12;

export function playEarcon(ctx: ToneContextLike, kind: Earcon): void {
  const now = ctx.currentTime;
  for (const [freq, at, dur] of EARCONS[kind]) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now + at);
    env.gain.setValueAtTime(0, now + at);
    env.gain.linearRampToValueAtTime(PEAK, now + at + 0.01);
    env.gain.linearRampToValueAtTime(0, now + at + dur);
    osc.connect(env);
    env.connect(ctx.destination);
    osc.start(now + at);
    osc.stop(now + at + dur + 0.02);
  }
}
