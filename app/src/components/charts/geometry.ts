// Pure geometry, scales and label maths for the two Skia charts.
//
// Skia cannot render on this Linux host, so every number the charts draw is
// computed here — free of Skia, React and the DOM — and unit-tested against
// the PWA's arithmetic (charts.test.ts). The components below are then a thin
// mapping from these values onto Skia nodes.
//
// Sources ported verbatim: apps/hub/src/components/charts/StackedBars.tsx.
import type { BarBucket, BarSeries } from '../../shared/chartTypes';
import { dark, type TokenName } from '../../theme/tokens.gen';

/**
 * `src/shared/chartTypes.ts` declares only the two fields the shared colour
 * helpers need. The PWA's bucket (StackedBars.tsx:15-20) carries two more, so
 * the chart's prop type extends the shared shape rather than redeclaring it —
 * a `{key, values, total, partial}` object from a screen satisfies both.
 */
export interface StackedBarBucket extends BarBucket {
  total: number;
  partial?: boolean;
}

/**
 * The shared colour helpers return bare TOKEN NAMES, not colours (the
 * PARITY-SHIM in src/shared/seriesColors.ts), while `BarSeries.color` is typed
 * `string` and an API-supplied hex could arrive on it. Resolve what is a token,
 * pass anything else through — `t()` would throw on an unknown name.
 */
export function seriesPaint(color: string, t: (name: TokenName) => string): string {
  return color in dark ? t(color as TokenName) : color;
}

// ---------------------------------------------------------------- StackedBars

/** Surface gap between stacked segments, px — the separator; never a stroke. */
export const GAP = 2;
export const MAX_BAR_W = 24;
export const PLOT_TOP = 4;

export function niceValue(v: number): number {
  if (v <= 0) return 0;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [5, 2.5, 2, 1]) {
    if (mag * m <= v) return mag * m;
  }
  return mag;
}

/** The smallest round number at or above `v`, so the top gridline clears the
 *  tallest bar. Mirror of `niceValue`, which rounds the other way. */
export function niceCeil(v: number): number {
  if (v <= 0) return 0;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5]) {
    if (mag * m >= v) return mag * m;
  }
  return mag * 10;
}

export function fmtGrid(v: number): string {
  if (v >= 100) return `$${Math.round(v)}`;
  if (v >= 1) return `$${v % 1 === 0 ? v : v.toFixed(2)}`;
  return `$${v.toFixed(2)}`;
}

export function roundedTopRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

export interface BarsLayout {
  n: number;
  width: number;
  height: number;
  slot: number;
  barW: number;
  /** Value that maps to the top of the plot. */
  domain: number;
  plotTop: number;
  plotH: number;
  gridLines: number[];
}

export function barsLayout(
  buckets: StackedBarBucket[],
  width: number,
  height: number,
  showGrid = true,
): BarsLayout {
  const n = buckets.length;
  const max = Math.max(...buckets.map((b) => b.total), 0.000001);
  // A gridline the data never reaches is the point of a gridline: `niceValue`
  // rounds DOWN, so the top line always sat below the tallest bar and the
  // biggest number on the chart had nothing to read it against.
  const gridHi = niceCeil(max);
  const gridLines = showGrid && gridHi > 0 ? [gridHi / 2, gridHi] : [];
  const plotH = height - PLOT_TOP;
  const slot = n > 0 ? width / n : width;
  const barW = Math.min(MAX_BAR_W, Math.max(2, slot - 3));
  return {
    n,
    width,
    height,
    slot,
    barW,
    domain: gridHi || max,
    plotTop: PLOT_TOP,
    plotH,
    gridLines,
  };
}

export function barY(v: number, l: BarsLayout): number {
  return l.plotTop + l.plotH * (1 - v / l.domain);
}

export function barX(index: number, l: BarsLayout): number {
  return index * l.slot + (l.slot - l.barW) / 2;
}

export interface BarSegment {
  /** Token name or colour, straight off the series — resolve with seriesPaint. */
  color: string;
  y: number;
  h: number;
}

/** Segments stack upward from the baseline in `series` order; ≤0 is skipped. */
export function bucketSegments(
  bucket: StackedBarBucket,
  series: BarSeries[],
  l: BarsLayout,
): BarSegment[] {
  let yCursor = l.plotTop + l.plotH;
  const segs: BarSegment[] = [];
  // values can be missing when a stale/older API payload is replayed
  // (SW offline cache, deploy skew) — degrade to an empty stack.
  const vals = bucket.values ?? {};
  for (const s of series) {
    const v = vals[s.id] ?? 0;
    if (v <= 0) continue;
    const h = (v / l.domain) * l.plotH;
    yCursor -= h;
    segs.push({ color: s.color, y: yCursor, h: Math.max(h - GAP, 0.5) });
  }
  return segs;
}

export function bucketLabel(
  bucket: StackedBarBucket,
  index: number,
  tickFormat: (key: string, index: number) => string,
  valueFormat: (v: number) => string,
): string {
  return `${tickFormat(bucket.key, index)}: ${valueFormat(bucket.total)}${bucket.partial ? ' (in progress)' : ''}`;
}

/** Tapping the selected bucket clears the selection. */
export function toggleSelection(selected: number | null, index: number): number | null {
  return selected === index ? null : index;
}

/** Axis row under the chart: first, middle (only past 4 buckets), last. */
export function axisTicks(
  buckets: StackedBarBucket[],
  tickFormat: (key: string, index: number) => string,
): { left: string; mid: string | null; right: string } {
  const n = buckets.length;
  const mid = Math.floor(n / 2);
  return {
    left: n > 0 ? tickFormat(buckets[0].key, 0) : '',
    mid: n > 4 ? tickFormat(buckets[mid].key, mid) : null,
    right: n > 1 ? tickFormat(buckets[n - 1].key, n - 1) : '',
  };
}

export function niceTicks(min: number, max: number): number[] {
  const span = max - min || 1;
  const mag = 10 ** Math.floor(Math.log10(span / 2.5));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= 3.5) ?? mag * 10;
  const start = Math.ceil(min / step) * step;
  if (!Number.isFinite(step) || step <= 0 || start + step === start) return [min, max];
  const out: number[] = [];
  for (let v = start; v <= max + 1e-9 && out.length < 64; v += step) out.push(v);
  return out;
}
