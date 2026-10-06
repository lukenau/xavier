// The maths behind the weather widget, kept out of the view so the two things
// most likely to be wrong — where a day's bar sits, and what colour a
// temperature is — are testable without rendering anything.
//
// The idea is Apple Weather's daily list, which the user asked for by name: each
// day's low→high is drawn as a segment INSIDE the whole range the week covers,
// so a cold day is a short bar on the left and a warm one a long bar on the
// right, and the shape of the week reads before any number does.
//
// Two departures from Apple, both forced and both fine:
//
// * The bar is stepped, not a smooth gradient. A gradient needs
//   expo-linear-gradient, a native module, which would move the OTA
//   fingerprint and strand this behind a TestFlight build. Discrete steps are
//   also more honest — each step is a degree band rather than a blur.
// * The colours are theme tokens rather than Apple's fixed ramp, so the same
//   bar works on the light and dark card without a second palette.
import type { TokenName } from '../theme/tokens.gen';

/** Cold to hot, as fills rather than as text.
 *
 * theme-exempt (whole block below): the stops are hex literals on purpose
 * rather than theme tokens, and the doc line naming `accent`'s value quotes a
 * colour for context instead of rendering one. The `theme-exempt` markers are
 * what check-no-raw-color.mjs reads; the reasoning is in this paragraph.
 *
 * The first cut took these from the theme's own tokens, and in light mode they
 * came out muddy — `accent` is #834b00 there, a brown, because it is chosen to
 * be READ on a pale ground (the user, 2026-09-23: "the colors are too dark in light
 * mode"). A bar is not read, it is seen: it wants saturation at the same
 * lightness as the ground, not contrast against it. Dark mode keeps the token
 * values, which were already vivid.
 */
const RAMP: Record<'light' | 'dark', string[]> = {
  light: ['#2e86c8', '#2e9e57', '#e0a032', '#dd5b2a'], // theme-exempt: the ramp itself, see above
  dark: ['#5cc4f2', '#4ade80', '#f0ab5e', '#ff8350'], // theme-exempt: the ramp itself, see above
};

/** The colour of one point on the ramp, 0 (coldest) to 1 (hottest). */
export function heatColor(fraction: number, scheme: 'light' | 'dark'): string {
  const stops = RAMP[scheme] ?? RAMP.dark;
  const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  const scaled = clamped * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  return mixHex(stops[index], stops[index + 1], scaled - index);
}

/** Water, for a chance of rain and a snowflake — the same rule as the ramp. */
export function waterColor(scheme: 'light' | 'dark'): string {
  return scheme === 'light' ? '#2e86c8' : '#5cc4f2'; // theme-exempt: the ramp's cold stop, see RAMP
}

/** The sun and moon. `accent` is a brown in light mode, which is not a sun. */
export function sunColor(scheme: 'light' | 'dark'): string {
  return scheme === 'light' ? '#e0a032' : '#f0ab5e'; // theme-exempt: the ramp's warm stop, see RAMP
}

/** Blend two resolved hex colours. The caller resolves the tokens, because
 * only it knows which theme is on screen. */
export function mixHex(from: string, to: string, mix: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  if (!a || !b) return from;
  const t = Math.min(1, Math.max(0, mix));
  const channel = (i: number) => Math.round(a[i] + (b[i] - a[i]) * t);
  return `#${[0, 1, 2].map((i) => channel(i).toString(16).padStart(2, '0')).join('')}`;
}

