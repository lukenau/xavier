// Pure geometry for the generic line chart, Skia-free in the same way
// geometry.ts is: every number LineChart.tsx draws is computed and unit-tested
// here, and the component is a thin mapping onto Skia nodes.
//
// EquityChart's maths lives in geometry.ts (`CurvePoint[]`, a fixed 360×150
// viewBox, dollar labels). This is the same
// approach over the widget catalog's `{series, buckets}` shape: many series,
// measured width, no idea what the numbers mean.
import { niceTicks } from './geometry';

export const LINE_M = { l: 42, r: 8, t: 10, b: 8 };

export interface LineBucket {
  key: string;
  values: Record<string, number>;
}

export interface LinePoint {
  index: number;
  value: number;
  x: number;
  y: number;
}

export interface LineSeriesLayout {
  id: string;
  points: LinePoint[];
  /** null below two points, where there is nothing to stroke. */
  path: string | null;
}

export interface LineLayout {
  n: number;
  width: number;
  height: number;
  dMin: number;
  dMax: number;
  ticks: number[];
  series: LineSeriesLayout[];
}

/**
 * A flat series and a single point both collapse the domain to zero width, and
 * every y below would divide by it. The pad is derived from the span, then the
 * magnitude, then 1 — so it is always positive and `dMax > dMin` holds.
 */
export function lineDomain(buckets: LineBucket[], seriesIds: string[]): { dMin: number; dMax: number } {
  const values: number[] = [];
  for (const bucket of buckets) {
    for (const id of seriesIds) {
      const v = bucket.values[id];
      if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
    }
  }
  if (values.length === 0) return { dMin: 0, dMax: 1 };
  const vMin = Math.min(...values);
  const vMax = Math.max(...values);
  const pad = (vMax - vMin || Math.abs(vMax) * 0.02 || 1) * 0.1;
  return { dMin: vMin - pad, dMax: vMax + pad };
}

/** A lone point sits in the middle of the plot rather than against the axis. */
export function lineX(index: number, n: number, width: number): number {
  const left = LINE_M.l;
  const right = width - LINE_M.r;
  if (n <= 1) return (left + right) / 2;
  return left + (index / (n - 1)) * (right - left);
}

export function lineY(value: number, dMin: number, dMax: number, height: number): number {
  const span = dMax - dMin || 1;
  return LINE_M.t + (1 - (value - dMin) / span) * (height - LINE_M.t - LINE_M.b);
}

export function linePath(points: { x: number; y: number }[]): string | null {
  if (points.length < 2) return null;
  return `M${points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L')}`;
}

export function lineLayout(
  buckets: LineBucket[],
  seriesIds: string[],
  width: number,
  height: number,
): LineLayout {
  const { dMin, dMax } = lineDomain(buckets, seriesIds);
  const n = buckets.length;
  const series = seriesIds.map((id) => {
    const points: LinePoint[] = [];
    buckets.forEach((bucket, index) => {
      const value = bucket.values[id];
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      points.push({
        index,
        value,
        x: lineX(index, n, width),
        y: lineY(value, dMin, dMax, height),
      });
    });
    return { id, points, path: linePath(points) };
  });
  return { n, width, height, dMin, dMax, ticks: niceTicks(dMin, dMax), series };
}

/** Axis row under the chart: first, middle (only past 4 buckets), last. */
export function lineAxisTicks(
  buckets: LineBucket[],
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
