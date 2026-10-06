// Balances grouped by what the money *is* (cash / credit / investments), each
// account carrying its 30-day in/out bar when it moved money this window.
// 1:1 port of apps/hub/src/components/finance/AccountsStrip.tsx.
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  accountClass,
  accountLabels,
  cleanInstitution,
  isMaskKey,
  NEUTRAL,
  sourceLabel,
  type AccountClass,
  type FinanceAccount,
  type FlowGraph,
} from '../../shared/financeModel';
import { fmtUsd } from '../../shared/seriesColors';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { seriesPaint } from '../charts/geometry';

const GROUPS: { cls: AccountClass; label: string }[] = [
  { cls: 'cash', label: 'Cash' },
  { cls: 'credit', label: 'Credit' },
  { cls: 'investment', label: 'Investments' },
];

const COLLAPSED_PER_GROUP = 4;

/** U+2212 minus, then fmtUsd of the magnitude — fmtUsd itself prints `$0` for
 * anything ≤ 0 (OQ-22), which is why every signed figure comes through here. */
function fmtSigned(v: number): string {
  return v < 0 ? `−${fmtUsd(Math.abs(v))}` : fmtUsd(v);
}

export function AccountsStrip({ accounts, flows }: { accounts: FinanceAccount[]; flows: FlowGraph }) {
  const { t } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const labels = useMemo(() => accountLabels(accounts), [accounts]);
  const groups = useMemo(() => {
    const byCls = new Map<AccountClass, FinanceAccount[]>();
    for (const a of accounts) {
      const cls = accountClass(a.type);
      byCls.set(cls, [...(byCls.get(cls) ?? []), a]);
    }
    for (const list of byCls.values())
      list.sort(
        (a, b) =>
          (flows.byLast4.get(b.last4)?.total ?? 0) - (flows.byLast4.get(a.last4)?.total ?? 0) ||
          Math.abs(b.balance) - Math.abs(a.balance),
      );
    return byCls;
  }, [accounts, flows]);

  if (accounts.length === 0) return null;

  const maxFlow = Math.max(
    1,
    ...flows.accounts.map((f) =>
      Math.max(f.inflow + f.transferIn + f.paymentIn, f.spend + f.transferOut + f.paymentOut),
    ),
  );
  const hidden = GROUPS.reduce(
    (n, g) => n + Math.max(0, (groups.get(g.cls)?.length ?? 0) - COLLAPSED_PER_GROUP),
    0,
  );

  return (
    <View style={styles.strip}>
      {GROUPS.map((g) => {
        const list = groups.get(g.cls);
        if (!list || list.length === 0) return null;
        const total = list.reduce((s, a) => s + a.balance, 0);
        const shown = expanded ? list : list.slice(0, COLLAPSED_PER_GROUP);
        return (
          <View key={g.cls}>
            <View style={styles.groupHead}>
              <Text style={[styles.groupLabel, { color: t('fg-3') }]}>{g.label}</Text>
              <Text style={[styles.groupTotal, { color: t('fg-4') }]}>{fmtSigned(total)}</Text>
            </View>
            {shown.map((a) => {
              const f = flows.byLast4.get(a.last4);
              const moneyIn = f ? f.inflow + f.transferIn + f.paymentIn : 0;
              const moneyOut = f ? f.spend + f.transferOut + f.paymentOut : 0;
              const color = f?.color ?? NEUTRAL;
              return (
                <View
                  key={a.id || `${a.last4}-${a.name}`}
                  style={[styles.card, { backgroundColor: t('bg-1'), borderColor: t('border') }]}
                >
                  <View style={styles.cardRow}>
                    <View style={styles.identity}>
                      <View
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                        style={[styles.swatch, { backgroundColor: seriesPaint(color, t) }]}
                      />
                      <Text numberOfLines={1} style={[styles.name, { color: t('fg-0') }]}>
                        {labels.get(a) ?? cleanInstitution(a.institution)}
                      </Text>
                      <Text style={[styles.meta, { color: t('fg-4') }]}>
                        {isMaskKey(a.last4) ? `…${a.last4} · ` : ''}
                        {sourceLabel(a.source)}
                      </Text>
                    </View>
                    <Text
                      style={[styles.balance, { color: t(a.balance < 0 ? 'fg-1' : 'accent-hi') }]}
                    >
                      {fmtSigned(a.balance)}
                    </Text>
                  </View>
                  {moneyIn > 0 || moneyOut > 0 ? (
                    <>
                      <View style={[styles.bar, { backgroundColor: t('bg-0') }]}>
                        <View
                          style={{
                            backgroundColor: t('inflow'),
                            width: `${Math.max(2, (moneyIn / maxFlow) * 100)}%`,
                            borderRadius: 2,
                          }}
                        />
                        <View
                          style={{
                            backgroundColor: seriesPaint(color, t),
                            width: `${Math.max(2, (moneyOut / maxFlow) * 100)}%`,
                            borderRadius: 2,
                          }}
                        />
                      </View>
                      <View style={styles.flowRow}>
                        <Text style={[styles.flowLabel, { color: t('inflow') }]}>
                          ↓ in {fmtUsd(moneyIn)}
                        </Text>
                        <Text style={[styles.flowLabel, { color: t('fg-3') }]}>
                          ↑ out {fmtUsd(moneyOut)}
                        </Text>
                      </View>
                    </>
                  ) : null}
                </View>
              );
            })}
          </View>
        );
      })}
      {hidden > 0 && !expanded ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setExpanded(true)}
          style={({ pressed }) => [
            styles.more,
            { backgroundColor: t('bg-1'), borderColor: t('border') },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.moreLabel, { color: t('fg-3') }]}>show {hidden} more accounts</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { marginBottom: 12 },
  groupHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 16,
    marginBottom: 8,
  },
  groupLabel: {
    fontFamily: fonts.mono(400),
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  groupTotal: {
    fontFamily: fonts.mono(400),
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    ...MONO_FEATURES,
  },
  card: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 13,
    paddingVertical: 11,
    marginBottom: 8,
  },
  cardRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  swatch: { width: 8, height: 8, borderRadius: 2, flexShrink: 0 },
  name: { fontFamily: fonts.sans(550), fontSize: 13.5, flexShrink: 1 },
  meta: { fontFamily: fonts.mono(400), fontSize: 10, flexShrink: 0 },
  balance: { fontFamily: fonts.mono(600), fontSize: 14, flexShrink: 0, ...MONO_FEATURES },
  bar: { flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden', gap: 2, marginTop: 9 },
  flowRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 },
  flowLabel: { fontFamily: fonts.mono(400), fontSize: 9.5 },
  more: { borderRadius: 12, borderWidth: 1, paddingVertical: 10, alignItems: 'center' },
  moreLabel: { fontFamily: fonts.mono(400), fontSize: 10.5 },
  pressed: { opacity: 0.7 },
});
