// The pieces of the Cost page (apps/hub/src/routes/Cost.tsx), ported 1:1 from
// its post-rework state (4ea5691 → 9134121).
//
// Cost v2. Every number is calendar-honest (windows resolve to real dates the
// UI shows), every chart is stacked by identity with a legend, and tokens ride
// along everywhere the payload carries them. Gold appears exactly once: the
// hero figure — the app's signature numeral.
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import type { BarSeries } from '../../shared/chartTypes';
import { fmtTokens, fmtUsd, modelSeries, providerColor, shortModel, OTHER_COLOR } from '../../shared/seriesColors';
import type {
  CronCostsJob,
  OpenRouterCredits,
  OpenRouterKeyRow,
  SpendModelRow,
  SpendPoint,
  SpendSummary,
} from '../../lib/types';
import { PRESSED_OPACITY, StatePanel } from '../shell';
import { seriesPaint } from '../charts/geometry';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import {
  bucketHeaderLabel,
  bucketModelRows,
  bucketTokensLine,
  cacheSummaryLine,
  creditsBarPct,
  creditsMetersLine,
  creditsUsedLine,
  cronCostLabel,
  cronDayEntries,
  cronDayLine,
  cronJobMetaLine,
  cronScriptFooter,
  cronSplit,
  deltaChipParts,
  heroTokensLine,
  isLowBalance,
  modelAliasLine,
  modelDetailLine,
  modelMetaLine,
  modelShare,
  perKeyRows,
  providerEntries,
  rangeLabel,
  recurringFootnote,
  recurringHeadLabel,
  recurringRows,
  STACK_MODES,
  unpricedDetail,
  unpricedHeadline,
  WINDOWS,
  type SpendWindow,
  type StackBy,
} from './costModel';

/** Cost's own card idiom: radius 14, 16/14 padding, 10 below — not the shell
 * Card's 16/18-14 (the same duplication the PWA carries between its routes). */
export function Card({ children, tone }: { children: ReactNode; tone?: 'warn' }) {
  const { t } = useTheme();
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: tone === 'warn' ? t('status-warn-soft') : t('bg-1'),
          borderColor: tone === 'warn' ? t('status-warn-border') : t('border'),
        },
      ]}
    >
      {children}
    </View>
  );
}

/** The page's section eyebrow — Cost inlines it rather than using SectionHead,
 * and aligns on the baseline where SectionHead centres. */
export function Eyebrow({ label, count }: { label: string; count?: string }) {
  const { t } = useTheme();
  return (
    <View style={styles.eyebrowRow}>
      <Text style={[styles.eyebrow, { color: t('fg-3') }]}>{label}</Text>
      {count != null ? <Text style={[styles.eyebrow, { color: t('fg-4') }]}>{count}</Text> : null}
    </View>
  );
}

// ── Window selector + range line ─────────────────────────────────────────────

