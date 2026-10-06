// Provenance strip: when the snapshot landed, whether either source is limping.
// Amounts render on the Hub only — never in Telegram.
// 1:1 port of apps/hub/src/components/finance/SourcesFooter.tsx.
import { StyleSheet, Text, View } from 'react-native';
import type { FinanceSnapshot } from '../../lib/types';
import { relTime } from '../../shared/time';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';

function SourceBadge({ name, status }: { name: string; status: string }) {
  const { t } = useTheme();
  const bad = status !== 'ok';
  return (
    <View
      style={[
        styles.badge,
        {
          backgroundColor: t(bad ? 'status-warn-soft' : 'bg-1'),
          borderColor: t(bad ? 'status-warn-border' : 'border'),
        },
      ]}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.dot, { backgroundColor: t(bad ? 'status-warn' : 'status-up') }]}
      />
      <Text style={[styles.badgeLabel, { color: t(bad ? 'status-warn' : 'fg-3') }]}>
        {name}
        {bad ? ` · ${status}` : ''}
      </Text>
    </View>
  );
}

export function SourcesFooter({ snap }: { snap: FinanceSnapshot }) {
  const { t } = useTheme();
  // Snapshot may arrive truncated (schema drift, failed source build) — degrade
  // to neutral badges instead of crashing the Money screen.
  const plaidErrored = snap.sources?.plaid?.items_errored ?? [];
  const sources = snap.sources;
  return (
    <View style={[styles.footer, { borderTopColor: t('border') }]}>
      <View style={styles.badgeRow}>
        <SourceBadge name="copilot" status={sources?.copilot_mcp?.status ?? 'unknown'} />
        <SourceBadge name="plaid" status={sources?.plaid?.status ?? 'unknown'} />
        <Text style={[styles.asof, { color: t('fg-4') }]}>snapshot {relTime(snap.asof)}</Text>
      </View>
      {plaidErrored.length > 0 ? (
        <Text style={[styles.relink, { color: t('status-warn') }]}>
          plaid items needing relink: {plaidErrored.join(', ')}
        </Text>
      ) : null}
      <Text style={[styles.note, { color: t('fg-4') }]}>
        Amounts show only on the Hub, never in Telegram.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  footer: { marginTop: 24, paddingTop: 14, marginBottom: 8, borderTopWidth: 1 },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  dot: { width: 5, height: 5, borderRadius: 2.5 },
  badgeLabel: { fontFamily: fonts.mono(400), fontSize: 10 },
  asof: { fontFamily: fonts.mono(400), fontSize: 10 },
  relink: { fontFamily: fonts.mono(400), fontSize: 10, marginTop: 6 },
  note: { fontFamily: fonts.sans(400), fontSize: 11.5, marginTop: 10 },
});
