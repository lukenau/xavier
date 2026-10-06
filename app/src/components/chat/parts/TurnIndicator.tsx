// "Is it doing anything?" — one line directly above the composer, which is
// where the user pointed (Claude's own "Noodling…" sits there) and the place his
// eye already is when he has just sent something.
//
// Sending and working both SPIN. The first cut gave "sent, not yet
// acknowledged" its own quiet grey breathing dot, and the user asked three times
// for the loading animation instead (L45, L49, L55: "it still says sent
// waiting… instead of showing the waiting loading animation"). The distinction
// he cares about is moving vs. stuck, not which hop the message is on. The one
// state that stays still and red is undelivered — the difference between
// "working" and "your message never arrived", which a spinner would hide.
import { memo, useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { fonts } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import type { TokenName } from '../../../theme/tokens.gen';
import type { TurnState } from '../../../chat/turnState';
import { DotScanner, useWhimsy } from '../../../whimsy';

const COPY: Record<Exclude<TurnState, 'idle'>, { label: string; tone: TokenName }> = {
  waiting: { label: 'Sending…', tone: 'accent' },
  working: { label: 'Working…', tone: 'accent' },
  undelivered: { label: 'Not delivered — the gateway did not take it', tone: 'status-down' },
};

// Memoized on its one prop: the thread re-renders per streamed delta, which would
// otherwise rebuild the spinner/scanner animations mid-loop.
export const TurnIndicator = memo(function TurnIndicator({ state }: { state: TurnState }) {
  const { t } = useTheme();
  const spin = useRef(new Animated.Value(0)).current;
  const moving = state === 'waiting' || state === 'working';
  const { level } = useWhimsy();
  const withXavier = level === 'full';
  const rotate = useMemo(() => spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }), [spin]);

  useEffect(() => {
    if (!moving) return;
    spin.setValue(0);
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [moving, spin]);

  if (state === 'idle') return null;
  const copy = COPY[state];

  return (
    <View style={styles.row} accessibilityRole="progressbar" accessibilityLabel={copy.label}>
      {moving && withXavier ? (
        <DotScanner />
      ) : moving ? (
        <Animated.View
          style={[
            styles.ring,
            { borderColor: t('border-strong'), borderTopColor: t('accent') },
            { transform: [{ rotate }] },
          ]}
        />
      ) : (
        <View style={[styles.dot, { backgroundColor: t('status-down') }]} />
      )}
      <Text style={[styles.label, { color: t(copy.tone) }]} numberOfLines={1}>
        {copy.label}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  // Aligned with the transcript's gutter, not the screen edge — it sat flush
  // left against everything else (the user, 2026-09-22).
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingBottom: 4 },
  ring: { width: 12, height: 12, borderRadius: 6, borderWidth: 1.5 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  label: { flex: 1, minWidth: 0, fontFamily: fonts.sans(500), fontSize: 12 },
});
