import {
  fmtHour,
  hasProviderSplit,
  pointsOf,
  providersRanked,
  selectedModels,
  selectedPoint,
  selectionHeader,
  spendBuckets,
  spendSeries,
  todayEyebrow,
  todayTotal,
} from './spendCardModel';
import { fmtTokens } from '../../shared/seriesColors';
import type { SpendPoint, SpendSummary } from '../../lib/types';

const point = (over: Partial<SpendPoint> = {}): SpendPoint => ({
  date: '2026-09-10T09:00',
  spend_usd: 1,
  per_model: {},
  per_provider: { anthropic: 1 },
  tokens: { input: 1000, output: 10, cache_read: 0 },
  sessions: 1,
  ...over,
});

const summary = (over: Partial<SpendSummary> = {}): SpendSummary =>
  ({ total_usd: 9, sessions: 4, by_provider: { anthropic: 6, openrouter: 3 }, ...over }) as SpendSummary;

describe('hour ticks (SpendCard.tsx:9-14)', () => {
  test('midnight and noon get their own labels', () => {
    expect(fmtHour('2026-09-10T00:00')).toBe('12a');
    expect(fmtHour('2026-09-10T12:00')).toBe('12p');
  });

  test('morning and afternoon hours', () => {
    expect(fmtHour('2026-09-10T09:00')).toBe('9a');
    expect(fmtHour('2026-09-10T13:00')).toBe('1p');
    expect(fmtHour('2026-09-10T23:00')).toBe('11p');
  });

  test('only a non-numeric slice falls back to the raw key', () => {
    expect(fmtHour('week-of-2026-09-07')).toBe('week-of-2026-09-07');
    // A day-granularity key slices to '' → Number('') is 0, so it reads as
    // midnight rather than falling back. Home only ever passes hour buckets;
    // this pins the PWA's arithmetic rather than endorsing it.
    expect(fmtHour('2026-09-10')).toBe('12a');
  });
});

describe('the headline numbers', () => {
  test('the summary total wins; the buckets are the fallback', () => {
    const points = [point({ spend_usd: 1.5 }), point({ spend_usd: 2.25 })];
    expect(todayTotal(points, summary())).toBe(9);
    expect(todayTotal(points, undefined)).toBe(3.75);
    expect(todayTotal([], undefined)).toBe(0);
  });

  test('the eyebrow counts sessions only once the summary lands', () => {
    expect(todayEyebrow(summary())).toBe('today · 4 sess');
    expect(todayEyebrow(undefined)).toBe('today');
  });
});

describe('series and buckets (SpendCard.tsx:28-43)', () => {
  test('providers are ranked by spend, biggest first', () => {
    expect(providersRanked(summary({ by_provider: { openrouter: 2, anthropic: 8 } }))).toEqual([
      'anthropic',
      'openrouter',
    ]);
    expect(providersRanked(undefined)).toEqual([]);
  });

  test('a provider stack carries the provider tokens, in rank order', () => {
    expect(spendSeries([point()], summary())).toEqual([
      { id: 'anthropic', label: 'anthropic', color: 'provider-anthropic' },
      { id: 'openrouter', label: 'openrouter', color: 'provider-openrouter' },
    ]);
  });

  test('a payload missing per_provider degrades to one flat series, not a crash', () => {
    const stale = [point(), { ...point(), per_provider: undefined as unknown as Record<string, number> }];
    expect(hasProviderSplit(stale, providersRanked(summary()))).toBe(false);
    expect(spendSeries(stale, summary())).toEqual([{ id: 'total', label: 'spend', color: 'series-1' }]);
    expect(spendBuckets(stale, summary())[0].values).toEqual({ total: 1 });
  });

  test('with no summary yet there are no providers to stack by', () => {
    expect(spendSeries([point()], undefined)).toEqual([{ id: 'total', label: 'spend', color: 'series-1' }]);
  });

  test('only the last bucket is the hour in progress', () => {
    const buckets = spendBuckets([point({ date: 'a' }), point({ date: 'b' })], summary());
    expect(buckets.map((b) => b.partial)).toEqual([false, true]);
    expect(buckets[0]).toMatchObject({ key: 'a', total: 1, values: { anthropic: 1 } });
  });

  test('an empty day has no buckets at all — the card shows its empty line instead', () => {
    expect(spendBuckets([], summary())).toEqual([]);
    expect(pointsOf(undefined)).toEqual([]);
  });
});

describe('the selected hour (SpendCard.tsx:45-51,88-95)', () => {
  const sel = point({
    date: '2026-09-10T14:00',
    spend_usd: 2,
    sessions: 3,
    tokens: { input: 1_500_000, output: 10, cache_read: 0 },
    per_model: { 'anthropic/claude-opus-4-5': 1.2, 'deepseek/deepseek-chat': 0, 'openai/gpt-5': 0.8 },
  });

  test('a selection past the end of the data resolves to nothing', () => {
    expect(selectedPoint([sel], null)).toBeNull();
    expect(selectedPoint([sel], 1)).toBeNull();
    expect(selectedPoint([sel], 0)).toBe(sel);
  });

  test('zero-spend models are dropped and the rest sorted by cost', () => {
    expect(selectedModels(sel)).toEqual([
      ['anthropic/claude-opus-4-5', 1.2],
      ['openai/gpt-5', 0.8],
    ]);
    expect(selectedModels(null)).toEqual([]);
  });

  test('the header names the hour, the sessions and the input tokens', () => {
    expect(selectionHeader(sel, fmtTokens)).toBe('2p · 3 sess · 1.5M in');
  });
});
