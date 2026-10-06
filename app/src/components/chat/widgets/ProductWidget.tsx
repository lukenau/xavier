// One `product` part, drawn — photo-led, the whole card taps through to `url`.
//
// The photo is a hotlinked https URL and is expected to fail sometimes; see
// shopBits.tsx for the pose fallback. A product with no price or no merchant is
// still drawable (the badge and the title carry it), so those rows are omitted
// rather than faked.
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { fonts, MONO_FEATURES } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { Card } from '../../shell';
import type { ProductWidget as ProductWidgetT } from '../../../chat/widget';
import { ShopImage } from './shopBits';
import { toneSoftToken, toneToken } from './tone';

export function ProductWidget({ widget }: { widget: ProductWidgetT }) {
  const { t } = useTheme();
  const sub = [widget.merchant, widget.rating !== null ? `★ ${widget.rating.toFixed(1)}` : null,
    widget.reviews !== null ? `${widget.reviews} reviews` : null].filter(Boolean).join(' · ');

  const body = (
    <Card style={styles.card}>
      <View style={styles.row}>
        <ShopImage uri={widget.image} size={72} />
        <View style={styles.text}>
          <Text style={[styles.title, { color: t('fg-0') }]} numberOfLines={2}>{widget.title}</Text>
          {sub ? <Text style={[styles.sub, { color: t('fg-3') }]} numberOfLines={1}>{sub}</Text> : null}
          <View style={styles.priceRow}>
            {widget.price ? (
              <Text style={[styles.price, { color: t('fg-0') }, MONO_FEATURES]}>{widget.price}</Text>
            ) : null}
            {widget.was ? (
              <Text style={[styles.was, { color: t('fg-4') }, MONO_FEATURES]}>{widget.was}</Text>
            ) : null}
            {widget.eta ? <Text style={[styles.eta, { color: t('fg-3') }]}>{widget.eta}</Text> : null}
          </View>
        </View>
        {widget.badge ? (
          <View style={[styles.badge, { backgroundColor: t(toneSoftToken(widget.badgeTone)) }]}>
            <Text style={[styles.badgeLabel, { color: t(toneToken(widget.badgeTone)) }]}>{widget.badge}</Text>
          </View>
        ) : null}
      </View>
    </Card>
  );

  if (!widget.url) return body;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${widget.title}${widget.price ? `, ${widget.price}` : ''} — opens listing`}
      onPress={() => void Linking.openURL(widget.url as string).catch(() => {})}
      style={({ pressed }) => (pressed ? styles.pressed : undefined)}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {},
  row: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  text: { flex: 1, minWidth: 0, gap: 3 },
  title: { fontFamily: fonts.sans(550), fontSize: 14, lineHeight: 19 },
  sub: { fontFamily: fonts.sans(400), fontSize: 11.5 },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 2, flexWrap: 'wrap' },
  price: { fontFamily: fonts.mono(600), fontSize: 15 },
  was: { fontFamily: fonts.mono(400), fontSize: 12, textDecorationLine: 'line-through' },
  eta: { fontFamily: fonts.sans(400), fontSize: 11.5 },
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, flexShrink: 0 },
  badgeLabel: { fontFamily: fonts.mono(550), fontSize: 10.5, letterSpacing: 0.4 },
  pressed: { opacity: 0.7 },
});
