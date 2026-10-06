// The money surface. Personal money exactly as before — spend, flows,
// accounts, every movement. Net worth stays deliberately last and small.
//
// 1:1 port of apps/hub/src/routes/Finance.tsx. (Its header comment describes an
// earlier two-story layout; the personal-money half is what this file renders,
// plus money decisions.)
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { FlowSankey } from '../../src/components/finance/FlowSankey';
import { AccountsStrip } from '../../src/components/finance/AccountsStrip';
import { MovementsBreakdown } from '../../src/components/finance/MovementsBreakdown';
import { SourcesFooter } from '../../src/components/finance/SourcesFooter';
import { SpendHero } from '../../src/components/finance/SpendHero';
import { SyncButton } from '../../src/components/finance/SyncButton';
import { TxnList } from '../../src/components/finance/TxnList';
import { DecisionGroups, useDecisionAnswers } from '../../src/components/decisions/DecisionCards';
import {
  PageTitle,
  RefreshControl,
  Screen,
  ScreenLabel,
  SkeletonCard,
  StatePanel,
  Toast,
  useHideTabBar,
} from '../../src/components/shell';
import { api } from '../../src/lib/api';
import { QUERY_TUNING, usePoll } from '../../src/lib/query';
import { buildFlows, type FinanceSnapshotFull } from '../../src/shared/financeModel';
import { fmtUsd } from '../../src/shared/seriesColors';
import { fonts, MONO_FEATURES } from '../../src/theme/fonts';
import { useTheme } from '../../src/theme/useTheme';

function NetWorthRow({ nw }: { nw: NonNullable<FinanceSnapshotFull['net_worth']> }) {
  const { t } = useTheme();
  // Always 0 from the producer (finance-snapshot.py), so the delta fragment
  // below is a dead render path today — kept for parity (OQ-23).
  const delta = nw.delta_30d;
  return (
    <View style={[styles.netWorth, { backgroundColor: t('bg-1'), borderColor: t('border') }]}>
      <Text style={[styles.netWorthLabel, { color: t('fg-4') }]}>net worth</Text>
      <Text style={[styles.netWorthValue, { color: t('fg-2') }]}>
        {fmtUsd(nw.total)}
        <Text style={{ color: t('fg-4') }}> · assets {fmtUsd(nw.assets)} · owed {fmtUsd(nw.liabilities)}</Text>
        {delta !== 0 ? (
          <Text style={{ color: t(delta > 0 ? 'inflow' : 'fg-3') }}> · {delta > 0 ? '+' : '−'}{fmtUsd(Math.abs(delta))} 30d</Text>
        ) : null}
      </Text>
    </View>
  );
}

const MONEY_DOMAINS = new Set(['finance']);

export default function MoneyScreen() {
  // Pushed detail route: the tab bar drops while this screen is focused.
  useHideTabBar();
  const { t } = useTheme();
  const finance = usePoll(['finance'], api.finance, QUERY_TUNING.finance);
  const decisions = usePoll(['decisions'], api.decisions, QUERY_TUNING['decisions-shared']);

  const { applying, toast, clearToast, answer } = useDecisionAnswers();

  const snap = finance.data as FinanceSnapshotFull | null | undefined;
  const flows = useMemo(() => (snap ? buildFlows(snap) : null), [snap]);
  const moneyDecisions = (decisions.data?.open ?? []).filter((d) => d.domain && MONEY_DOMAINS.has(d.domain));

  return (
    <>
      <Screen
        header={
          <PageTitle
            right={
              <View style={styles.headerActions}>
                <SyncButton />
                <RefreshControl queries={[finance, decisions]} />
              </View>
            }
          >
            Money
          </PageTitle>
        }
      >
        {moneyDecisions.length > 0 ? (
          <>
            <ScreenLabel>Waiting on you · money decisions</ScreenLabel>
            <DecisionGroups decisions={moneyDecisions} applying={applying} onAnswer={answer} />
          </>
        ) : null}

        {/* ---- Personal money ------------------------------------------------- */}
        <ScreenLabel>Personal money · spend & accounts</ScreenLabel>

        {finance.isLoading && !snap ? (
          <>
            <SkeletonCard height={84} />
            <View style={styles.skeletonGap} />
            <SkeletonCard height={300} />
          </>
        ) : null}

        {finance.isError ? (
          <StatePanel tone="error" title="Finance unavailable" detail={finance.error?.message} />
        ) : null}

        {!finance.isLoading && !finance.isError && !snap ? (
          <StatePanel
            tone="neutral"
            title="Not connected yet"
            detail="No finance snapshot on the server — the Copilot/Plaid cron hasn't written one."
          />
        ) : null}

        {snap && flows ? (
          <>
            <SpendHero windows={snap.spend_windows} />

            {flows.accounts.some((f) => f.total > 0.005) ? (
              <>
                <ScreenLabel>{`Money flow · last ${flows.windowDays}d`}</ScreenLabel>
                <FlowSankey flows={flows} />
                <Text style={[styles.caption, { color: t('fg-3') }]}>
                  Top to bottom: money comes <Text style={[styles.captionStrong, { color: t('fg-1') }]}>in</Text>, lands in an{' '}
                  <Text style={[styles.captionStrong, { color: t('fg-1') }]}>account</Text>, then leaves as{' '}
                  <Text style={[styles.captionStrong, { color: t('fg-1') }]}>spend</Text> or a{' '}
                  <Text style={[styles.captionStrong, { color: t('fg-1') }]}>move</Text>. Ribbon width = dollars; color = the
                  account it moved through.
                </Text>
              </>
            ) : null}

            <ScreenLabel>{`Accounts · balances & ${flows.windowDays}d flow`}</ScreenLabel>
            <AccountsStrip accounts={snap.accounts ?? []} flows={flows} />

            <ScreenLabel>Bank activity · all movement</ScreenLabel>
            <TxnList txns={snap.recent_transactions ?? []} byLast4={flows.byLast4} />

            {snap.movements && snap.movements.length > 0 ? (
              <>
                <ScreenLabel>How money moved · classifications</ScreenLabel>
                <MovementsBreakdown movements={snap.movements} byLast4={flows.byLast4} />
              </>
            ) : null}

            {snap.net_worth ? <NetWorthRow nw={snap.net_worth} /> : null}
            <SourcesFooter snap={snap} />
          </>
        ) : null}
      </Screen>

      {toast ? <Toast kind={toast.kind} text={toast.text} onDone={clearToast} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  skeletonGap: { height: 12 },
  caption: { fontFamily: fonts.sans(400), fontSize: 11.5, marginBottom: 6 },
  captionStrong: { fontFamily: fonts.sans(700) },
  netWorth: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 13,
    paddingVertical: 10,
    marginTop: 18,
  },
  netWorthLabel: {
    fontFamily: fonts.mono(400),
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  netWorthValue: { fontFamily: fonts.mono(400), fontSize: 12, flexShrink: 1, ...MONO_FEATURES },
});
