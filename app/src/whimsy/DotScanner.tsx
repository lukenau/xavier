// A five-dot LED scanner: one gold dot runs back and forth across a dim row.
// Xavier's "working" glyph wherever a full tile would be too big.
import { memo, useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/useTheme';
import { useWhimsy } from './level';

const DOTS = 5;
const DOT = 4;
const GAP = 3;

// Memoized, with the interpolation built once: the chat thread re-renders on every
// streamed delta, and a fresh interpolate() node each render made the native-driven
// dot re-attach and flick toward its start — the "jumpy" scanner.
export const DotScanner = memo(function DotScanner() {
  const { t } = useTheme();
  const { motion } = useWhimsy();
  const x = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    if (!motion) return;
    x.setValue(0);
    const l = Animated.loop(
      Animated.sequence([
        Animated.timing(x, { toValue: 1, duration: 520, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(x, { toValue: 0, duration: 520, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    l.start();
    return () => l.stop();
  }, [motion, x]);
  const translateX = useMemo(
    () => x.interpolate({ inputRange: [0, 1], outputRange: [0, (DOTS - 1) * (DOT + GAP)] }),
    [x],
  );
  return (
    <View style={styles.row} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: DOTS }, (_, i) => (
        <View key={i} style={[styles.dot, { backgroundColor: t('border-strong') }]} />
      ))}
      <Animated.View
        style={[
          styles.dot,
          styles.head,
          {
            backgroundColor: t('accent'),
            boxShadow: t('glow-accent'),
            transform: [{ translateX }],
          },
        ]}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: GAP },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
  head: { position: 'absolute', left: 0 },
});
