// `pulse-up` (globals.css:40-43) as a native animation:
//
//   0%,100% { box-shadow: 0 0 0 0    var(--status-up-glow), 0 0 12px … }
//   50%     { box-shadow: 0 0 0 6px  transparent,            0 0 12px … }
//
// A spread shadow with no blur is a solid rounded rect the size of the
// element grown by the spread, painted BEHIND it — so through a translucent
// avatar you see it, and the visible motion is a disc growing out of the
// element and fading. RN cannot animate `boxShadow`, so the equivalent is a
// sibling view of the element's own size, filled with `--status-up-glow`,
// scaling to (r + spread)/r and fading on the native driver.
//
// The envelope matters as much as the shape: the CSS reaches full spread AND
// full transparency at the halfway mark, so the second half of every cycle is
// (all but) still. A single timing stretched over the whole duration reads at
// half speed, which is why this is a timing + a delay rather than one timing.
// `Animated.loop` resets the value before each iteration, which is the CSS's
// own 100%→0% wrap: both ends are a zero-spread, full-colour ring.
//
// Two call sites, two rates: the Xavier avatar (2.4s) and the BrowserCard
// live dot (1.8s). Frozen under reduced motion (globals.css:51-57).
import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { useReducedMotion } from '../shell';

/** The keyframes' own timing function, applied to the growing half. */
const PULSE_EASING = Easing.bezier(0.4, 0, 0.2, 1);

/** Grow-and-fade occupies the first half of the cycle; the rest is still. */
export const PULSE_DUTY = 0.5;

/** Scale a `--status-up-glow` halo reaches for an element radius + spread. */
export function pulseScale(radius: number, spread = 6): number {
  return (radius + spread) / radius;
}

export function usePulseRing(active: boolean, durationMs: number): Animated.Value {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active || reduced) {
      value.setValue(0);
      return;
    }
    const grow = durationMs * PULSE_DUTY;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, {
          toValue: 1,
          duration: grow,
          easing: PULSE_EASING,
          useNativeDriver: true,
        }),
        Animated.delay(durationMs - grow),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, durationMs, reduced, value]);
  return value;
}

/** One linear turn per cycle — `ring-rotate`, and `animate-spin` at 1000ms. */
export function useSpin(active: boolean, durationMs: number): Animated.AnimatedInterpolation<string> {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active || reduced) {
      value.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(value, {
        toValue: 1,
        duration: durationMs,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [active, durationMs, reduced, value]);
  return value.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
}
