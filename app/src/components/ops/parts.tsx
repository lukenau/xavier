// Page-local chrome the Ops route and the System panel both repeat.
//
// `OpsCard` is deliberately NOT the shell `Card`: apps/hub carries four card
// paddings, and Ops.tsx:31-40 / SystemPanel.tsx:24-33 both use radius 14 with
// 16/14 padding, while shell/Card is radius 16 with 18/14.
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';

/** Ops.tsx / SystemPanel.tsx use `active:opacity-70` throughout, not the
 * shell Card's `active:opacity-80` (THEME-08 covers both). */
export const OPS_PRESSED = 0.7;

export function OpsCard({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { t } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: t('bg-1'), borderColor: t('border') }, style]}>
      {children}
    </View>
  );
}

/** parts.tsx:7-13 — 16px chevron in `--fg-3`. */
export function ChevronRight({ size = 16, tone = 'fg-3' }: { size?: number; tone?: 'fg-3' | 'fg-4' }) {
  const { t } = useTheme();
  return <SymbolView name="chevron.right" size={size} tintColor={t(tone)} weight="regular" />;
}

/** Ops.tsx:612 — `text-[12px] rounded-full px-[10px] py-[4px]`, the Shells /
 * Backups header pills. Disabled dims to 0.6 the way the PWA's `disabled:`
 * styles do at each call site. */
export function Pill({
  label,
  onPress,
  disabled,
  selected,
  color,
  background,
  borderColor,
  accessibilityLabel,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  selected?: boolean;
  color: string;
  background?: string;
  borderColor: string;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled), selected }}
      accessibilityLabel={accessibilityLabel ?? label}
      style={({ pressed }) => [
        styles.pill,
        { backgroundColor: background ?? 'transparent', borderColor },
        pressed && { opacity: OPS_PRESSED },
      ]}
    >
      <Text style={[styles.pillLabel, { color }]}>{label}</Text>
    </Pressable>
  );
}

/** A row inside an OpsCard: the PWA's `borderBottom` on every row but the last. */
export function rowDivider(hasBorder: boolean, border: string): ViewStyle | null {
  return hasBorder ? { borderBottomWidth: 1, borderBottomColor: border } : null;
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, borderWidth: 1 },
  pill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1 },
  pillLabel: { fontFamily: fonts.sans(400), fontSize: 12 },
});