export function WindowPills({
  window,
  onSelect,
}: {
  window: SpendWindow;
  onSelect: (w: SpendWindow) => void;
}) {
  const { t } = useTheme();
  return (
    <View style={styles.pillRow}>
      {WINDOWS.map((w) => {
        const active = w === window;
        return (
          <Pressable
            key={w}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onSelect(w)}
            style={({ pressed }) => [
              styles.pill,
              {
                backgroundColor: active ? t('accent-soft') : t('bg-1'),
                borderColor: active ? t('accent-border') : t('border'),
              },
              pressed && styles.activeOpacity,
            ]}
          >
            <Text style={[styles.pillLabel, { color: active ? t('accent') : t('fg-3') }]}>{w}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function RangeLine({ summary }: { summary: SpendSummary | undefined }) {
  const { t } = useTheme();
  return <Text style={[styles.rangeLine, { color: t('fg-4') }]}>{rangeLabel(summary)}</Text>;
}

// ── Hero ─────────────────────────────────────────────────────────────────────

export function DeltaChip({
  deltaPct,
  prevRange,
}: {
  deltaPct: number | null;
  prevRange: { start: string; end: string } | null;
}) {
  const { t } = useTheme();
  const parts = deltaChipParts(deltaPct, prevRange);
  if (!parts) return null;
  // Spend up = costs more = down-red; spend down = up-green. Direction × goodness.
  const color = parts.direction === 'flat' ? t('fg-3') : parts.direction === 'up' ? t('status-down') : t('status-up');
  return <Text style={[styles.deltaChip, { color }]}>{parts.text}</Text>;
}

export function ProviderStrip({ byProvider, total }: { byProvider: Record<string, number>; total: number }) {
  const { t } = useTheme();
  const entries = providerEntries(byProvider);
  if (entries.length === 0 || total <= 0) return null;
  return (
    <>
      <View style={styles.providerBar} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {entries.map(([p, v]) => (
          <View
            key={p}
            style={{ width: `${(v / total) * 100}%`, minWidth: 3, backgroundColor: seriesPaint(providerColor(p), t) }}
          />
        ))}
      </View>
      <View style={styles.providerChips}>
        {entries.map(([p, v]) => (
          <View key={p} style={styles.providerChip}>
            <View style={[styles.swatch7, { backgroundColor: seriesPaint(providerColor(p), t) }]} />
            <Text style={[styles.providerChipLabel, { color: t('fg-2') }]}>{`${p} ${fmtUsd(v)}`}</Text>
          </View>
        ))}
      </View>
    </>
  );
}

export function HeroCard({ summary, window }: { summary: SpendSummary; window: SpendWindow }) {
  const { t } = useTheme();
  const tokensLine = heroTokensLine(summary, window);
  return (
    <Card>
      <View style={styles.heroRow}>
        <Text style={[styles.heroTotal, { color: t('accent-hi') }]}>{fmtUsd(summary.total_usd)}</Text>
        <DeltaChip deltaPct={summary.delta_pct} prevRange={summary.prev_range ?? null} />
      </View>
      {tokensLine !== null ? (
        <Text style={[styles.heroTokens, { color: t('fg-3') }]}>{tokensLine}</Text>
      ) : null}
      <ProviderStrip byProvider={summary.by_provider ?? {}} total={summary.total_usd} />
    </Card>
  );
}

// ── Per-key spend ────────────────────────────────────────────────────────────
// OpenRouter's per-key window figures, summed from the snapshot intervals
// inside the selected window, with lifetime spend alongside for scale.

export function PerKeyCard({ keys, window }: { keys: OpenRouterKeyRow[]; window: SpendWindow }) {
  const { t } = useTheme();
  const rows = perKeyRows(keys, window);
  if (rows.length === 0) return null;
  const usable = rows.filter((r) => r.usd > 0);
  const total = usable.reduce((sum, r) => sum + r.usd, 0);
  const series = modelSeries(rows.map((r) => ({ model: r.id })), 5);
  const colorOf = (id: string) => seriesPaint(series.find((x) => x.id === id)?.color ?? OTHER_COLOR, t);
  return (
    <Card>
      <View style={styles.perKeyHead}>
        <Text style={[styles.cardEyebrow, { color: t('fg-4') }]}>{`per key · ${window}`}</Text>
        <Text style={[styles.perKeyTotal, { color: t('fg-1') }]}>{fmtUsd(total)}</Text>
      </View>
      {usable.length > 0 ? (
        <View style={styles.keyBar} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {usable.map((r) => (
            <View key={r.id} style={{ width: `${(r.usd / total) * 100}%`, minWidth: 3, backgroundColor: colorOf(r.id) }} />
          ))}
        </View>
      ) : null}
      {rows.map((r) => (
        <View key={r.id} style={styles.perKeyRow}>
          <View style={styles.perKeyLeft}>
            <View style={[styles.swatch7, { backgroundColor: colorOf(r.id) }]} />
            <Text style={[styles.perKeyName, { color: t('fg-2') }]} numberOfLines={1}>
              {r.id}
            </Text>
          </View>
          <Text style={[styles.perKeyValue, { color: t('fg-2') }]}>
            {fmtUsd(r.usd)}
            <Text style={{ color: t('fg-4') }}>{` · ${fmtUsd(r.total)} total`}</Text>
          </Text>
        </View>
      ))}
    </Card>
  );
}

// ── Unpriced warning ─────────────────────────────────────────────────────────

export function UnpricedCard({ rows }: { rows: SpendSummary['unpriced'] }) {
  const { t } = useTheme();
  return (
    <Card tone="warn">
      <Text style={[styles.unpricedHead, { color: t('status-warn') }]}>{unpricedHeadline(rows.length)}</Text>
      <Text style={[styles.unpricedDetail, { color: t('fg-3') }]}>{unpricedDetail(rows)}</Text>
    </Card>
  );
}

// ── History header ───────────────────────────────────────────────────────────

export function HistoryHeader({
  granularity,
  stackBy,
  onStackBy,
}: {
  granularity: string;
  stackBy: StackBy;
  onStackBy: (mode: StackBy) => void;
}) {
  const { t } = useTheme();
  return (
    <View style={styles.historyHead}>
      <Text style={[styles.eyebrow, { color: t('fg-3') }]}>{`History · ${granularity}`}</Text>
      <View style={[styles.toggleGroup, { borderColor: t('border') }]}>
        {STACK_MODES.map((mode) => (
          <Pressable
            key={mode}
            accessibilityRole="button"
            accessibilityState={{ selected: stackBy === mode }}
            onPress={() => onStackBy(mode)}
            style={[styles.toggleButton, stackBy === mode ? { backgroundColor: t('accent-soft') } : null]}
          >
            <Text style={[styles.toggleLabel, { color: stackBy === mode ? t('accent') : t('fg-4') }]}>{mode}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** Peak / latest strip above the bars — only drawn when some bucket has spend. */
export function ChartMeta({ peak, latest }: { peak: string; latest: string }) {
  const { t } = useTheme();
  return (
    <View style={styles.chartMeta}>
      <Text style={[styles.chartMetaText, { color: t('fg-4') }]}>{peak}</Text>
      <Text style={[styles.chartMetaText, { color: t('fg-4') }]}>{latest}</Text>
    </View>
  );
}

// ── Bucket detail ────────────────────────────────────────────────────────────

export function BucketDetail({
  point,
  granularity,
  index,
  count,
  onStep,
  series,
}: {
  point: SpendPoint;
  granularity: string;
  index: number;
  count: number;
  onStep: (dir: -1 | 1) => void;
  series: BarSeries[];
}) {
  const { t } = useTheme();
  const colorOf = (model: string) => seriesPaint(series.find((s) => s.id === model)?.color ?? OTHER_COLOR, t);
  const rows = bucketModelRows(point);
  const prevDisabled = index <= 0;
  const nextDisabled = index >= count - 1;
  return (
    <View style={[styles.bucketDetail, { backgroundColor: t('bg-0'), borderColor: t('border') }]}>
      <View style={styles.bucketHead}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Previous bucket"
          accessibilityState={{ disabled: prevDisabled }}
          disabled={prevDisabled}
          onPress={() => onStep(-1)}
          style={[styles.stepButton, styles.stepPrev, prevDisabled && styles.stepDisabled]}
        >
          <Text style={[styles.stepGlyph, { color: t('fg-3') }]}>‹</Text>
        </Pressable>
        <View style={styles.bucketHeadCentre}>
          <Text style={[styles.bucketLabel, { color: t('fg-1') }]}>
            {bucketHeaderLabel(point.date, granularity, index)}
          </Text>
          <Text style={[styles.bucketTotal, { color: t('fg-0') }]}>{fmtUsd(point.spend_usd)}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Next bucket"
          accessibilityState={{ disabled: nextDisabled }}
          disabled={nextDisabled}
          onPress={() => onStep(1)}
          style={[styles.stepButton, styles.stepNext, nextDisabled && styles.stepDisabled]}
        >
          <Text style={[styles.stepGlyph, { color: t('fg-3') }]}>›</Text>
        </Pressable>
      </View>
      {rows.length > 0 ? (
        rows.map(([model, usd], i) => (
          <View
            key={model}
            style={[styles.bucketRow, i === 0 ? null : { borderTopWidth: 1, borderTopColor: t('border') }]}
          >
            <View style={[styles.swatch7, { backgroundColor: colorOf(model) }]} />
            <Text style={[styles.bucketModel, { color: t('fg-2') }]} numberOfLines={1}>
              {shortModel(model)}
            </Text>
            <Text style={[styles.bucketValue, { color: t('fg-1') }]}>{fmtUsd(usd)}</Text>
          </View>
        ))
      ) : (
        <Text style={[styles.bucketEmpty, { color: t('fg-4') }]}>no usage in this bucket</Text>
      )}
      {point.tokens ? (
        <Text style={[styles.bucketTokens, { color: t('fg-4'), borderTopColor: t('border') }]}>
          {bucketTokensLine(point)}
        </Text>
      ) : null}
    </View>
  );
}

// ── Models ───────────────────────────────────────────────────────────────────

export function ModelRow({ row, color, windowTotal }: { row: SpendModelRow; color: string; windowTotal: number }) {
  const { t } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const share = modelShare(row, windowTotal);
  const aliasLine = modelAliasLine(row);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={() => setExpanded((e) => !e)}
      style={styles.modelRow}
    >
      <View
        style={[styles.modelShareBar, { width: `${Math.min(share, 100)}%`, backgroundColor: t('bg-2') }]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
      <View style={styles.modelHead}>
        <View style={[styles.swatch8, { backgroundColor: seriesPaint(color, t) }]} />
        <Text style={[styles.modelName, { color: t('fg-1') }]} numberOfLines={1}>
          {shortModel(row.model)}
        </Text>
        <Text style={[styles.modelValue, { color: t('fg-0') }]}>{fmtUsd(row.total_spend)}</Text>
      </View>
      <Text style={[styles.modelMeta, { color: t('fg-4') }]} numberOfLines={1}>
        {modelMetaLine(row, windowTotal)}
      </Text>
      {expanded ? (
        <View style={styles.modelDetail}>
          <Text style={[styles.modelDetailText, { color: t('fg-3') }]}>{modelDetailLine(row)}</Text>
          {aliasLine !== null ? (
            <Text style={[styles.modelAliases, { color: t('fg-4') }]}>{aliasLine}</Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

// ── Scheduled jobs ───────────────────────────────────────────────────────────

export function CronJobCostRow({ job, last }: { job: CronCostsJob; last: boolean }) {
  const { t } = useTheme();
  const [expanded, setExpanded] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={() => setExpanded((e) => !e)}
      style={[styles.cronRow, last ? null : { borderBottomWidth: 1, borderBottomColor: t('border') }]}
    >
      <View style={styles.cronHead}>
        <Text style={[styles.cronName, { color: t('fg-1') }]} numberOfLines={1}>
          {job.name ?? 'removed job'}
        </Text>
        <Text style={[styles.cronValue, { color: t('fg-0') }]}>{cronCostLabel(job.week)}</Text>
      </View>
      <Text style={[styles.cronMeta, { color: t('fg-4') }]} numberOfLines={1}>
        {cronJobMetaLine(job)}
      </Text>
      {expanded
        ? cronDayEntries(job).map(([day, d]) => (
            <View key={day} style={styles.cronDayRow}>
              <Text style={[styles.cronDayLabel, { color: t('fg-3') }]}>{cronDayLine(day, d)}</Text>
              <Text style={[styles.cronDayValue, { color: t('fg-2') }]}>{cronCostLabel(d)}</Text>
            </View>
          ))
        : null}
    </Pressable>
  );
}

export function CronScriptFooter({ count }: { count: number }) {
  const { t } = useTheme();
  return <Text style={[styles.cronScripts, { color: t('fg-4') }]}>{cronScriptFooter(count)}</Text>;
}

/** Per-cron-job trailing-7d cost with a daily rollup. Silent while loading and
 * when nothing ran; an error still prints its header so the gap is explained. */
export function CronCostsSection() {
  const q = usePoll(['cron-costs'], api.cronCosts, QUERY_TUNING['cron-costs']);
  if (q.isError) {
    return (
      <>
        <Eyebrow label="Scheduled jobs · 7d" />
        <StatePanel tone="error" title="Job costs unavailable" detail={q.error?.message} />
      </>
    );
  }
  if (!q.data) return null;
  const { active, scriptJobs } = cronSplit(q.data);
  if (active.length === 0 && scriptJobs.length === 0) return null;
  return (
    <>
      <Eyebrow label="Scheduled jobs · 7d" count={String(active.length)} />
      <Card>
        <View>
          {active.map((j, i) => (
            <CronJobCostRow key={j.id} job={j} last={i === active.length - 1 && scriptJobs.length === 0} />
          ))}
          {scriptJobs.length > 0 ? <CronScriptFooter count={scriptJobs.length} /> : null}
        </View>
      </Card>
    </>
  );
}

// ── Prompt cache + OpenRouter balance (page foot) ────────────────────────────

export function CacheCard({ cache, paidUsd }: { cache: SpendSummary['cache']; paidUsd: number }) {
  const { t } = useTheme();
  return (
    <Card>
      <View style={styles.footHead}>
        <Text style={[styles.cardEyebrow, { color: t('fg-4') }]}>prompt cache</Text>
        <Text style={[styles.cacheSaved, { color: t('status-up') }]}>{`saved ${fmtUsd(cache.saved_usd)}`}</Text>
      </View>
      <Text style={[styles.cacheLine, { color: t('fg-2') }]}>{cacheSummaryLine(cache, paidUsd)}</Text>
      <Text style={[styles.cacheTokens, { color: t('fg-4') }]}>
        {`${fmtTokens(cache.read_tokens)} tokens served from cache`}
      </Text>
    </Card>
  );
}

export function BalanceCard({ credits }: { credits: OpenRouterCredits }) {
  const { t } = useTheme();
  const low = isLowBalance(credits);
  const meters = creditsMetersLine(credits);
  return (
    <Card tone={low ? 'warn' : undefined}>
      <View style={styles.footHead}>
        <Text style={[styles.cardEyebrow, { color: t('fg-4') }]}>openrouter balance</Text>
        <Text style={[styles.balanceValue, { color: low ? t('status-warn') : t('fg-0') }]}>
          {fmtUsd(credits.balance)}
        </Text>
      </View>
      <View
        style={[styles.balanceTrack, { backgroundColor: t('bg-2') }]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <View
          style={{
            width: `${creditsBarPct(credits)}%`,
            backgroundColor: low ? t('status-warn') : t('series-1'),
          }}
        />
      </View>
      <Text style={[styles.balanceUsed, { color: t('fg-4') }]}>{creditsUsedLine(credits)}</Text>
      {meters !== null ? <Text style={[styles.balanceMeters, { color: t('fg-3') }]}>{meters}</Text> : null}
      {/* Per-model account detail lives in the main spend views now (the
          hybrid uses OpenRouter's own numbers for OR-billed traffic). */}
    </Card>
  );
}

// ── Recurring spend (page foot, last card) ───────────────────────────────────
// Answers a different question from everything above it: not what the agents
// burned, but what standing still costs. Its own total, never folded into the
// hero — see costModel.recurringRows.

export function RecurringCostsSection({ window }: { window: SpendWindow }) {
  const { t } = useTheme();
  const q = usePoll(
    ['recurring-costs', window],
    () => api.recurringCosts(window),
    QUERY_TUNING['recurring-costs'],
  );
  if (q.isError) {
    return (
      <>
        <Eyebrow label="Recurring" />
        <StatePanel tone="error" title="Recurring costs unavailable" detail={q.error?.message} />
      </>
    );
  }
  if (!q.data || q.data.items.length === 0) return null;
  const rows = recurringRows(q.data);
  return (
    <>
      <Eyebrow label="Recurring" count={String(rows.length)} />
      <Card>
        <View style={styles.footHead}>
          <Text style={[styles.cardEyebrow, { color: t('fg-4') }]}>{recurringHeadLabel(window)}</Text>
          <Text style={[styles.balanceValue, { color: t('fg-0') }]}>{fmtUsd(q.data.total_window_usd)}</Text>
        </View>
        <View style={styles.recurringList}>
          {rows.map((r) => (
            <View key={r.id} style={styles.recurringRow}>
              <Text style={[styles.recurringLabel, { color: t('fg-2') }]} numberOfLines={1}>
                {r.label}
              </Text>
              <Text style={[styles.recurringValue, { color: t('fg-1') }]}>
                {r.windowUsd}
                <Text style={{ color: t('fg-4') }}>{r.sourceTail}</Text>
              </Text>
            </View>
          ))}
        </View>
        <Text style={[styles.recurringFoot, { color: t('fg-4') }]}>{recurringFootnote(q.data)}</Text>
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  recurringList: { marginTop: 10 },
  recurringRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingVertical: 3 },
  recurringLabel: { fontSize: 12.5, flexShrink: 1, paddingRight: 10 },
  recurringValue: { fontFamily: fonts.mono(400), fontSize: 11.5, flexShrink: 0, ...MONO_FEATURES },
  recurringFoot: { fontFamily: fonts.mono(400), fontSize: 10, marginTop: 8, ...MONO_FEATURES },
  // rounded-[14px] px-[16px] py-[14px] mb-[10px]
  card: { borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, marginBottom: 10, borderWidth: 1 },
  activeOpacity: { opacity: 0.7 },

  // pt-2 pb-3 px-1, items-baseline
  eyebrowRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingTop: 8,
    paddingBottom: 12,
    paddingHorizontal: 4,
  },
  // font-mono text-[10px] uppercase tracking-[0.14em]
  eyebrow: { fontFamily: fonts.mono(400), fontSize: 10, letterSpacing: 1.4, textTransform: 'uppercase' },
  // font-mono text-[10px] uppercase tracking-[0.1em] — the in-card eyebrow
  cardEyebrow: { fontFamily: fonts.mono(400), fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },

  pillRow: { flexDirection: 'row', gap: 8, marginBottom: 6 },
  pill: { flex: 1, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  // font-mono text-[11px] uppercase tracking-[0.08em]
  pillLabel: { fontFamily: fonts.mono(400), fontSize: 11, letterSpacing: 0.88, textTransform: 'uppercase' },
  rangeLine: { fontFamily: fonts.mono(400), fontSize: 10, marginBottom: 12, paddingHorizontal: 2 },

  heroRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  heroTotal: { fontFamily: fonts.mono(620), fontSize: 34, letterSpacing: -0.68 },
  deltaChip: { fontFamily: fonts.mono(400), fontSize: 11, ...MONO_FEATURES },
  heroTokens: { fontFamily: fonts.mono(400), fontSize: 11, marginTop: 6, ...MONO_FEATURES },

  providerBar: { flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', gap: 2, marginTop: 12 },
  providerChips: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 4, marginTop: 7 },
  providerChip: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  providerChipLabel: { fontFamily: fonts.mono(400), fontSize: 10.5, ...MONO_FEATURES },
  swatch7: { width: 7, height: 7, borderRadius: 2 },
  swatch8: { width: 8, height: 8, borderRadius: 2 },

  perKeyHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 9 },
  perKeyTotal: { fontFamily: fonts.mono(600), fontSize: 12, ...MONO_FEATURES },
  keyBar: { flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', gap: 2 },
  perKeyRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 5 },
  perKeyLeft: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, minWidth: 0 },
  perKeyName: { fontFamily: fonts.mono(400), fontSize: 10.5 },
  perKeyValue: { fontFamily: fonts.mono(400), fontSize: 10.5, flexShrink: 0, ...MONO_FEATURES },

  unpricedHead: { fontFamily: fonts.sans(560), fontSize: 12.5 },
  unpricedDetail: { fontFamily: fonts.mono(400), fontSize: 10.5, marginTop: 4 },

  historyHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 8,
    paddingBottom: 12,
    paddingHorizontal: 4,
  },
  toggleGroup: { flexDirection: 'row', borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  toggleButton: { paddingHorizontal: 10, height: 28, alignItems: 'center', justifyContent: 'center' },
  // font-mono text-[10px] uppercase tracking-[0.06em]
  toggleLabel: { fontFamily: fonts.mono(400), fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase' },

  chartMeta: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  chartMetaText: { fontFamily: fonts.mono(400), fontSize: 10, ...MONO_FEATURES },

  bucketDetail: { marginTop: 10, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1 },
  bucketHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  bucketHeadCentre: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  stepButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  stepPrev: { marginLeft: -8 },
  stepNext: { marginRight: -8 },
  stepDisabled: { opacity: 0.3 },
  stepGlyph: { fontFamily: fonts.sans(400), fontSize: 14 },
  bucketLabel: { fontFamily: fonts.mono(550), fontSize: 11 },
  bucketTotal: { fontFamily: fonts.mono(600), fontSize: 12, ...MONO_FEATURES },
  bucketRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
  bucketModel: { fontFamily: fonts.mono(400), fontSize: 11, flex: 1, minWidth: 0 },
  bucketValue: { fontFamily: fonts.mono(400), fontSize: 11, flexShrink: 0, ...MONO_FEATURES },
  bucketEmpty: { fontFamily: fonts.mono(400), fontSize: 11 },
  bucketTokens: { fontFamily: fonts.mono(400), fontSize: 10, marginTop: 7, paddingTop: 7, borderTopWidth: 1 },

  // py-[9px] px-[10px] -mx-[10px] rounded-[8px] overflow-hidden
  modelRow: {
    paddingVertical: 9,
    paddingHorizontal: 10,
    marginHorizontal: -10,
    borderRadius: 8,
    overflow: 'hidden',
  },
  // inset-y-[3px] left-0 rounded-r-[6px], opacity .7
  modelShareBar: {
    position: 'absolute',
    top: 3,
    bottom: 3,
    left: 0,
    borderTopRightRadius: 6,
    borderBottomRightRadius: 6,
    opacity: 0.7,
  },
  modelHead: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  modelName: { fontFamily: fonts.mono(400), fontSize: 12.5, flex: 1, minWidth: 0 },
  modelValue: { fontFamily: fonts.mono(400), fontSize: 12.5, flexShrink: 0, ...MONO_FEATURES },
  modelMeta: { fontFamily: fonts.mono(400), fontSize: 10, marginTop: 3, paddingLeft: 17 },
  modelDetail: { marginTop: 5, paddingLeft: 17 },
  modelDetailText: { fontFamily: fonts.mono(400), fontSize: 10 },
  modelAliases: { fontFamily: fonts.mono(400), fontSize: 10, marginTop: 2 },

  cronRow: { paddingVertical: 9 },
  cronHead: { flexDirection: 'row', alignItems: 'baseline', gap: 9 },
  cronName: { fontFamily: fonts.sans(520), fontSize: 13, flex: 1, minWidth: 0 },
  cronValue: { fontFamily: fonts.mono(400), fontSize: 12.5, flexShrink: 0, ...MONO_FEATURES },
  cronMeta: { fontFamily: fonts.mono(400), fontSize: 10, marginTop: 3 },
  cronDayRow: { flexDirection: 'row', alignItems: 'baseline', gap: 9, marginTop: 5, paddingLeft: 10 },
  cronDayLabel: { fontFamily: fonts.mono(400), fontSize: 10.5, flex: 1 },
  cronDayValue: { fontFamily: fonts.mono(400), fontSize: 10.5, flexShrink: 0, ...MONO_FEATURES },
  cronScripts: { fontFamily: fonts.mono(400), fontSize: 10.5, paddingTop: 9 },

  footHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  cacheSaved: { fontFamily: fonts.mono(600), fontSize: 13, ...MONO_FEATURES },
  cacheLine: { fontFamily: fonts.sans(400), fontSize: 12.5, marginTop: 5 },
  cacheTokens: { fontFamily: fonts.mono(400), fontSize: 10, marginTop: 4 },

  balanceValue: { fontFamily: fonts.mono(600), fontSize: 15, ...MONO_FEATURES },
  balanceTrack: { flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden', marginTop: 8 },
  balanceUsed: { fontFamily: fonts.mono(400), fontSize: 10, marginTop: 5, ...MONO_FEATURES },
  balanceMeters: { fontFamily: fonts.mono(400), fontSize: 10, marginTop: 3, ...MONO_FEATURES },
});
