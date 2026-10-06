// One `order` part, drawn — a receipt: order id + when, items, totals, then the
// fulfilment lines a receipt actually carries (payment, address, arrival). Every
// field here is optional except the id, the items and the total; absent rows are
// omitted rather than filled with a placeholder.
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { fonts, MONO_FEATURES } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { Card } from '../../shell';
import type { OrderWidget as OrderWidgetT } from '../../../chat/widget';
import { QtyBadge, ShopImage, TotalsRow } from './shopBits';

function Line({ label, value }: { label: string; value: string | null }) {
  const { t } = useTheme();
  if (!value) return null;
  return (
    <View style={styles.line}>
      <Text style={[styles.lineLabel, { color: t('fg-3') }]}>{label}</Text>
      <Text style={[styles.lineValue, { color: t('fg-1') }]} selectable>{value}</Text>
    </View>
  );
}

export function OrderWidget({ widget }: { widget: OrderWidgetT }) {
  const { t } = useTheme();
  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={[styles.kicker, { color: t('fg-3') }]}>order</Text>
          <Text style={[styles.orderId, { color: t('fg-0') }, MONO_FEATURES]} selectable>
            {widget.orderId}
          </Text>
        </View>
        {widget.placed ? (
          <Text style={[styles.placed, { color: t('fg-3') }]} numberOfLines={1}>{widget.placed}</Text>
        ) : null}
      </View>

      <View style={styles.items}>
        {widget.items.map((it, i) => (
          <View key={`${it.name}-${i}`} style={styles.item}>
            <ShopImage uri={it.image} size={40} />
            <View style={styles.itemText}>
              <Text style={[styles.itemName, { color: t('fg-1') }]} numberOfLines={2}>{it.name}</Text>
              <QtyBadge qty={it.qty} />
            </View>
            <Text style={[styles.itemPrice, { color: t('fg-0') }, MONO_FEATURES]}>{it.price}</Text>
          </View>
        ))}
      </View>

      <View style={[styles.totals, { borderTopColor: t('border') }]}>
        <TotalsRow label="subtotal" value={widget.subtotal} />
        <TotalsRow label="shipping" value={widget.shipping} />
        <TotalsRow label="tax" value={widget.tax} />
        {widget.promo ? <TotalsRow label="promo" value={`−${widget.promo}`} /> : null}
        <View style={[styles.grand, { borderTopColor: t('border') }]}>
          <TotalsRow label="total" value={widget.total} strong />
        </View>
      </View>

      <View style={[styles.meta, { borderTopColor: t('border') }]}>
        <Line label="payment" value={widget.payment} />
        <Line label="ship to" value={widget.address} />
        <Line label="eta" value={widget.eta} />
      </View>

      {widget.url ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="open order"
          onPress={() => void Linking.openURL(widget.url as string).catch(() => {})}
          style={({ pressed }) => [styles.linkRow, pressed ? styles.pressed : undefined]}
        >
          <Text style={[styles.link, { color: t('accent') }]}>view order →</Text>
        </Pressable>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {},
  head: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 },
  headText: { flex: 1, minWidth: 0, gap: 1 },
  kicker: { fontFamily: fonts.mono(550), fontSize: 9, letterSpacing: 1.1, textTransform: 'uppercase' },
  orderId: { fontFamily: fonts.mono(600), fontSize: 14 },
  placed: { fontFamily: fonts.sans(400), fontSize: 11.5 },
  items: { marginTop: 10, gap: 10 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  itemText: { flex: 1, minWidth: 0, gap: 1 },
  itemName: { fontFamily: fonts.sans(500), fontSize: 13, lineHeight: 17 },
  itemPrice: { fontFamily: fonts.mono(500), fontSize: 12.5 },
  totals: { marginTop: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth * 2 },
  grand: { marginTop: 4, paddingTop: 5, borderTopWidth: StyleSheet.hairlineWidth * 2 },
  meta: { marginTop: 10, paddingTop: 8, gap: 3, borderTopWidth: StyleSheet.hairlineWidth * 2 },
  line: { flexDirection: 'row', gap: 8 },
  lineLabel: { fontFamily: fonts.mono(400), fontSize: 10.5, letterSpacing: 0.4, width: 62 },
  lineValue: { fontFamily: fonts.sans(400), fontSize: 12, flex: 1, minWidth: 0 },
  linkRow: { marginTop: 10 },
  link: { fontFamily: fonts.sans(550), fontSize: 12.5 },
  pressed: { opacity: 0.7 },
});
