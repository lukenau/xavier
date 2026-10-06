// VERBATIM COPY of apps/hub/src/lib/seriesColors.ts (PWA). Do not edit by hand:
// scripts/check-shared-parity.mjs compares this file to the source and
// fails on any difference beyond the two allowed transforms — import
// paths, and `var(--token)` rewritten to the bare token name for
// src/theme's resolveToken(). Change the PWA first, then re-copy.
// --- end copy header; everything below is verbatim ---
import type { BarSeries } from './chartTypes';
import type { SpendModelRow } from '../lib/types';

// Chart identity system. Slots are the CVD-validated categorical tokens; models
// get slots in cost-rank order at window load and keep them while the window is
// open (color follows the entity — a filter never repaints survivors). Gold is
// chrome, never a series; status colors never appear here either.

const SLOT_TOKENS = [
  'series-1',
  'series-2',
  'series-3',
  'series-4',
  'series-5',
];

export const OTHER_COLOR = 'series-other';

export const PROVIDER_COLORS: Record<string, string> = {
  anthropic: 'provider-anthropic',
  openrouter: 'provider-openrouter',
};

export function providerColor(provider: string): string {
  return PROVIDER_COLORS[provider.toLowerCase()] ?? 'provider-other';
}

export function shortModel(id: string): string {
  return id.replace(/^[a-z0-9_-]+\//i, '').replace(/^claude-/, '');
}

/** Mirror of the bridge's canonical(): vendor prefix off, :variant off, claude dots→dashes. */
export function shortToCanonical(id: string): string {
  let m = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
  m = m.split(':')[0];
  return m.includes('claude') ? m.replaceAll('.', '-') : m;
}

/** Ranked models → stable series list (top N slots + 'other'). */
export function modelSeries(models: Pick<SpendModelRow, 'model'>[], topN = 5): BarSeries[] {
  const top = models.slice(0, topN).map((m, i) => ({
    id: m.model,
    label: shortModel(m.model),
    color: SLOT_TOKENS[i],
  }));
  return [...top, { id: 'other', label: 'other', color: OTHER_COLOR }];
}

/** Fold a per-model value map into the given series ids (+ 'other' remainder). */
export function foldValues(perKey: Record<string, number>, seriesIds: string[]): Record<string, number> {
  const known = new Set(seriesIds.filter((id) => id !== 'other'));
  const out: Record<string, number> = {};
  let other = 0;
  for (const [k, v] of Object.entries(perKey)) {
    if (known.has(k)) out[k] = (out[k] ?? 0) + v;
    else other += v;
  }
  if (other > 0) out.other = other;
  return out;
}

export function fmtUsd(v: number): string {
  if (v >= 100) return `$${Math.round(v).toLocaleString()}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(2)}`;
  return v > 0 ? `$${v.toFixed(3)}` : '$0';
}

export function fmtTokens(v: number): string {
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}k`;
  return String(v);
}
