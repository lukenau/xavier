// Home's entrance stagger (Home.tsx:21-33): every block fades up 8px over
// 320ms, delayed 40ms per index. Indices are deliberately NOT unique in the
// PWA — several blocks share one, so they rise together.
//
// RN's own Animated rather than reanimated: opacity+translateY run on the
// native driver, and react-native-worklets (reanimated 4's required peer) is
// not installed in this app — see task-9-report.md.
import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing } from 'react-native';
import { useReducedMotion } from '../shell';

export const RISE_DURATION_MS = 320;
export const RISE_STAGGER_MS = 40;
export const RISE_OFFSET = 8;
/** `--ease-out` — the same cubic-bezier the PWA hands framer-motion. */
export const RISE_EASING = Easing.bezier(0.22, 1, 0.36, 1);

export function Rise({ index, children }: { index: number; children: ReactNode }) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduced) {
      progress.setValue(1);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: RISE_DURATION_MS,
      delay: index * RISE_STAGGER_MS,
      easing: RISE_EASING,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [index, progress, reduced]);

  // Reduced motion renders the children bare, with no wrapper at all — the
  // PWA's own escape hatch (Home.tsx:23).
  if (reduced) return <>{children}</>;

  return (
    <Animated.View
      style={{
        opacity: progress,
        transform: [
          { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [RISE_OFFSET, 0] }) },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}
