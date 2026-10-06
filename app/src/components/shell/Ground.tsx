// The two corner washes, painted as rings of translucent circles rather than
// the way the PWA does.
//
// OWNER-REQUESTED DEVIATION FROM PWA PARITY (the user, 2026-09-11): the ringed
// background pattern was asked for by name. The PWA renders `--wash` as two
// CSS `radial-gradient()` layers; RN 0.86 does parse that string via
// `experimental_backgroundImage`, so this is a look preference, not a fix. Do
// not revert it to the gradient in a parity sweep.
//
// React Native has no radial gradient and this app takes no new dependencies,
// so each wash is four concentric translucent circles centred on its corner:
// every ring adds the same small alpha and their overlap falls off toward the
// edge the way the gradient's `transparent 62%` stop does.
import { useMemo } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme/useTheme';

/** The ring diameters — the widest matches `--wash`'s 620px major axis. */
export const WASH_RINGS = [620, 480, 350, 230];

export interface WashSpec {
  /** `r, g, b` channels, ready to interpolate into an `rgba(...)` string. */
  rgb: string;
  /** Per-ring alpha: RINGS of it composite back to the gradient's peak alpha. */
  alpha: number;
  /** Gradient centre, as the `at X% Y%` percentages. */
  x: number;
  y: number;
}

const WASH_LAYER =
  /at\s+([\d.]+)%\s+([\d.]+)%\s*,\s*rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/g;

/**
 * Alpha for one ring such that `WASH_RINGS.length` of them stacked composite
 * to `peak` — the inverse of `1 - (1 - a)^n`. Hardcoding per-ring alphas
 * would fit one palette; deriving them keeps the Hub's own wash strength and
 * makes the light theme (a different colour pair entirely) come out right.
 */
export function ringAlpha(peak: number, rings = WASH_RINGS.length): number {
  return 1 - (1 - peak) ** (1 / rings);
}

/** Pulls the corner, colour and peak alpha out of the `--wash` token's gradient layers. */
export function parseWash(wash: string): WashSpec[] {
  const specs: WashSpec[] = [];
  for (const m of wash.matchAll(WASH_LAYER)) {
    specs.push({
      x: Number(m[1]),
      y: Number(m[2]),
      rgb: `${Number(m[3])},${Number(m[4])},${Number(m[5])}`,
      alpha: ringAlpha(Number(m[6])),
    });
  }
  return specs;
}

function ringStyle(spec: WashSpec, d: number): ViewStyle {
  const half = d / 2;
  return {
    position: 'absolute',
    width: d,
    height: d,
    borderRadius: half,
    backgroundColor: `rgba(${spec.rgb},${spec.alpha})`,
    ...(spec.x >= 50 ? { right: -half } : { left: -half }),
    ...(spec.y >= 50 ? { bottom: -half } : { top: -half }),
  };
}

/**
 * Absolutely-filled wash layer. Mount it behind a screen's content (Screen
 * does), never around it: unlike the PWA's background-image it is pinned to
 * the viewport, so the bottom-left wash stays at the bottom of the screen
 * instead of riding to the bottom of a long document.
 */
export function Ground() {
  const { t } = useTheme();
  const wash = t('wash');
  const specs = useMemo(() => parseWash(wash), [wash]);
  return (
    <View pointerEvents="none" style={styles.ground} testID="ground">
      {specs.map((spec) =>
        WASH_RINGS.map((d) => <View key={`${spec.rgb}-${d}`} style={ringStyle(spec, d)} />),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // overflow:hidden so a 620px ring on a 390pt screen cannot paint over the
  // tab bar or a pushed screen's chrome.
  ground: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' },
});
