import { StyleSheet, Text, View } from 'react-native';
import { fonts, MONO_FEATURES } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { Card } from '../../shell';
import type { MetricWidget as MetricWidgetT } from '../../../chat/widget';
import { toneSoftToken, toneToken } from './tone';

export function MetricWidget({ widget }: { widget: MetricWidgetT }) {
  const { t } = useTheme();
  return (
    <Card style={styles.card}>
      <Text style={[styles.label, { color: t('fg-2') }]}>{widget.label}</Text>
      <View style={styles.valueRow}>
        <Text style={[styles.value, { color: t('fg-0') }, MONO_FEATURES]}>{widget.value}</Text>
        {widget.unit ? <Text style={[styles.unit, { color: t('fg-3') }]}>{widget.unit}</Text> : null}
        {widget.delta ? (
          <View style={[styles.delta, { backgroundColor: t(toneSoftToken(widget.deltaTone)) }]}>
            <Text style={[styles.deltaLabel, { color: t(toneToken(widget.deltaTone)) }, MONO_FEATURES]}>
              {widget.delta}
            </Text>
          </View>
        ) : null}
      </View>
      {widget.caption ? (
        <Text style={[styles.caption, { color: t('fg-3') }]}>{widget.caption}</Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { },
  label: { fontFamily: fonts.mono(550), fontSize: 9, letterSpacing: 1.1, textTransform: 'uppercase' },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  value: { fontFamily: fonts.mono(600), fontSize: 26 },
  unit: { fontFamily: fonts.sans(400), fontSize: 13 },
  delta: { borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 },
  deltaLabel: { fontFamily: fonts.mono(550), fontSize: 11 },
  caption: { fontFamily: fonts.sans(400), fontSize: 12, lineHeight: 17, marginTop: 6 },
});
