// Why this exists: the flow chart shows shapes, not reasoning. When a number looks wrong
// the only way to check it was to read the raw JSON. This lists every movement under the
// bucket the server assigned it, with a plain-English reason, so a wrong assignment is
// visible instead of buried.
// 1:1 port of apps/hub/src/components/finance/MovementsBreakdown.tsx.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { FinanceMovement, FinanceMovementMeaning } from '../../lib/types';
import type { AccountFlow } from '../../shared/financeModel';
import { fmtUsd } from '../../shared/seriesColors';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';

const MEANING: Record<FinanceMovementMeaning, { label: string; why: string; inflow?: boolean }> = {
  income: { label: 'Income', why: 'Earned money entering from outside', inflow: true },
  interest: { label: 'Interest', why: 'Interest paid to you', inflow: true },
  reimbursement: { label: 'Reimbursements', why: 'You paid, someone paid you back — not income', inflow: true },
  refund: { label: 'Refunds', why: 'Money returned by a merchant', inflow: true },
  external_in: { label: 'Unclassified in', why: 'Arrived from outside; we could not tell what it was', inflow: true },
  spend: { label: 'Spend', why: 'Money leaving for goods and services' },
  card_payment: { label: 'Card payments', why: 'Paying off a card you track — moves debt, is not spending' },
  debt_payment: { label: 'Debt payments', why: 'Loan or untracked-card payment leaving the picture' },
  transfer: { label: 'Transfers', why: 'Between two accounts you track' },
  transfer_out: { label: 'Transfers out', why: 'To an account outside the picture' },
  invest: { label: 'Invested', why: 'Cash moved into an investment account' },
  divest: { label: 'Divested', why: 'Money taken out of an investment account' },
  conduit_leg: { label: 'Wallet leg', why: 'Movement through a pass-through wallet' },
  conduit_funding: { label: 'Wallet funding', why: 'Bank half of a Venmo movement — excluded so it is not counted twice' },
  reversed: { label: 'Reversed', why: 'A payment and its reversal — nets to zero' },
};

export function MovementsBreakdown({
  movements,
  byLast4,
}: {
  movements: FinanceMovement[];
  byLast4: Map<string, AccountFlow>;
}) {
  const { t } = useTheme();
  const [open, setOpen] = useState<string | null>(null);
  if (movements.length === 0) return null;

  const groups = new Map<string, FinanceMovement[]>();
  for (const m of movements) {
    const g = groups.get(m.meaning) ?? [];
    g.push(m);
    groups.set(m.meaning, g);
  }
  const total = (list: FinanceMovement[]) => list.reduce((s, m) => s + m.amount, 0);
  const ordered = [...groups.entries()].sort((a, b) => total(b[1]) - total(a[1]));

  const endpoint = (key: string): string => {
    if (key.startsWith('external:')) return key.slice(9) || 'outside';
    return byLast4.get(key)?.label ?? `…${key}`;
  };

  return (
    <View style={[styles.card, { backgroundColor: t('bg-1'), borderColor: t('border') }]}>
      <Text style={[styles.header, { color: t('fg-4') }]}>
        how money moved · {movements.length} movements
      </Text>
      {ordered.map(([meaning, list]) => {
        const meta = MEANING[meaning as FinanceMovementMeaning] ?? { label: meaning, why: '' };
        const isOpen = open === meaning;
        return (
          <View key={meaning} style={[styles.group, { borderTopColor: t('border') }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: isOpen }}
              onPress={() => setOpen(isOpen ? null : meaning)}
              style={({ pressed }) => [styles.groupHead, pressed && styles.pressed]}
            >
              <View style={styles.groupText}>
                <View style={styles.groupTitleRow}>
                  <Text style={[styles.groupLabel, { color: t('fg-1') }]}>{meta.label}</Text>
                  <Text style={[styles.groupCount, { color: t('fg-4') }]}>{list.length}</Text>
                </View>
                <Text style={[styles.why, { color: t('fg-4') }]}>{meta.why}</Text>
              </View>
              <Text
                style={[
                  styles.groupTotal,
                  { color: t(meaning === 'reversed' ? 'fg-4' : meta.inflow ? 'inflow' : 'fg-0') },
                  meaning === 'reversed' ? styles.struck : null,
                ]}
              >
                {meta.inflow ? `+${fmtUsd(total(list))}` : fmtUsd(total(list))}
              </Text>
            </Pressable>
            {isOpen ? (
              <View style={styles.detail}>
                {[...list]
                  .sort((a, b) => b.amount - a.amount)
                  .map((m, i) => (
                    <View key={`${m.date}-${m.counterparty}-${m.amount}-${i}`} style={styles.movement}>
                      <View style={styles.movementText}>
                        <Text numberOfLines={1} style={[styles.counterparty, { color: t('fg-2') }]}>
                          {m.counterparty || m.category || 'movement'}
                        </Text>
                        <Text style={[styles.movementMeta, { color: t('fg-4') }]}>
                          {m.date} · {endpoint(m.from)} → {endpoint(m.to)}
                          {m.confidence === 'single-sided' ? ' · one side only' : ''}
                        </Text>
                      </View>
                      <Text style={[styles.movementAmount, { color: t('fg-2') }]}>{fmtUsd(m.amount)}</Text>
                    </View>
                  ))}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 6, marginBottom: 12 },
  header: {
    fontFamily: fonts.mono(400),
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    paddingVertical: 10,
  },
  group: { borderTopWidth: 1 },
  groupHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 10,
  },
  groupText: { flexShrink: 1, flexGrow: 1, flexBasis: 0 },
  groupTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  groupLabel: { fontFamily: fonts.sans(500), fontSize: 13 },
  groupCount: { fontFamily: fonts.mono(400), fontSize: 10 },
  why: { fontFamily: fonts.mono(400), fontSize: 10, marginTop: 2 },
  groupTotal: { fontFamily: fonts.mono(400), fontSize: 13, flexShrink: 0, ...MONO_FEATURES },
  struck: { textDecorationLine: 'line-through' },
  detail: { paddingBottom: 8 },
  movement: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 5,
    paddingLeft: 10,
  },
  movementText: { flexShrink: 1, flexGrow: 1, flexBasis: 0 },
  counterparty: { fontFamily: fonts.sans(400), fontSize: 12 },
  movementMeta: { fontFamily: fonts.mono(400), fontSize: 9.5 },
  movementAmount: { fontFamily: fonts.mono(400), fontSize: 12, flexShrink: 0, ...MONO_FEATURES },
  pressed: { opacity: 0.7 },
});
