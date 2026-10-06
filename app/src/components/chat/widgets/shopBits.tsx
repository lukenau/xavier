// Shared bits for the shopping widgets (product / cart / order).
//
// A photo is a hotlinked https URL from the agent, and it is expected to fail
// sometimes: an item with NO photo draws a crop of Xavier's `portrait` pose, and
// a photo that fails to LOAD swaps to the `oops` pose (him catching the falling
// teacup). Never a hole in the card — a missing image is a normal state here,
// not an error. Reuses the app's existing pose assets; nothing new is generated.
import { useState } from 'react';
import { Image, StyleSheet, Text, View, type ImageStyle, type StyleProp } from 'react-native';
import { fonts, MONO_FEATURES } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { POSES } from '../../../whimsy/poses';

export function ShopImage({
  uri,
  size,
  style,
}: {
  uri: string | null;
  size: number;
  style?: StyleProp<ImageStyle>;
}) {
  const { t } = useTheme();
  const [failed, setFailed] = useState(false);
  const source = uri && !failed ? { uri } : POSES[failed ? 'oops' : 'portrait'];
  return (
    <Image
      source={source}
      onError={() => setFailed(true)}
      accessibilityIgnoresInvertColors
      style={[
        {
          width: size,
          height: size,
          borderRadius: 8,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderColor: t('border'),
          backgroundColor: t('bg-2'),
        },
        style,
      ]}
    />
  );
}

/** `×3` — omitted for a single unit, which is the common case. */
export function QtyBadge({ qty }: { qty: number | null }) {
  const { t } = useTheme();
  if (qty === null || qty <= 1) return null;
  return <Text style={[styles.qty, { color: t('fg-3') }]}>×{qty}</Text>;
}

export function TotalsRow({ label, value, strong }: { label: string; value: string | null; strong?: boolean }) {
  const { t } = useTheme();
  if (value === null) return null;
  return (
    <View style={styles.totalRow}>
      <Text style={[styles.totalLabel, { color: strong ? t('fg-1') : t('fg-3') }]}>{label}</Text>
      <Text
        style={[
          styles.totalValue,
          { color: strong ? t('fg-0') : t('fg-2'), fontFamily: fonts.mono(strong ? 600 : 400) },
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  qty: { fontFamily: fonts.mono(400), fontSize: 11 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingVertical: 1.5 },
  totalLabel: { fontFamily: fonts.sans(400), fontSize: 12 },
  totalValue: { fontSize: 12, ...MONO_FEATURES },
});
