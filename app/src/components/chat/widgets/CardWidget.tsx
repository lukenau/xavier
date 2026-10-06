import { StyleSheet, Text, View } from 'react-native';
import { fonts, MONO_FEATURES } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { Card } from '../../shell';
import type { CardWidget as CardWidgetT } from '../../../chat/widget';
import { toneToken } from './tone';

export function CardWidget({ widget }: { widget: CardWidgetT }) {
  const { t } = useTheme();
  return (
    <Card tone={widget.tone === 'accent' ? 'accent' : 'default'} style={styles.card}>
      {widget.title ? <Text style={[styles.title, { color: t('fg-0') }]}>{widget.title}</Text> : null}
      {widget.subtitle ? (
        <Text style={[styles.subtitle, { color: t('fg-3') }]}>{widget.subtitle}</Text>
      ) : null}
      {widget.body ? <Text style={[styles.body, { color: t('fg-1') }]}>{widget.body}</Text> : null}
      {widget.rows.length > 0 ? (
        <View style={styles.rows}>
          {widget.rows.map((row, i) => (
            <View key={`${row.label}-${i}`} style={styles.row}>
              <Text style={[styles.rowLabel, { color: t('fg-3') }]} numberOfLines={2}>
                {row.label}
              </Text>
              <View style={styles.rowRight}>
                {row.tone && row.tone !== 'neutral' ? (
                  <View style={[styles.dot, { backgroundColor: t(toneToken(row.tone)) }]} />
                ) : null}
                <Text
                  style={[styles.rowValue, { color: t('fg-1') }, MONO_FEATURES]}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {row.value}
                </Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {},
  title: { fontFamily: fonts.sans(600), fontSize: 14.5 },
  subtitle: { fontFamily: fonts.sans(400), fontSize: 12, marginTop: 2 },
  body: { fontFamily: fonts.sans(400), fontSize: 13, lineHeight: 19, marginTop: 8 },
  rows: { marginTop: 10, gap: 6 },
  // The label used to take `flex: 1`, which pushed a two-character value to the
  // far edge with 280px of nothing between them (design review, 2026-09-22).
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  rowLabel: { maxWidth: '55%', fontFamily: fonts.sans(400), fontSize: 12.5, lineHeight: 18 },
  rowRight: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  rowValue: { flexShrink: 1, fontFamily: fonts.mono(550), fontSize: 12.5, lineHeight: 18 },
});
