import { StyleSheet, Text, View } from 'react-native';
import { fonts, MONO_FEATURES } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { Card } from '../../shell';
import type { ProgressWidget as ProgressWidgetT } from '../../../chat/widget';
import { fillToken } from './tone';

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function ProgressWidget({ widget }: { widget: ProgressWidgetT }) {
  const { t } = useTheme();
  const pct = (widget.value / widget.total) * 100;
  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        {widget.label ? (
          <Text style={[styles.label, { color: t('fg-1') }]}>{widget.label}</Text>
        ) : null}
        <Text style={[styles.pct, { color: t('fg-0') }, MONO_FEATURES]}>{`${Math.round(pct)}%`}</Text>
      </View>
      <View
        style={[styles.track, { backgroundColor: t('bg-3'), borderColor: t('border') }]}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: widget.total, now: widget.value }}
      >
        <View style={{ width: `${pct}%`, backgroundColor: t(fillToken(widget.tone)) }} />
      </View>
      <Text style={[styles.caption, { color: t('fg-3') }, MONO_FEATURES]}>
        {widget.caption ? `${fmt(widget.value)} / ${fmt(widget.total)} · ${widget.caption}` : `${fmt(widget.value)} / ${fmt(widget.total)}`}
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {},
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 12 },
  label: { flex: 1, minWidth: 0, fontFamily: fonts.sans(520), fontSize: 13 },
  // The percentage was computed for the bar width and then thrown away; the
  // fraction is the footnote, not the headline (design review, 2026-09-22).
  pct: { flexShrink: 0, marginLeft: 'auto', fontFamily: fonts.mono(600), fontSize: 18 },
  track: {
    flexDirection: 'row',
    height: 6,
    borderRadius: 3,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    marginTop: 8,
  },
  caption: { fontFamily: fonts.mono(400), fontSize: 10.5, letterSpacing: 0.3, marginTop: 6 },
});
