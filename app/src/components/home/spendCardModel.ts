// SpendCard's data shaping (SpendCard.tsx:9-51,88-95). Separate from the
// component because the component mounts StackedBars, and StackedBars is Skia.
import type { SpendPoint, SpendSummary, SpendTimeseries } from '../../lib/types';
import type { BarSeries } from '../../shared/chartTypes';
import type { StackedBarBucket } from '../charts/geometry';
import { providerColor } from '../../shared/seriesColors';

/** `12a`, `1a` … `11a`, `12p`, `1p` … `11p` from an ISO hour bucket. */
export function fmtHour(bucket: string): string {
  const h = Number(bucket.slice(11, 13));
  if (Number.isNaN(h)) return bucket;
  return h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? `${h}a` : `${h - 12}p`;
}

/** The summary's own total when it has landed, else the sum of the buckets. */
export function todayTotal(points: SpendPoint[], todaySummary: SpendSummary | undefined): number {
  return todaySummary?.total_usd ?? points.reduce((s, p) => s + p.spend_usd, 0);
}

/** Providers, biggest spender first (SpendCard.tsx:29-31). */
export function providersRanked(todaySummary: SpendSummary | undefined): string[] {
  return Object.keys(todaySummary?.by_provider ?? {}).sort(
    (a, b) => (todaySummary?.by_provider[b] ?? 0) - (todaySummary?.by_provider[a] ?? 0),
  );
}

/**
 * `per_provider` can be absent on a stale payload (the PWA's SW replay / a
 * deploy skew; here, the AsyncStorage-persisted cache plays the same role) —
 * fall back to one flat series rather than draw an empty stack.
 */
export function hasProviderSplit(points: SpendPoint[], providers: string[]): boolean {
  return providers.length > 0 && points.every((p) => Boolean(p.per_provider));
}

export function spendSeries(points: SpendPoint[], todaySummary: SpendSummary | undefined): BarSeries[] {
  const providers = providersRanked(todaySummary);
  return hasProviderSplit(points, providers)
    ? providers.map((p) => ({ id: p, label: p, color: providerColor(p) }))
    : [{ id: 'total', label: 'spend', color: 'series-1' }];
}

/** The last bucket is the hour in progress — StackedBars dims it to 40%. */
export function spendBuckets(points: SpendPoint[], todaySummary: SpendSummary | undefined): StackedBarBucket[] {
  const split = hasProviderSplit(points, providersRanked(todaySummary));
  return points.map((p, i) => ({
    key: p.date,
    total: p.spend_usd,
    values: split ? p.per_provider : { total: p.spend_usd },
    partial: i === points.length - 1,
  }));
}

export function selectedPoint(points: SpendPoint[], selected: number | null): SpendPoint | null {
  return selected !== null && selected < points.length ? points[selected] : null;
}

/** Models with spend in the selected hour, biggest first. */
export function selectedModels(point: SpendPoint | null): [string, number][] {
  if (!point) return [];
  return Object.entries(point.per_model)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
}

/** `today · 12 sess` — the eyebrow beside the gold numeral. */
export function todayEyebrow(todaySummary: SpendSummary | undefined): string {
  return `today${todaySummary ? ` · ${todaySummary.sessions} sess` : ''}`;
}

/** The selected hour's header sentence (SpendCard.tsx:91-95). */
export function selectionHeader(point: SpendPoint, fmtTokens: (v: number) => string): string {
  return (
    fmtHour(point.date) +
    (point.sessions != null ? ` · ${point.sessions} sess` : '') +
    (point.tokens ? ` · ${fmtTokens(point.tokens.input)} in` : '')
  );
}

export function pointsOf(today: SpendTimeseries | undefined): SpendPoint[] {
  return today?.points ?? [];
}
