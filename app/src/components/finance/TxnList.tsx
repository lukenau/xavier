// Every row wears a type chip — spend / income / transfer / payment / refund /
// fee / interest — so the list reads as "what kind of movement", not categories.
// 1:1 port of apps/hub/src/components/finance/TxnList.tsx.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { FinanceTxn } from '../../lib/types';
import {
  accountKeyLabel,
  deriveTxnType,
  isInflowType,
  isMaskKey,
  relDay,
  sourceLabel,
  TXN_COLORS,
  type AccountFlow,
  type TxnType,
} from '../../shared/financeModel';
import { fmtUsd } from '../../shared/seriesColors';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { seriesPaint } from '../charts/geometry';

const INITIAL = 12;

export function TypeChip({ type }: { type: TxnType }) {
  const { t } = useTheme();
  const c = TXN_COLORS[type];
  return (
    <View style={[styles.chip, { backgroundColor: seriesPaint(c.bg, t) }]}>
      <Text style={[styles.chipText, { color: seriesPaint(c.fg, t) }]}>{type}</Text>
    </View>
  );
}

export function TxnList({ txns, byLast4 }: { txns: FinanceTxn[]; byLast4: Map<string, AccountFlow> }) {
  const { t } = useTheme();
  const [expanded, setExpanded] = useState(false);
  if (txns.length === 0)
    return <Text style={[styles.empty, { color: t('fg-4') }]}>no recent transactions</Text>;

  const shown = expanded ? txns : txns.slice(0, INITIAL);
  return (
    <View style={[styles.card, { backgroundColor: t('bg-1'), borderColor: t('border') }]}>
      {shown.map((txn, i) => {
        const type = deriveTxnType(txn);
        const inflow = isInflowType(type);
        const acct = byLast4.get(txn.account_last4);
        // Disambiguated labels already end in the last4 — don't repeat it.
        const base =
          acct && acct.label.endsWith(acct.last4)
            ? acct.label.slice(0, -acct.last4.length).trimEnd()
            : acct?.label;
        const where = isMaskKey(txn.account_last4)
          ? base
            ? `${base} …${txn.account_last4}`
            : `…${txn.account_last4}`
          : (base ?? accountKeyLabel(txn.account_last4));
        return (
          <View
            key={`${txn.date}-${txn.merchant}-${txn.amount}-${i}`}
            style={[styles.row, i === 0 ? null : { borderTopWidth: 1, borderTopColor: t('border') }]}
          >
            <View style={styles.rowText}>
              <View style={styles.titleRow}>
                <Text numberOfLines={1} style={[styles.title, { color: t('fg-1') }]}>
                  {txn.merchant || txn.category || 'Transaction'}
                </Text>
                {txn.pending ? (
                  <Text style={[styles.pending, { color: t('status-warn') }]}>pending</Text>
                ) : null}
                <TypeChip type={type} />
              </View>
              <Text style={[styles.meta, { color: t('fg-4') }]}>
                {relDay(txn.date)} · {where} · {sourceLabel(txn.source)}
              </Text>
            </View>
            <Text style={[styles.amount, { color: t(inflow ? 'inflow' : 'fg-0') }]}>
              {inflow ? `+${fmtUsd(Math.abs(txn.amount))}` : fmtUsd(Math.abs(txn.amount))}
            </Text>
          </View>
        );
      })}
      {txns.length > INITIAL ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setExpanded((e) => !e)}
          style={({ pressed }) => [
            styles.more,
            { borderTopColor: t('border') },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.moreLabel, { color: t('fg-3') }]}>
            {expanded ? 'show less' : `show all ${txns.length}`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { fontFamily: fonts.mono(400), fontSize: 11, paddingVertical: 8 },
  card: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 6, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, paddingVertical: 8 },
  rowText: { flexShrink: 1, flexGrow: 1, flexBasis: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  title: { fontFamily: fonts.sans(500), fontSize: 13, maxWidth: 200 },
  pending: {
    fontFamily: fonts.mono(400),
    fontSize: 8.5,
    letterSpacing: 0.425,
    textTransform: 'uppercase',
  },
  chip: { borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1.5, flexShrink: 0 },
  chipText: {
    fontFamily: fonts.mono(700),
    fontSize: 8,
    letterSpacing: 0.48,
    textTransform: 'uppercase',
  },
  meta: { fontFamily: fonts.mono(400), fontSize: 10, marginTop: 2 },
  amount: { fontFamily: fonts.mono(400), fontSize: 13, flexShrink: 0, ...MONO_FEATURES },
  more: { paddingVertical: 10, alignItems: 'center', borderTopWidth: 1 },
  moreLabel: { fontFamily: fonts.mono(400), fontSize: 10.5 },
  pressed: { opacity: 0.7 },
});
