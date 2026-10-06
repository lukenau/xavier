// Pure derivations behind the Cost page (apps/hub/src/routes/Cost.tsx, as it
// stands after the 2026-09-11 rework: 4ea5691 → 9134121). Everything here is
// arithmetic, date labelling or sentence building — no React, no Skia — so the
// window/bucket maths can be asserted without a renderer, and the .tsx below it
// stays a layout file.
//
// Copy strings are the PWA's verbatim, including the en dash in the range line,
// the em dashes in the two warnings and the '–' placeholder for a null session
// count.
import type { RecurringCosts } from '../../lib/types';
import type { BarSeries } from '../../shared/chartTypes';
import type { StackedBarBucket } from '../charts/geometry';
import { fmtTokens, fmtUsd, foldValues, modelSeries, providerColor, shortModel } from '../../shared/seriesColors';
import type {
  CronCostsJob,
  CronCostsReport,
  CronDayCost,
  OpenRouterCredits,
  OpenRouterKeyRow,
  SpendModelRow,
  SpendPoint,
  SpendSummary,
} from '../../lib/types';

export type SpendWindow = 'today' | '7d' | '30d' | 'mtd';
export type StackBy = 'models' | 'providers';

export const WINDOWS: SpendWindow[] = ['today', '7d', '30d', 'mtd'];
export const STACK_MODES: StackBy[] = ['models', 'providers'];

export function fmtDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Bucket keys: hour '2026-07-18T14:00' · day '2026-07-18' · week = Monday ISO · month '2026-07'.
export function fmtBucket(key: string, granularity: string, index: number): string {
  if (granularity === 'hour') {
    const h = Number(key.slice(11, 13));
    if (Number.isNaN(h)) return key;
    const label = h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? `${h}a` : `${h - 12}p`;
    // Day prefix on the first tick and at midnight so a cross-midnight axis stays readable.
    if (index === 0 || h === 0) {
      const d = new Date(`${key.slice(0, 10)}T00:00:00`);
      const day = Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { weekday: 'short' });
      return `${day} ${label}`;
    }
    return label;
  }
  if (granularity === 'day') return fmtDay(`${key}T00:00:00`);
  if (granularity === 'week') return `wk ${fmtDay(`${key}T00:00:00`)}`;
  if (granularity === 'month') {
    const d = new Date(`${key}-01T00:00:00`);
    return Number.isNaN(d.getTime()) ? key : d.toLocaleDateString([], { month: 'short' });
  }
  return key;
}

/** The bucket-detail header: on a day axis the weekday leads the date (8e5d798). */
export function bucketHeaderLabel(key: string, granularity: string, index: number): string {
  const tick = fmtBucket(key, granularity, index);
  if (granularity !== 'day') return tick;
  const weekday = new Date(`${key}T00:00:00`).toLocaleDateString([], { weekday: 'short' });
  return `${weekday} ${tick}`;
}

/** Range line under the pills. A single space while the summary is loading, to keep the height. */
export function rangeLabel(s: SpendSummary | undefined): string {
  return s?.range ? `${fmtDay(s.range.start)} – ${fmtDay(s.range.end)}` : ' ';
}

export type DeltaDirection = 'flat' | 'up' | 'down';

export interface DeltaChipParts {
  direction: DeltaDirection;
  arrow: string;
  text: string;
}

/**
 * Spend up = costs more = the down colour; spend down = the up colour.
 * Direction × goodness, resolved by the caller (the tone token is a colour).
 */
export function deltaChipParts(
  deltaPct: number | null,
  prevRange: { start: string; end: string } | null,
): DeltaChipParts | null {
  if (deltaPct === null || !prevRange) return null;
  const up = deltaPct > 0;
  const flat = Math.abs(deltaPct) < 0.05;
  const label =
    prevRange.start.slice(0, 10) === prevRange.end.slice(0, 10)
      ? fmtDay(prevRange.start)
      : `${fmtDay(prevRange.start)}–${fmtDay(prevRange.end)}`;
  const arrow = flat ? '→' : up ? '↑' : '↓';
  return {
    direction: flat ? 'flat' : up ? 'up' : 'down',
    arrow,
    text: `${arrow} ${Math.abs(deltaPct).toFixed(0)}% vs ${label}`,
  };
}

/** Today's burn rate: spend so far divided by hours since device-local midnight (floor 0.5h). */
export function hourlyRate(totalUsd: number, now: number = Date.now()): number {
  return totalUsd / Math.max((now - new Date().setHours(0, 0, 0, 0)) / 3_600_000, 0.5);
}

/** Hero sub-line. Null when the payload carries no token block. */
export function heroTokensLine(
  s: SpendSummary,
  window: SpendWindow,
  now: number = Date.now(),
): string | null {
  if (!s.tokens) return null;
  const head = `${s.sessions ?? '–'} session${s.sessions === 1 ? '' : 's'} · ${fmtTokens(s.tokens.input)} in · ${fmtTokens(s.tokens.output)} out`;
  if (window === 'today' && s.total_usd > 0) return `${head} · ${fmtUsd(hourlyRate(s.total_usd, now))}/hr`;
  return head;
}

