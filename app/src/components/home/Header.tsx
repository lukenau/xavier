// Home's header (Header.tsx:43-126): two rows on the left — the wordmark with
// its liveness dot, then the descriptor · date line — and four 32px controls
// on the right.
//
// The mark carries the brand colour, not --fg-0: a wordmark is the canonical
// accent use, and it doubles as agent state (--accent-hi plus the glow while
// the agent is working). A greeting derived from a possibly-stale health feed
// would be worse than none — the dot is honest instead, going grey when the
// feed stops reporting.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import type { HealthSummary } from '../../lib/types';
import { refreshAll } from '../../lib/query';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { formatHeaderDate, healthDot, shadowBlurRadius } from './homeState';

/** 32px visual (the PWA's), 44pt tappable — hitSlop adds the difference. */
const CONTROL_SIZE = 32;
const CONTROL_HIT = { top: 6, bottom: 6, left: 6, right: 6 };

/**
 * Header shortcut: flips to the opposite of what is rendered and pins it. It
 * does NOT cycle through 'system' — a one-tap control that silently walks a
 * third state is a trap; returning to System is deliberate, in Config.
 */
export function ThemePill() {
  const { t, scheme, setPref } = useTheme();
  const next = scheme === 'dark' ? 'light' : 'dark';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Switch to ${next} mode`}
      hitSlop={CONTROL_HIT}
      onPress={() => {
        void setPref(next);
      }}
      style={({ pressed }) => [
        styles.control,
        { backgroundColor: t('bg-1'), borderColor: t('border') },
        pressed && styles.pressedLight,
      ]}
    >
      <SymbolView
        name={next === 'light' ? 'sun.max' : 'moon'}
        size={14}
        tintColor={t('fg-2')}
        weight="regular"
      />
    </Pressable>
  );
}

export function Header({
  health,
  now,
  busy = false,
}: {
  health: HealthSummary | undefined;
  now: Date;
  busy?: boolean;
}) {
  const { t } = useTheme();
  const dot = healthDot(health, now.getTime());
  // `--glow-text` is `0 0 10px var(--accent-glow)` in dark and `none` in
  // light; the radius is read out of the token so it tracks a token change.
  const glowRadius = shadowBlurRadius(t('glow-text'));

  return (
    <View style={styles.header}>
      <View style={styles.left}>
        <View style={styles.markRow}>
          <Text
            accessibilityRole="header"
            style={[
              styles.mark,
              { color: busy ? t('accent-hi') : t('accent') },
              // `none` in light: the -hi step is what keeps the busy cue
              // visible in BOTH themes, the glow only sweetens dark.
              busy && glowRadius !== null
                ? {
                    textShadowColor: t('accent-glow'),
                    textShadowRadius: glowRadius,
                    textShadowOffset: { width: 0, height: 0 },
                  }
                : null,
            ]}
          >
            Xavier
          </Text>
          <View
            accessibilityLabel={dot.label}
            style={[
              styles.dot,
              { backgroundColor: t(dot.token) },
              dot.glow ? { boxShadow: t('glow-up') } : null,
            ]}
          />
        </View>
        <View style={styles.metaRow}>
          <Text style={[styles.descriptor, { color: t('fg-3') }]}>Agent hub</Text>
          <Text style={[styles.separator, { color: t('ink-faint') }]} accessibilityElementsHidden>
            ·
          </Text>
          <Text style={[styles.date, { color: t('fg-4') }]} numberOfLines={1} ellipsizeMode="tail">
            {formatHeaderDate(now)}
          </Text>
        </View>
      </View>

      <View style={styles.controls}>
        <ThemePill />
        {/* Config's way in since it left the tab bar (2026-09-29). */}
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Config"
          hitSlop={CONTROL_HIT}
          onPress={() => router.push('/config')}
          style={({ pressed }) => [
            styles.control,
            { backgroundColor: t('bg-1'), borderColor: t('border') },
            pressed && styles.pressedLight,
          ]}
        >
          <SymbolView name="gearshape" size={14} tintColor={t('fg-2')} weight="regular" />
        </Pressable>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Terminal"
          hitSlop={CONTROL_HIT}
          onPress={() => router.push('/ops/terminal')}
          style={({ pressed }) => [
            styles.control,
            { backgroundColor: t('bg-1'), borderColor: t('border') },
            pressed && styles.pressedLight,
          ]}
        >
          <SymbolView name="terminal" size={13} tintColor={t('fg-2')} weight="regular" />
        </Pressable>
        {/* No filter: this invalidates every cached query app-wide, not just
            Home's — the PWA's `qc.invalidateQueries()` (Header.tsx:106-108). */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh"
          hitSlop={CONTROL_HIT}
          onPress={() => {
            void refreshAll();
          }}
          style={({ pressed }) => [
            styles.control,
            { backgroundColor: t('bg-1'), borderColor: t('border') },
            pressed && styles.pressedRotate,
          ]}
        >
          <SymbolView name="arrow.clockwise" size={13} tintColor={t('fg-2')} weight="regular" />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingBottom: 18,
  },
  left: { flexDirection: 'column', gap: 3, flexShrink: 1 },
  markRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  mark: { fontFamily: fonts.sans(700), fontSize: 22, letterSpacing: -0.66, lineHeight: 22 },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  metaRow: { flexDirection: 'row', alignItems: 'baseline', gap: 7 },
  descriptor: { fontFamily: fonts.mono(500), fontSize: 10, letterSpacing: 1.8, textTransform: 'uppercase' },
  separator: { fontFamily: fonts.mono(400), fontSize: 10 },
  date: { fontFamily: fonts.mono(400), fontSize: 10, flexShrink: 1 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  control: {
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    borderRadius: CONTROL_SIZE / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressedLight: { opacity: 0.7 },
  // `active:[transform:rotate(180deg)]` — half a turn while held, springing
  // back on release (Header.tsx:109-115).
  pressedRotate: { transform: [{ rotate: '180deg' }] },
});
