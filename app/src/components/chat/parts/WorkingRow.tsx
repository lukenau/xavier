// The gateway's "still working" heartbeat as a live row rather than prose.
// It arrives as ordinary assistant text — "⏳ Working — 3 min — iteration 9/60,
// waiting for provider response (streaming)" — and stacked up in the
// transcript, each one a stale copy of the last (the user, 2026-09-22).
// chat/transcript.ts keeps only the newest; this renders it as status: a
// pulsing dot, the elapsed time, and a bar for the iteration budget.
import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { fonts } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import type { Progress } from '../../../chat/progress';

export function WorkingRow({ progress }: { progress: Progress }) {
  const { t } = useTheme();
  const pulse = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.35, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const fraction =
    progress.iteration != null && progress.totalIterations
      ? Math.min(1, progress.iteration / progress.totalIterations)
      : null;

  return (
    <View style={[styles.wrap, { borderColor: t('border') }]}>
      <View style={styles.head}>
        <Animated.View style={[styles.dot, { backgroundColor: t('accent'), opacity: pulse }]} />
        <Text style={[styles.label, { color: t('fg-2') }]}>
          Working{progress.elapsed ? ` · ${progress.elapsed}` : ''}
        </Text>
        {progress.iteration != null && progress.totalIterations ? (
          <Text style={[styles.count, { color: t('fg-2') }]}>
            {progress.iteration}/{progress.totalIterations}
          </Text>
        ) : null}
      </View>
      {fraction != null ? (
        <View style={[styles.track, { backgroundColor: t('bg-2') }]}>
          <View style={[styles.fill, { backgroundColor: t('accent'), width: `${Math.round(fraction * 100)}%` }]} />
        </View>
      ) : null}
      {progress.detail ? (
        <Text style={[styles.detail, { color: t('fg-2') }]} numberOfLines={1}>
          {progress.detail}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 12, borderWidth: 1, borderRadius: 11, paddingHorizontal: 11, paddingVertical: 9, gap: 7 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  label: { fontFamily: fonts.sans(550), fontSize: 12.5 },
  count: { marginLeft: 'auto', fontFamily: fonts.mono(400), fontSize: 10.5 },
  track: { height: 3, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 3, borderRadius: 2 },
  detail: { fontFamily: fonts.mono(400), fontSize: 10.5 },
});
