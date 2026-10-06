// Glanceable agent spend (SpendCard.tsx:16-135): today's hourly burn, stacked
// by provider, with MTD as the anchor. Today's figure wears the gold numeral —
// the signature. Taps through to Cost for the full picture.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import type { SpendSummary, SpendTimeseries } from '../../lib/types';
import { fmtTokens, fmtUsd, shortModel } from '../../shared/seriesColors';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY } from '../shell';
import { StackedBars } from '../charts/StackedBars';
import {
  fmtHour,
  pointsOf,
  selectedModels,
  selectedPoint,
  selectionHeader,
  spendBuckets,
  spendSeries,
  todayEyebrow,
  todayTotal,
} from './spendCardModel';

export function SpendCard({
  today,
  mtd,
  todaySummary,
}: {
  today: SpendTimeseries | undefined;
  mtd: SpendSummary | undefined;
  todaySummary: SpendSummary | undefined;
}) {
  const { t } = useTheme();
  const [selected, setSelected] = useState<number | null>(null);
  const points = pointsOf(today);
  const buckets = spendBuckets(points, todaySummary);
  const sel = selectedPoint(points, selected);
  const selModels = selectedModels(sel);

  return (
    <View style={[styles.card, { backgroundColor: t('bg-1'), borderColor: t('border') }]}>
      <View style={styles.head}>
        <View style={styles.headLeft}>
          <Text style={[styles.total, { color: t('accent-hi') }]}>{fmtUsd(todayTotal(points, todaySummary))}</Text>
          <Text style={[styles.eyebrow, { color: t('fg-4') }]}>{todayEyebrow(todaySummary)}</Text>
        </View>
        <Text style={[styles.mtd, { color: t('fg-3') }]}>{mtd ? `mtd ${fmtUsd(mtd.total_usd)}` : ''}</Text>
      </View>

      {buckets.length > 0 ? (
        <StackedBars
          buckets={buckets}
          series={spendSeries(points, todaySummary)}
          height={44}
          showGrid={false}
          tickFormat={fmtHour}
          selected={selected}
          onSelect={setSelected}
          ariaTitle="Hourly spend today, stacked by provider"
        />
      ) : (
        <Text style={[styles.empty, { color: t('fg-4') }]}>no usage yet today</Text>
      )}

      {sel ? (
        <View style={[styles.detail, { backgroundColor: t('bg-0'), borderColor: t('border') }]}>
          <View style={styles.detailHead}>
            <Text style={[styles.detailTitle, { color: t('fg-1') }]}>
              {selectionHeader(sel, fmtTokens)}
            </Text>
            <Text style={[styles.detailTotal, { color: t('fg-0') }]}>{fmtUsd(sel.spend_usd)}</Text>
          </View>
          {selModels.length > 0 ? (
            selModels.map(([model, usd], i) => (
              <View
                key={model}
                style={[styles.modelRow, i > 0 && { borderTopWidth: 1, borderTopColor: t('border') }]}
              >
                <Text
                  style={[styles.modelName, { color: t('fg-2') }]}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {shortModel(model)}
                </Text>
                <Text style={[styles.modelUsd, { color: t('fg-1') }]}>{fmtUsd(usd)}</Text>
              </View>
            ))
          ) : (
            <Text style={[styles.modelName, { color: t('fg-4') }]}>no usage this hour</Text>
          )}
        </View>
      ) : null}

      <Pressable
        accessibilityRole="link"
        accessibilityLabel="Open cost"
        onPress={() => router.push('/ops/cost')}
        style={({ pressed }) => [styles.link, pressed && { opacity: PRESSED_OPACITY }]}
      >
        <Text style={[styles.linkText, { color: t('accent') }]}>open cost</Text>
        <SymbolView name="chevron.right" size={12} tintColor={t('accent')} weight="semibold" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 13,
    marginBottom: 12,
  },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 },
  headLeft: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  total: { fontFamily: fonts.mono(600), fontSize: 18, ...MONO_FEATURES },
  eyebrow: { fontFamily: fonts.mono(400), fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
  mtd: { fontFamily: fonts.mono(400), fontSize: 11, ...MONO_FEATURES },
  empty: { fontFamily: fonts.mono(400), fontSize: 11, paddingVertical: 10 },
  detail: { marginTop: 8, borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 9 },
  detailHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 },
  detailTitle: { fontFamily: fonts.mono(550), fontSize: 11, flexShrink: 1 },
  detailTotal: { fontFamily: fonts.mono(600), fontSize: 12, ...MONO_FEATURES },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 4,
  },
  modelName: { fontFamily: fonts.mono(400), fontSize: 11, flex: 1, minWidth: 0 },
  modelUsd: { fontFamily: fonts.mono(400), fontSize: 11, ...MONO_FEATURES },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
    marginTop: 8,
    minHeight: 28,
  },
  linkText: { fontFamily: fonts.mono(400), fontSize: 10.5 },
});