function parseHex(value: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export interface Span {
  low: number | null;
  high: number | null;
}

const isDegrees = (value: number | null): value is number => value !== null && Number.isFinite(value);

/** The coldest and warmest the whole set reaches — the scale every bar is
 * drawn against. A flat day (every low and high the same) would divide by
 * zero, so it gets a degree of room either side. */
export function temperatureScale(spans: Span[]): { min: number; max: number } {
  const lows = spans.map((s) => s.low).filter(isDegrees);
  const highs = spans.map((s) => s.high).filter(isDegrees);
  if (lows.length === 0 || highs.length === 0) return { min: 0, max: 1 };
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  return max - min < 1 ? { min: min - 1, max: max + 1 } : { min, max };
}

export interface BarSegment {
  /** 0..1 along the ramp — the caller turns this into a colour. */
  heat: number;
  filled: boolean;
}

export const BAR_STEPS = 24;

/** One day's bar: which steps are inside its low→high, and how hot each is.
 * `steps` is fixed rather than derived from width so a row's segments line up
 * with every other row's, which is what makes the column readable. */
export function bar(span: Span, scale: { min: number; max: number }, steps: number = BAR_STEPS): BarSegment[] {
  // A day with no range (rain only) keeps its track and draws nothing on it.
  if (span.low === null || span.high === null) {
    return Array.from({ length: steps }, (_, i) => ({ heat: (i + 0.5) / steps, filled: false }));
  }
  const width = scale.max - scale.min || 1;
  const from = (Math.min(span.low, span.high) - scale.min) / width;
  const to = (Math.max(span.low, span.high) - scale.min) / width;
  const segments = Array.from({ length: steps }, (_, i) => {
    const at = (i + 0.5) / steps;
    return { heat: at, filled: at >= from && at <= to };
  });
  // A day whose low and high are the same degree covers no step centre at all
  // and drew nothing. One step is the smallest true thing to draw.
  if (!segments.some((s) => s.filled)) {
    const middle = (from + to) / 2;
    const nearest = Math.min(steps - 1, Math.max(0, Math.round(middle * steps - 0.5)));
    segments[nearest].filled = true;
  }
  return segments;
}

/** Where the current temperature sits along the bar, as a fraction, or null
 * when it is not inside the day being drawn — only today gets the dot. */
export function nowAt(temp: number | null, span: Span, scale: { min: number; max: number }): number | null {
  if (temp === null || !Number.isFinite(temp)) return null;
  if (span.low === null || span.high === null) return null;
  if (temp < Math.min(span.low, span.high) || temp > Math.max(span.low, span.high)) return null;
  const width = scale.max - scale.min || 1;
  return Math.min(1, Math.max(0, (temp - scale.min) / width));
}

export type Condition =
  | 'clear'
  | 'clear_night'
  | 'partly_cloudy'
  | 'partly_cloudy_night'
  | 'cloudy'
  | 'rain'
  | 'snow'
  | 'storm'
  | 'wind'
  | 'fog';

const CONDITIONS: Condition[] = [
  'clear', 'clear_night', 'partly_cloudy', 'partly_cloudy_night',
  'cloudy', 'rain', 'snow', 'storm', 'wind', 'fog',
];

/** Every word a forecast might use for the same sky. A condition this does not
 * know draws as cloudy rather than as a hole. */
const ALIASES: Record<string, Condition> = {
  sunny: 'clear',
  sun: 'clear',
  fair: 'clear',
  mostly_clear: 'clear',
  moon: 'clear_night',
  clearnight: 'clear_night',
  night: 'clear_night',
  partly_sunny: 'partly_cloudy',
  mostly_sunny: 'partly_cloudy',
  partly: 'partly_cloudy',
  mostly_cloudy: 'cloudy',
  overcast: 'cloudy',
  clouds: 'cloudy',
  cloud: 'cloudy',
  showers: 'rain',
  rainy: 'rain',
  drizzle: 'rain',
  sleet: 'snow',
  snowy: 'snow',
  flurries: 'snow',
  thunderstorm: 'storm',
  thunder: 'storm',
  storms: 'storm',
  windy: 'wind',
  breezy: 'wind',
  haze: 'fog',
  mist: 'fog',
  foggy: 'fog',
};

export function normaliseCondition(raw: unknown, isNight = false): Condition {
  if (typeof raw !== 'string' || !raw.trim()) return isNight ? 'clear_night' : 'cloudy';
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const direct = CONDITIONS.find((c) => c === key);
  const found = direct ?? ALIASES[key] ?? ALIASES[key.replace(/_/g, '')] ?? null;
  if (found === null) return isNight ? 'clear_night' : 'cloudy';
  // A daytime word in a night row still draws at night, where that matters.
  if (isNight && found === 'clear') return 'clear_night';
  if (isNight && found === 'partly_cloudy') return 'partly_cloudy_night';
  return found;
}

/** `58` → `58°`, and a missing reading stays missing rather than reading 0. */
export function degrees(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${Math.round(value)}°`;
}