/** by_provider entries worth a strip segment: positive, richest first. */
export function providerEntries(byProvider: Record<string, number>): [string, number][] {
  return Object.entries(byProvider)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
}

/**
 * Sessions that recorded no model and no tokens price to nothing and lose
 * nothing — warning about them claims uncounted spend that does not exist
 * (5dd60c3).
 */
export function unpricedEntries(s: SpendSummary | undefined): SpendSummary['unpriced'] {
  return (s?.unpriced ?? []).filter((u) => u.input + u.output + u.cache_read > 0);
}

export function unpricedHeadline(n: number): string {
  return `${n} model${n === 1 ? '' : 's'} unpriced — spend not counted`;
}

export function unpricedDetail(rows: SpendSummary['unpriced']): string {
  return rows.map((u) => `${shortModel(u.model)} (${fmtTokens(u.input + u.output)} tok)`).join(' · ');
}

export function costSeries(s: SpendSummary | undefined, stackBy: StackBy): BarSeries[] {
  if (stackBy === 'providers') {
    const providers = Object.keys(s?.by_provider ?? {}).sort(
      (a, b) => (s?.by_provider[b] ?? 0) - (s?.by_provider[a] ?? 0),
    );
    return providers.map((p) => ({ id: p, label: p, color: providerColor(p) }));
  }
  return modelSeries(s?.models ?? []);
}

/**
 * `??` guards: an older API payload (deploy skew, offline replay) lacks the v2
 * fields — the chart degrades to flat totals instead of crashing.
 */
export function costBuckets(points: SpendPoint[], stackBy: StackBy, series: BarSeries[]): StackedBarBucket[] {
  return points.map((p, i) => ({
    key: p.date,
    total: p.spend_usd,
    values:
      stackBy === 'providers'
        ? (p.per_provider ?? { other: p.spend_usd })
        : foldValues(p.per_model ?? {}, series.map((x) => x.id)),
    partial: i === points.length - 1,
  }));
}

/** Legend shows only the series a bucket actually carries. */
export function usedSeries(series: BarSeries[], buckets: StackedBarBucket[]): BarSeries[] {
  return series.filter((x) => buckets.some((b) => (b.values[x.id] ?? 0) > 0));
}

export function lastActivePoint(points: SpendPoint[]): SpendPoint | undefined {
  return [...points].reverse().find((p) => p.spend_usd > 0);
}

export function peakLabel(points: SpendPoint[]): string {
  return `peak ${fmtUsd(Math.max(...points.map((p) => p.spend_usd)))}`;
}

export function latestLabel(points: SpendPoint[], point: SpendPoint, granularity: string): string {
  return `latest ${fmtBucket(point.date, granularity, points.indexOf(point))} · ${fmtUsd(point.spend_usd)}`;
}

/** Chart step buttons clamp rather than wrap (Cost.tsx's onStep). */
export function stepBucket(selected: number | null, dir: -1 | 1, count: number): number {
  return Math.min(Math.max((selected ?? 0) + dir, 0), count - 1);
}

/** Bucket-detail rows: per_model entries with spend, richest first. */
export function bucketModelRows(point: SpendPoint): [string, number][] {
  return Object.entries(point.per_model)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
}

export function bucketTokensLine(point: SpendPoint): string {
  return `${point.sessions ?? '–'} session${point.sessions === 1 ? '' : 's'} · ${fmtTokens(point.tokens.input)} in · ${fmtTokens(point.tokens.output)} out · ${fmtTokens(point.tokens.cache_read)} cached`;
}

export function modelShare(row: SpendModelRow, windowTotal: number): number {
  return windowTotal > 0 ? (row.total_spend / windowTotal) * 100 : 0;
}

export function cacheHitRatio(row: SpendModelRow): number | null {
  const denom = row.input + row.cache_read;
  return denom > 0 ? (row.cache_read / denom) * 100 : null;
}

export function modelMetaLine(row: SpendModelRow, windowTotal: number): string {
  const share = modelShare(row, windowTotal);
  return `${share.toFixed(0)}%${row.sessions != null ? ` · ${row.sessions} sess` : ''} · ${fmtTokens(row.input ?? 0)} in · ${fmtTokens(row.output ?? 0)} out · ${fmtTokens(row.cache_read ?? 0)} cached`;
}

export function modelDetailLine(row: SpendModelRow): string {
  const ratio = cacheHitRatio(row);
  const prefix = ratio !== null ? `cache hit ${ratio.toFixed(0)}% · ` : '';
  return `${prefix}${fmtTokens(row.cache_write ?? 0)} cache-write · provider ${row.provider}`;
}

export function modelAliasLine(row: SpendModelRow): string | null {
  return row.aliases && row.aliases.length > 0 ? `ids: ${row.aliases.join(' · ')}` : null;
}

/**
 * Per-key spend for the selected window. Window spend is summed server-side
 * from the snapshot intervals inside it, so every key has a figure from its
 * first snapshot on; lifetime spend rides alongside for scale (9134121).
 */
