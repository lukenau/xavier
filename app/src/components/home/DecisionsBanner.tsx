// Decision Inbox banner (Home.tsx:103-145): rendered ONLY while cards are
// open, pinned above the fold — the queue is the single highest-signal "needs
// the user" state the estate has. The headline is stakes-honest ("2 need your
// answer · 5 your call"), never a flat count that overstates urgency.
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import type { Decision } from '../../lib/types';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { Card } from '../shell';
import { decisionsBannerView } from './homeState';

export function DecisionsBanner({ decisions }: { decisions: Decision[] }) {
  const { t } = useTheme();
  const view = decisionsBannerView(decisions);
  if (!view) return null;

  return (
    <Card
      tone="accent"
      onPress={() => router.push('/decisions')}
      accessibilityLabel={view.headline}
      style={styles.card}
    >
      <View style={styles.row}>
        <SymbolView name="checklist" size={18} tintColor={t('accent')} weight="regular" />
        <View style={styles.text}>
          <Text style={[styles.headline, { color: t('accent') }]}>{view.headline}</Text>
          {view.subline ? (
            <Text
              style={[styles.subline, { color: t('fg-2') }]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {view.subline}
            </Text>
          ) : null}
        </View>
        <SymbolView name="chevron.right" size={15} tintColor={t('accent')} weight="semibold" />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingHorizontal: 16, paddingVertical: 13, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  text: { flex: 1, minWidth: 0 },
  headline: { fontFamily: fonts.sans(600), fontSize: 14.5 },
  subline: { fontFamily: fonts.sans(400), fontSize: 11.5, marginTop: 1 },
});
