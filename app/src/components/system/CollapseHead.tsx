// SystemPanel.tsx:35-81 — SectionHead's type and spacing plus a chevron
// toggle. Long lists (skills, plugins) fold behind this so the next section is
// reachable without scrolling the whole list; the count stays visible while
// collapsed, so the header still reads as a summary.
import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { SECTION_HEAD_TEXT_STYLE, useReducedMotion } from '../shell';
import { OPS_PRESSED } from '../ops/parts';
import { useTheme } from '../../theme/useTheme';

/** `transition: transform 0.2s var(--ease-spring)` (SystemPanel.tsx:71). */
const ROTATE_MS = 200;

export function CollapseHead({
  label,
  count,
  open,
  onToggle,
}: {
  label: string;
  count?: string;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTheme();
  const reduceMotion = useReducedMotion();
  const progress = useRef(new Animated.Value(open ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration: reduceMotion ? 0 : ROTATE_MS,
      useNativeDriver: true,
    }).start();
  }, [open, progress, reduceMotion]);

  const rotate = progress.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '90deg'] });

  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      style={({ pressed }) => [styles.row, pressed && { opacity: OPS_PRESSED }]}
    >
      <View style={styles.left}>
        <Animated.View style={{ transform: [{ rotate }] }}>
          <SymbolView name="chevron.right" size={11} tintColor={t('fg-4')} weight="semibold" />
        </Animated.View>
        <Text style={[styles.label, { color: t('fg-3') }]}>{label}</Text>
      </View>
      {count ? <Text style={[styles.label, { color: t('fg-4') }]}>{count}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // pt-2 pb-3 px-1, same as SectionHead's row.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 8,
    paddingBottom: 12,
    paddingHorizontal: 4,
  },
  left: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  label: SECTION_HEAD_TEXT_STYLE,
});
