// The Aperture: a round field of LED dots that blooms with whoever is talking
// (petrol = you, gold = Xavier), a gold scan line while Xavier thinks, an X
// when idle, a blinking rim while reconnecting — and a ring of 60 gold ticks
// that fills as the reply plays. Pure and worklet-safe: the Skia component
// calls it on the UI thread every frame; jest calls it directly.

export const APERTURE_MODE = {
  off: 0,
  listening: 1,
  thinking: 2,
  speaking: 3,
  reconnecting: 4,
  muted: 5,
} as const;
export type ApertureMode = (typeof APERTURE_MODE)[keyof typeof APERTURE_MODE];

export interface ApertureInput {
  size: number;
  /** ms, monotonic. */
  t: number;
  /** 0..1 voice level of whoever is talking. */
  level: number;
  mode: ApertureMode;
  /** 0..1 share of the current reply already played. */
  progress: number;
  reduceMotion: boolean;
}

export interface Dot {
  x: number;
  y: number;
  r: number;
  /** 0..1 */
  alpha: number;
  /** true = lit in the mode colour, false = the dim base colour. */
  lit: boolean;
}

export interface Tick {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  lit: boolean;
}

export const TICKS = 60;

export function apertureGeometry(size: number): { cx: number; cy: number; R: number; pitch: number } {
  'worklet';
  const R = size * 0.38;
  return { cx: size / 2, cy: size / 2, R, pitch: Math.max(7, R / 12) };
}

export function apertureDots(input: ApertureInput): Dot[] {
  'worklet';
  const { size, level, mode, reduceMotion } = input;
  const t = reduceMotion ? 0 : input.t;
  const { cx, cy, R, pitch } = apertureGeometry(size);
  const out: Dot[] = [];
  const reach = R * (0.22 + Math.min(1, level) * 0.85);
  const scanX = mode === APERTURE_MODE.thinking ? (reduceMotion ? 0 : (((t / 1400) % 1) * 2 - 1) * R) : 0;
  const blink = (Math.sin(t / 420) + 1) / 2;
  const n = Math.floor(R / pitch);
  for (let iy = -n; iy <= n; iy += 1) {
    for (let ix = -n; ix <= n; ix += 1) {
      const x = ix * pitch;
      const y = iy * pitch;
      const r = Math.sqrt(x * x + y * y);
      if (r > R) continue;
      let a = 0;
      if (mode === APERTURE_MODE.listening || mode === APERTURE_MODE.speaking) {
        const ring = 1 - Math.min(1, r / reach);
        a = ring > 0 ? ring * (0.72 + 0.28 * Math.sin(t / 120 + r / 9)) : 0;
      } else if (mode === APERTURE_MODE.thinking) {
        a = Math.max(0, 1 - Math.abs(x - scanX) / (pitch * 2.2));
      } else if (mode === APERTURE_MODE.off || mode === APERTURE_MODE.muted) {
        const onX = Math.abs(Math.abs(x) - Math.abs(y)) < pitch * 0.6 && r < R * 0.45;
        a = onX ? (mode === APERTURE_MODE.muted ? 0.45 : 0.9) : 0;
      } else if (mode === APERTURE_MODE.reconnecting) {
        a = r > R - pitch * 1.5 ? 0.25 + 0.6 * blink : 0;
      }
      const lit = a > 0.08;
      out.push({ x: cx + x, y: cy + y, r: pitch * 0.32, alpha: lit ? Math.min(1, 0.15 + a) : 0.5, lit });
    }
  }
  return out;
}

export function apertureTicks(size: number, progress: number): Tick[] {
  'worklet';
  const { cx, cy, R, pitch } = apertureGeometry(size);
  const out: Tick[] = [];
  const p = Math.max(0, Math.min(1, progress));
  for (let i = 0; i < TICKS; i += 1) {
    const an = -Math.PI / 2 + (i / TICKS) * Math.PI * 2;
    const r1 = R + pitch * 1.6;
    const r2 = r1 + (i % 5 === 0 ? 9 : 5);
    out.push({
      x1: cx + Math.cos(an) * r1,
      y1: cy + Math.sin(an) * r1,
      x2: cx + Math.cos(an) * r2,
      y2: cy + Math.sin(an) * r2,
      lit: i / TICKS < p,
    });
  }
  return out;
}

/** Which words of the reply have been heard, by playback share. */
export function splitHeard(text: string, progress: number): [string, string] {
  const words = text.split(/(\s+)/);
  const total = text.length;
  if (total === 0) return ['', ''];
  const target = Math.max(0, Math.min(1, progress)) * total;
  let at = 0;
  let i = 0;
  while (i < words.length && at + words[i].length / 2 <= target) {
    at += words[i].length;
    i += 1;
  }
  const heard = words.slice(0, i).join('');
  return [heard, text.slice(heard.length)];
}

/** The sentence playback is in right now, split into heard / still to come,
 * for the large "now" line (the whole reply lives in the transcript above). */
export function sentenceAt(text: string, progress: number): [string, string] {
  const [heard] = splitHeard(text, progress);
  const sentences = text.match(/[^.!?…]+[.!?…]*\s*/g) ?? [text];
  let start = 0;
  for (const s of sentences) {
    const end = start + s.length;
    if (heard.length < end || end === text.length) {
      const cut = Math.max(0, heard.length - start);
      return [s.slice(0, cut).trimStart(), s.slice(cut).trimEnd()];
    }
    start = end;
  }
  return ['', text];
}
