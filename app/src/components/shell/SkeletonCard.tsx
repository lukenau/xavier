// 1:1 port of apps/hub/src/components/shell/Skeleton.tsx — placeholders sized
// like the content they stand in for, so a screen mounts with stable geometry.
import { Animated, StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme/useTheme';
import { usePulseOpacity } from './motion';

export function SkeletonCard({ height = 96 }: { height?: number } = {}) {
  const { t } = useTheme();
  const opacity = usePulseOpacity();
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.card,
        { height, backgroundColor: t('skeleton'), borderColor: t('border') },
        { opacity },
      ]}
    />
  );
}

export function SkeletonRows({ rows = 3 }: { rows?: number } = {}) {
  const { t } = useTheme();
  const opacity = usePulseOpacity();
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.rows, { opacity }]}
    >
      {Array.from({ length: rows }, (_, i) => (
        <View
          key={i}
          style={[styles.row, { backgroundColor: t('skeleton'), borderColor: t('border') }]}
        />
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, width: '100%', borderWidth: 1 },
  rows: { flexDirection: 'column', gap: 10 },
  row: { borderRadius: 10, height: 44, borderWidth: 1 },
});
