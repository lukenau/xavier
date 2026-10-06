// Native equivalents of the two CSS animations the shell primitives use:
// Tailwind's `animate-spin` (StatePanel's pending ring) and `animate-pulse`
// (Skeleton), plus the `prefers-reduced-motion` kill switch that globals.css
// applies to both (SHELL-20, globals.css:51-57).
//
// RN's own Animated is used rather than reanimated: both animations are pure
// transform/opacity loops, which run on the native driver, and neither needs a
// worklet. reanimated stays for the screen-level motion (Rise stagger,
// liveness ring) the port still owes.
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing } from 'react-native';

/** `prefers-reduced-motion: reduce`, live. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setReduced(value);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

// Tailwind `animate-pulse`: opacity 1 → .5 → 1 over 2s, cubic-bezier(.4,0,.6,1).
const PULSE_HALF_MS = 1000;
const PULSE_MIN_OPACITY = 0.5;
// Tailwind `animate-spin`: one linear turn per second.
const SPIN_MS = 1000;

/** Opacity value for a pulsing placeholder. Holds at 1 under reduced motion. */
export function usePulseOpacity(): Animated.Value {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduced) {
      value.setValue(1);
      return;
    }
    const easing = Easing.bezier(0.4, 0, 0.6, 1);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, {
          toValue: PULSE_MIN_OPACITY,
          duration: PULSE_HALF_MS,
          easing,
          useNativeDriver: true,
        }),
        Animated.timing(value, {
          toValue: 1,
          duration: PULSE_HALF_MS,
          easing,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduced, value]);
  return value;
}

/** `rotate` transform string for a spinner. Holds at 0deg under reduced motion. */
export function useSpinRotation(): Animated.AnimatedInterpolation<string> {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) {
      value.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(value, {
        toValue: 1,
        duration: SPIN_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [reduced, value]);
  return value.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
}