export interface PerKeyRow {
  id: string;
  usd: number;
  total: number;
}

export function perKeyRows(keys: OpenRouterKeyRow[], window: SpendWindow): PerKeyRow[] {
  return keys.map((k) => ({ id: k.name, usd: k.windows?.[window]?.usd ?? 0, total: k.usage ?? 0 }));
}

// --- Scheduled jobs ---------------------------------------------------------
// Ledger-honest: runs whose cost_status is 'unknown' say "cost unknown", never
// $0.00. Labels are job names (plain words), never ids.

export interface CronSplit {
  active: CronCostsJob[];
  scriptJobs: CronCostsJob[];
}

export function cronSplit(report: CronCostsReport): CronSplit {
  // jobs / week may be absent on an unwired instance — degrade to empty lists.
  return {
    active: (report.jobs ?? []).filter((j) => (j.week?.runs ?? 0) > 0),
    scriptJobs: (report.jobs ?? []).filter((j) => j.no_agent && (j.week?.runs ?? 0) === 0),
  };
}

export function cronCostLabel(entry: { cost_usd: number; unknown_runs: number }): string {
  return entry.cost_usd > 0 || entry.unknown_runs === 0 ? fmtUsd(entry.cost_usd) : 'cost unknown';
}

export function cronJobMetaLine(job: CronCostsJob): string {
  const w = job.week;
  const known = w.cost_usd > 0 || w.unknown_runs === 0;
  const model = job.last_run?.model ? shortModel(job.last_run.model) : 'no model';
  const unknownSuffix = known && w.unknown_runs > 0 ? ` · ${w.unknown_runs} cost unknown` : '';
  return `${w.runs} run${w.runs === 1 ? '' : 's'} · ${fmtTokens(w.tokens)} tok · ${model}${unknownSuffix}`;
}

/** Newest day first. */
export function cronDayEntries(job: CronCostsJob): [string, CronDayCost][] {
  return Object.entries(job.week.days).sort((a, b) => (a[0] < b[0] ? 1 : -1));
}

export function cronDayLine(day: string, d: CronDayCost): string {
  const unknownSuffix = d.unknown_runs > 0 ? ` · ${d.unknown_runs} cost unknown` : '';
  return `${fmtDay(`${day}T00:00:00`)} · ${d.runs} run${d.runs === 1 ? '' : 's'}${unknownSuffix}`;
}

export function cronScriptFooter(n: number): string {
  return `+ ${n} script job${n === 1 ? '' : 's'} · $0 LLM · no model`;
}

// --- OpenRouter account footer ----------------------------------------------

export function cacheSummaryLine(cache: SpendSummary['cache'], paidUsd: number): string {
  const off = cache.saved_pct > 0 ? ` (${cache.saved_pct.toFixed(0)}% off)` : '';
  return `would have cost ${fmtUsd(cache.would_have_cost_usd)} → paid ${fmtUsd(paidUsd)}${off}`;
}

export function isLowBalance(credits: OpenRouterCredits): boolean {
  return credits.balance < 10;
}

export function creditsUsedLine(credits: OpenRouterCredits): string {
  const low = isLowBalance(credits) ? ' — running low, top up' : '';
  return `used ${fmtUsd(credits.total_usage)} of ${fmtUsd(credits.total_credits)} prepaid${low}`;
}

export function creditsMetersLine(credits: OpenRouterCredits): string | null {
  if (credits.usage_monthly == null) return null;
  return `${fmtUsd(credits.usage_daily ?? 0)} today · ${fmtUsd(credits.usage_monthly)} this month`;
}

export function creditsBarPct(credits: OpenRouterCredits): number {
  return Math.min(100, (credits.total_usage / Math.max(credits.total_credits, 0.01)) * 100);
}

// ── Recurring spend (page foot) ──────────────────────────────────────────────
// The flat charges under the estate, prorated by the server onto the same span
// the window pills resolve. Rendered as its own total, never added to the hero:
// metered usage and flat subscriptions are different kinds of number.

export interface RecurringRow {
  id: string;
  label: string;
  windowUsd: string;
  sourceTail: string;
}

export function recurringRows(report: RecurringCosts): RecurringRow[] {
  // items may be absent on an unwired instance — degrade to an empty list.
  return (report.items ?? []).map((it) => ({
    id: it.id,
    label: it.label,
    windowUsd: fmtUsd(it.window_usd),
    sourceTail: ` · ${fmtUsd(it.amount_usd)}/${it.cadence === 'annual' ? 'yr' : 'mo'}`,
  }));
}

export function recurringHeadLabel(window: SpendWindow): string {
  return `fixed · ${window}`;
}

export function recurringFootnote(report: RecurringCosts): string {
  const rate = `${fmtUsd(report.total_monthly_usd)}/mo run-rate`;
  return (report.excludes ?? []).length > 0
    ? `${rate} · excludes ${(report.excludes ?? []).join(', ')} — already metered above`
    : rate;
}
