// Key accessory bar: the control sequences the iOS software keyboard cannot
// type. Chips send straight to the pty; the ⌘ chip opens Runbooks, whose items
// fill the composer for review.
//
// Native, and outside the WebView on purpose — a chip must never move focus
// into WKWebView (research §3.5). There is no focus arbitration to port from
// XtermView.tsx:57-60 for the same reason: the composer holds the keyboard,
// and a chip tap does not take it away.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { fonts } from '../theme/fonts';
import { useTheme } from '../theme/useTheme';
import {
  COPY_MODE_ENTER,
  COPY_MODE_EXIT,
  KEYS,
  REPEAT_DELAY_MS,
  REPEAT_INTERVAL_MS,
  TMUX_KEYS,
  type KeyChip,
} from './keys';

export interface KeyBarProps {
  onKey: (seq: string) => void;
  onRunbooks: () => void;
}

export function KeyBar({ onKey, onRunbooks }: KeyBarProps) {
  const { t } = useTheme();
  const [copyMode, setCopyMode] = useState(false);
  // Hold-to-repeat on arrow chips. Quick taps still go through onPress; the
  // `fired` flag swallows the trailing press a finished repeat run would emit.
  const repeat = useRef<{
    delay: ReturnType<typeof setTimeout> | null;
    interval: ReturnType<typeof setInterval> | null;
    fired: boolean;
  }>({ delay: null, interval: null, fired: false });

  const stopRepeat = useCallback(() => {
    const r = repeat.current;
    if (r.delay) clearTimeout(r.delay);
    if (r.interval) clearInterval(r.interval);
    r.delay = null;
    r.interval = null;
  }, []);

  const startRepeat = useCallback(
    (seq: string) => {
      const r = repeat.current;
      r.fired = false;
      r.delay = setTimeout(() => {
        r.interval = setInterval(() => {
          r.fired = true;
          onKey(seq);
        }, REPEAT_INTERVAL_MS);
      }, REPEAT_DELAY_MS);
    },
    [onKey],
  );

  useEffect(() => stopRepeat, [stopRepeat]);

  const tapKey = (key: KeyChip) => {
    if (key.repeat && repeat.current.fired) {
      repeat.current.fired = false;
      return;
    }
    onKey(key.seq);
  };

  const chipColors = {
    backgroundColor: t('bg-2'),
    borderColor: t('border-strong'),
  };

  return (
    <View style={[styles.bar, { backgroundColor: t('bg-1'), borderTopColor: t('border') }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={styles.strip}
      >
        <Pressable
          accessibilityLabel="Command snippets"
          accessibilityRole="button"
          onPress={onRunbooks}
          style={[
            styles.chip,
            styles.chipWide,
            { backgroundColor: t('accent-soft'), borderColor: t('accent-border') },
          ]}
        >
          <Text style={[styles.chipLabel, styles.chipLabelStrong, { color: t('accent') }]}>⌘</Text>
        </Pressable>
        {KEYS.map((key) => (
          <Pressable
            key={key.label}
            accessibilityRole="button"
            onPress={() => tapKey(key)}
            onPressIn={key.repeat ? () => startRepeat(key.seq) : undefined}
            onPressOut={key.repeat ? stopRepeat : undefined}
            style={[styles.chip, chipColors]}
          >
            <Text style={[styles.chipLabel, { color: t('fg-1') }]}>{key.label}</Text>
          </Pressable>
        ))}
        {TMUX_KEYS.map((key) => (
          <Pressable
            key={key.label}
            accessibilityRole="button"
            onPress={() => onKey(key.seq)}
            style={[styles.chip, styles.chipTmux, chipColors]}
          >
            <Text style={[styles.chipLabel, { color: t('fg-1') }]}>{key.label}</Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            onKey(copyMode ? COPY_MODE_EXIT : COPY_MODE_ENTER);
            setCopyMode((m) => !m);
          }}
          style={[
            styles.chip,
            styles.chipWide,
            copyMode
              ? { backgroundColor: t('accent-soft'), borderColor: t('accent-border') }
              : chipColors,
          ]}
        >
          <Text style={[styles.chipLabel, { color: copyMode ? t('accent') : t('fg-1') }]}>
            {copyMode ? 'exit' : 'scroll'}
          </Text>
        </Pressable>
      </ScrollView>
      {/* Right-edge fade: signals there are more keys off-screen. */}
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={[
          styles.fade,
          { experimental_backgroundImage: `linear-gradient(90deg, transparent, ${t('bg-1')})` },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { borderTopWidth: 1 },
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    // Trailing spacer keeps the last chip clear of the fade hint.
    paddingRight: 28,
  },
  chip: {
    height: 34,
    minWidth: 40,
    borderRadius: 9,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipTmux: { paddingHorizontal: 8 },
  chipWide: { paddingHorizontal: 12 },
  chipLabel: { fontFamily: fonts.mono(400), fontSize: 12 },
  chipLabelStrong: { fontFamily: fonts.mono(550) },
  fade: { position: 'absolute', top: 0, right: 0, bottom: 0, width: 26 },
});
