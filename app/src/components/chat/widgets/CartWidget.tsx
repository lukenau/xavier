// One `cart` part, drawn — item rows then a totals block. The basket a purchase
// approval draws above its once/deny choices uses this same shape.
import { StyleSheet, Text, View } from 'react-native';
import { fonts, MONO_FEATURES } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { Card } from '../../shell';
import type { CartWidget as CartWidgetT } from '../../../chat/widget';
import { QtyBadge, ShopImage, TotalsRow } from './shopBits';

export function CartWidget({ widget }: { widget: CartWidgetT }) {
  const { t } = useTheme();
  const count = widget.items.reduce((n, it) => n + (it.qty ?? 1), 0);
  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <Text style={[styles.title, { color: t('fg-0') }]} numberOfLines={1}>
          {widget.title ?? 'Basket'}
        </Text>
        <Text style={[styles.count, { color: t('fg-3') }, MONO_FEATURES]}>
          {count} item{count === 1 ? '' : 's'}
        </Text>
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
        {widget.total ? (
          <View style={[styles.grand, { borderTopColor: t('border') }]}>
            <TotalsRow label="total" value={widget.total} strong />
          </View>
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {},
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  title: { fontFamily: fonts.sans(560), fontSize: 13.5, flex: 1, minWidth: 0 },
  count: { fontFamily: fonts.mono(400), fontSize: 10.5 },
  items: { marginTop: 10, gap: 10 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  itemText: { flex: 1, minWidth: 0, gap: 1 },
  itemName: { fontFamily: fonts.sans(500), fontSize: 13, lineHeight: 17 },
  itemPrice: { fontFamily: fonts.mono(500), fontSize: 12.5 },
  totals: { marginTop: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth * 2 },
  grand: { marginTop: 4, paddingTop: 5, borderTopWidth: StyleSheet.hairlineWidth * 2 },
});
