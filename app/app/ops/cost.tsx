// 1:1 port of apps/hub/src/routes/Cost.tsx (post-rework: 4ea5691 → 9134121).
//
// Order is deliberate and was changed by that rework: the hero, then the
// per-key split that must agree with it, then the ledger history and models,
// then the scheduled jobs, and only at the foot the two account-level cards
// (prompt cache, OpenRouter balance) that answer a different question from a
// different source.
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import {
  PageTitle,
  RefreshControl,
  Screen,
  SkeletonCard,
  StatePanel,
  useHideTabBar,
} from '../../src/components/shell';
import { LegendChips, StackedBars } from '../../src/components/charts/StackedBars';
import {
  BalanceCard,
  BucketDetail,
  CacheCard,
  Card,
  ChartMeta,
  CronCostsSection,
  Eyebrow,
  HeroCard,
  HistoryHeader,
  ModelRow,
  PerKeyCard,
  RecurringCostsSection,
  RangeLine,
  UnpricedCard,
  WindowPills,
} from '../../src/components/finance/costParts';
import {
  costBuckets,
  costSeries,
  fmtBucket,
  lastActivePoint,
  latestLabel,
  peakLabel,
  stepBucket,
  unpricedEntries,
  usedSeries,
  type SpendWindow,
  type StackBy,
} from '../../src/components/finance/costModel';
import { api } from '../../src/lib/api';
import { QUERY_TUNING, usePoll } from '../../src/lib/query';
import { OTHER_COLOR } from '../../src/shared/seriesColors';

export default function CostScreen() {
  // Pushed detail route: the tab bar drops while this screen is focused.
  useHideTabBar();
  const [window, setWindow] = useState<SpendWindow>('today');
  const [stackBy, setStackBy] = useState<StackBy>('models');
  const [selected, setSelected] = useState<number | null>(null);

  const summary = usePoll(
    ['spend-summary', window],
    () => api.spendSummary(window),
    QUERY_TUNING['spend-summary-cost'],
  );
  const timeseries = usePoll(
    ['spend-timeseries', window],
    () => api.spendTimeseries(window),
    QUERY_TUNING['spend-timeseries-cost'],
  );
  const orCredits = usePoll(['openrouter-credits'], api.openrouterCredits, QUERY_TUNING['openrouter-credits']);

  const points = timeseries.data?.points ?? [];
  const granularity = timeseries.data?.granularity ?? 'day';
  const s = summary.data;
  const unpriced = unpricedEntries(s);

  const series = useMemo(() => costSeries(s, stackBy), [s, stackBy]);
  const buckets = useMemo(() => costBuckets(points, stackBy, series), [points, stackBy, series]);

  const lastActive = lastActivePoint(points);
  const shownSeries = usedSeries(series, buckets);
  const cache = s?.cache;

  return (
    <Screen
      header={<PageTitle right={<RefreshControl queries={[summary, timeseries]} />}>Cost</PageTitle>}
    >
      <WindowPills
        window={window}
        onSelect={(w) => {
          setWindow(w);
          setSelected(null);
        }}
      />
      <RangeLine summary={s} />

      {summary.isLoading && !s ? <SkeletonCard height={140} /> : null}
      {summary.isError ? <StatePanel tone="error" title="Spend unavailable" detail={summary.error?.message} /> : null}

      {s ? <HeroCard summary={s} window={window} /> : null}

      {orCredits.data?.keys ? <PerKeyCard keys={orCredits.data.keys} window={window} /> : null}

      {unpriced.length > 0 ? <UnpricedCard rows={unpriced} /> : null}

      <HistoryHeader granularity={granularity} stackBy={stackBy} onStackBy={setStackBy} />

      {timeseries.isLoading && !timeseries.data ? <SkeletonCard height={160} /> : null}
      {timeseries.isError ? (
        <StatePanel tone="error" title="Timeseries unavailable" detail={timeseries.error?.message} />
      ) : null}
      {timeseries.data && points.length === 0 ? (
        <StatePanel tone="neutral" title="No spend history" detail={`No usage recorded in ${window}.`} />
      ) : null}
      {timeseries.data && points.length > 0 ? (
        <Card>
          {lastActive ? (
            <ChartMeta peak={peakLabel(points)} latest={latestLabel(points, lastActive, granularity)} />
          ) : null}
          <StackedBars
            buckets={buckets}
            series={series}
            height={130}
            tickFormat={(k, i) => fmtBucket(k, granularity, i)}
            selected={selected}
            onSelect={setSelected}
            ariaTitle={`Spend per ${granularity}, stacked by ${stackBy}`}
          />
          <LegendChips series={shownSeries} />
          {selected !== null && points[selected] ? (
            <BucketDetail
              point={points[selected]}
              granularity={granularity}
              index={selected}
              count={points.length}
              onStep={(dir) => setSelected((i) => stepBucket(i, dir, points.length))}
              series={series}
            />
          ) : null}
        </Card>
      ) : null}

      {s && s.models.length > 0 ? (
        <>
          <Eyebrow label="Models" count={String(s.models.length)} />
          <Card>
            <View>
              {s.models.map((m) => (
                <ModelRow
                  key={m.model}
                  row={m}
                  color={series.find((x) => x.id === m.model)?.color ?? OTHER_COLOR}
                  windowTotal={s.total_usd}
                />
              ))}
            </View>
          </Card>
        </>
      ) : null}

      <CronCostsSection />

      {cache && cache.read_tokens > 0 && cache.would_have_cost_usd != null ? (
        <CacheCard cache={cache} paidUsd={s?.total_usd ?? 0} />
      ) : null}

      {orCredits.data ? <BalanceCard credits={orCredits.data} /> : null}
      <RecurringCostsSection window={window} />
    </Screen>
  );
}
