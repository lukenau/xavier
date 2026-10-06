// The page's first read: what went out today / 7d / 30d. Spend-first by design —
// net worth is deliberately secondary, at the bottom of the page.
// 1:1 port of apps/hub/src/components/finance/SpendHero.tsx.
import { StyleSheet, Text, View } from 'react-native';
import type { FinanceSnapshot } from '../../lib/types';
import { fmtUsd } from '../../shared/seriesColors';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';

export function SpendHero({ windows }: { windows: FinanceSnapshot['spend_windows'] }) {
  const { t } = useTheme();
  // Today is the thesis of the page — it carries the size and the gold. The
  // longer windows are supporting context, not co-stars.
  const tiles = [
    { v: windows?.today ?? 0, k: 'today', hero: true },
    { v: windows?.last_7d ?? 0, k: 'last 7d', hero: false },
    { v: windows?.last_30d ?? 0, k: 'last 30d', hero: false },
  ];
  return (
    <View style={styles.grid}>
      {tiles.map((tile) => (
        <View
          key={tile.k}
          style={[styles.tile, { backgroundColor: t('bg-1'), borderColor: t('border') }]}
        >
          <Text
            style={[
              tile.hero ? styles.heroValue : styles.value,
              { color: t(tile.hero ? 'accent-hi' : 'fg-1') },
            ]}
          >
            {fmtUsd(tile.v)}
          </Text>
          <Text style={[styles.label, { color: t('fg-4') }]}>{tile.k}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', gap: 9, marginBottom: 14 },
  tile: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 11,
    justifyContent: 'flex-end',
  },
  // letterSpacing is em in CSS, points in RN: -0.02em × the font size.
  heroValue: {
    fontFamily: fonts.mono(650),
    fontSize: 23,
    lineHeight: 26.45,
    letterSpacing: -0.46,
    ...MONO_FEATURES,
  },
  value: {
    fontFamily: fonts.mono(550),
    fontSize: 15,
    lineHeight: 17.25,
    letterSpacing: -0.3,
    ...MONO_FEATURES,
  },
  label: {
    fontFamily: fonts.mono(400),
    fontSize: 9.5,
    letterSpacing: 0.76,
    textTransform: 'uppercase',
    marginTop: 3,
  },
});
