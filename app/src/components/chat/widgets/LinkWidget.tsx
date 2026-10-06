import { Linking, StyleSheet, Text, View } from 'react-native';
import { fonts } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { Card } from '../../shell';
import type { LinkWidget as LinkWidgetT } from '../../../chat/widget';

function hostOf(url: string): string {
  const match = /^https:\/\/([^/?#]+)/i.exec(url);
  return match ? match[1].replace(/^www\./i, '') : url;
}

export function LinkWidget({ widget }: { widget: LinkWidgetT }) {
  const { t } = useTheme();
  return (
    <Card
      style={styles.card}
      accessibilityLabel={`${widget.title}, opens ${hostOf(widget.url)}`}
      onPress={() => void Linking.openURL(widget.url).catch(() => {})}
    >
      <View style={styles.row}>
        <View style={styles.text}>
          <Text style={[styles.title, { color: t('fg-0') }]} numberOfLines={2}>
            {widget.title}
          </Text>
          {widget.subtitle ? (
            <Text style={[styles.subtitle, { color: t('fg-2') }]} numberOfLines={2}>
              {widget.subtitle}
            </Text>
          ) : null}
          <Text style={[styles.host, { color: t('fg-3') }]} numberOfLines={1}>
            {hostOf(widget.url)}
          </Text>
        </View>
        <View style={[styles.chevron, { borderColor: t('fg-3') }]} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {},
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontFamily: fonts.sans(550), fontSize: 13.5 },
  subtitle: { fontFamily: fonts.sans(400), fontSize: 12, lineHeight: 17 },
  host: { fontFamily: fonts.mono(400), fontSize: 10.5, marginTop: 2 },
  // U+203A is a quotation mark, and Onest sets it high in its em box, so it
  // never sat on the optical centre. Drawn, it does (design review).
  chevron: {
    flexShrink: 0,
    width: 9,
    height: 9,
    borderRightWidth: 1.5,
    borderTopWidth: 1.5,
    transform: [{ rotate: '45deg' }],
  },
});
