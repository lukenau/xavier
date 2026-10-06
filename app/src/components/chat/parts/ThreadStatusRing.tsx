// The thread header's status ring (A20). Same four states as the composer's
// TurnIndicator and the same source — `turnStateOf(messages)`, read off the
// transcript, because nothing writes `threads.status` — but this one is always
// on screen, so it is a ring and a word rather than a sentence.
import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useTheme } from '../../../theme/useTheme';
import type { TokenName } from '../../../theme/tokens.gen';
import type { TurnState } from '../../../chat/turnState';

export const RING_TONE: Record<TurnState, TokenName> = {
  idle: 'fg-4',
  waiting: 'accent',
  working: 'accent',
  undelivered: 'status-down',
};

export const RING_LABEL: Record<TurnState, string> = {
  idle: 'idle',
  waiting: 'sending',
  working: 'working',
  undelivered: 'not delivered',
};

export function ThreadStatusRing({ state }: { state: TurnState }) {
  const { t } = useTheme();
  const spin = useRef(new Animated.Value(0)).current;
  // Sending spins as well as working: the same rule as TurnIndicator (L55).
  const moving = state === 'waiting' || state === 'working';

  useEffect(() => {
    if (!moving) return;
    spin.setValue(0);
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [moving, spin]);

  const tone = t(RING_TONE[state]);
  return (
    <Animated.View
      accessibilityRole="image"
      accessibilityLabel={`Thread ${RING_LABEL[state]}`}
      style={[
        styles.ring,
        { borderColor: moving ? t('border-strong') : tone, borderTopColor: tone },
        moving
          ? { transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }
          : null,
      ]}
    >
      {state === 'undelivered' ? <View style={[styles.core, { backgroundColor: tone }]} /> : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  ring: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  core: { width: 4, height: 4, borderRadius: 2 },
});
