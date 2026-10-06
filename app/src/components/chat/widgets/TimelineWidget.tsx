import { StyleSheet, Text, View } from 'react-native';
import { fonts, MONO_FEATURES } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { Card } from '../../shell';
import type { TimelineWidget as TimelineWidgetT } from '../../../chat/widget';
import { toneToken } from './tone';

/** A history, drawn as a spine. A checklist ticks, a calendar places things on
 *  a clock; a timeline is neither — it is the order things happened in, with a
 *  stamp against each. The time column is fixed-width so the labels line up
 *  down the page, and the spine carries the eye from one entry to the next. */
export function TimelineWidget({ widget }: { widget: TimelineWidgetT }) {
  const { t } = useTheme();

  return (
    <Card style={styles.card}>
      {widget.title ? <Text style={[styles.title, { color: t('fg-0') }]}>{widget.title}</Text> : null}

      <View style={styles.items}>
        {widget.items.map((item, index) => {
          const last = index === widget.items.length - 1;
          return (
            <View key={item.id} style={styles.row} testID={`timeline-item-${item.id}`}>
              <Text
                style={[styles.time, { color: t('fg-2') }, MONO_FEATURES]}
                numberOfLines={2}
              >
                {item.time ?? ''}
              </Text>
              <View style={styles.spine}>
                <View
                  style={[
                    styles.line,
                    { backgroundColor: t('border') },
                    last ? styles.lineLast : null,
                  ]}
                />
                <View
                  testID={`timeline-dot-${item.id}`}
                  style={[styles.dot, { backgroundColor: t(toneToken(item.tone)) }]}
                />
              </View>
              <View style={styles.body}>
                <Text style={[styles.label, { color: t('fg-1') }]}>{item.label}</Text>
                {item.detail ? <Text style={[styles.detail, { color: t('fg-2') }]}>{item.detail}</Text> : null}
              </View>
            </View>
          );
        })}
      </View>

      {widget.caption ? (
        <Text style={[styles.caption, { color: t('fg-3') }]}>{widget.caption}</Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: 9 },
  title: { fontFamily: fonts.sans(620), fontSize: 14.5, lineHeight: 20 },
  items: { gap: 0 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  // Wide enough for `Mon 9:04 AM` over two lines, narrow enough that most
  // stamps sit on one.
  time: {
    width: 62,
    textAlign: 'right',
    fontFamily: fonts.mono(400),
    fontSize: 10.5,
    lineHeight: 18,
    paddingTop: 1,
  },
  spine: { width: 12, alignSelf: 'stretch', alignItems: 'center' },
  line: { position: 'absolute', top: 0, bottom: 0, width: 1.5 },
  // The last entry's spine stops at its dot — a tail hanging below the final
  // dot reads as a truncated list.
  lineLast: { bottom: undefined, height: 9 },
  dot: { width: 7, height: 7, borderRadius: 4, marginTop: 5 },
  body: { flex: 1, minWidth: 0, gap: 1, paddingBottom: 12 },
  label: { fontFamily: fonts.sans(500), fontSize: 13, lineHeight: 19 },
  detail: { fontFamily: fonts.sans(400), fontSize: 11.5, lineHeight: 16 },
  caption: { fontFamily: fonts.sans(400), fontSize: 11, lineHeight: 15 },
});
