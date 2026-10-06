// Money's entry point on Home — the one card here with no PWA original.
//
// Money stopped being a tab in the native IA, so Home is now the ONLY way in:
// this card always renders, even when the finance snapshot is missing, so the
// route can never become unreachable. Deliberately chart-free — the Money
// screen is the dashboard; this is a door with a number on it.
//
// The number is `spend_windows.last_30d`, one of SpendHero's three hero
// figures (apps/hub/src/components/finance/SpendHero.tsx:11-15), formatted by
// the shared `fmtUsd`. It is labelled `last 30d`, not `this month`: the
// snapshot carries no month-to-date total (only per-budget-category
// `month_to_date` rows, which cover budgeted categories only), and a rolling
// 30-day sum shown as "this month" would read several times too high early in
// a month. See task-9-report.md.
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import type { FinanceSnapshot } from '../../lib/types';
import { fmtUsd } from '../../shared/seriesColors';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { Card } from '../shell';

/** `$1,200 last 30d`, or the plain descriptor while there is no snapshot. */
export function moneyLine(finance: FinanceSnapshot | null | undefined): string {
  if (!finance) return 'personal spend & accounts';
  // Older/failure snapshots can lack spend_windows entirely — show $0 rather
  // than crashing the Home tab (public-repo graceful-degradation rule).
  return `${fmtUsd(finance.spend_windows?.last_30d ?? 0)} last 30d`;
}

export function MoneyEntryCard({ finance }: { finance: FinanceSnapshot | null | undefined }) {
  const { t } = useTheme();
  const line = moneyLine(finance);

  return (
    <Card
      onPress={() => router.push('/finance')}
      accessibilityLabel={`Money — ${line}`}
      style={styles.card}
    >
      <View style={styles.row}>
        <SymbolView name="wallet.pass" size={18} tintColor={t('accent')} weight="regular" />
        <View style={styles.text}>
          <Text style={[styles.title, { color: t('fg-0') }]}>Money</Text>
          <Text style={[styles.line, { color: t('fg-4') }]} numberOfLines={1} ellipsizeMode="tail">
            {line}
          </Text>
        </View>
        <SymbolView name="chevron.right" size={15} tintColor={t('fg-4')} weight="regular" />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingHorizontal: 16, paddingVertical: 13, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  text: { flex: 1, minWidth: 0 },
  title: { fontFamily: fonts.sans(580), fontSize: 15 },
  line: { fontFamily: fonts.mono(400), fontSize: 10.5, marginTop: 2, ...MONO_FEATURES },
});
