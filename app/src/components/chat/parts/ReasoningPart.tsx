// A reasoning stream, collapsed to "Thought for Ns" — tap to expand the full
// text. No wire field carries a reasoning duration (ReasoningPart in
// chat/types.ts is `{type, text}` only), so the seconds are timed client-side
// from when this part first mounts to whenever `streaming` goes false —
// exactly like a stopwatch a person would run watching it, not a value the
// server hands us. Re-collapses are just local UI state; the timer itself
// never resets while this part instance lives.
import { useRef, useState } from 'react';
import { LayoutAnimation, Pressable, StyleSheet, Text, View } from 'react-native';
import { fonts } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { PRESSED_OPACITY } from '../../shell';
import { elapsedSecondsBetween, useElapsedSeconds } from './useElapsedSeconds';

export function ReasoningPart({
  text,
  streaming,
  startedAt,
  endedAt,
}: {
  text: string;
  streaming: boolean;
  /** The message's own created_at — the count's anchor, so it survives leaving
   * the thread and coming back. */
  startedAt?: string;
  /** Its updated_at once finished: then the duration is the server's, not a
   * stopwatch that kept running. */
  endedAt?: string | null;
}) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  // Thinking streams as a four-line tail and then folds to a one-line label the
  // moment the answer starts. That hard cut — five lines to one, in a single
  // frame — is the "flicker" the user sees as a turn goes tool → thinking (2026-10-01).
  // Animate the collapse so it shrinks instead of snapping. A no-op wherever the
  // animation API is unavailable, so it can never break the transcript.
  const wasStreaming = useRef(streaming);
  if (wasStreaming.current !== streaming) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    wasStreaming.current = streaming;
  }
  const live = useElapsedSeconds(streaming, startedAt);
  const settled = !streaming && startedAt && endedAt ? elapsedSecondsBetween(startedAt, endedAt) : null;
  const seconds = settled ?? live;

  // A turn with no reasoning text used to render "Thought for 0s" anyway —
  // one of these above nearly every tool card (the user, 2026-09-22). Nothing to
  // read, nothing to show.
  if (!text.trim()) return null;

  // While it IS thinking, the thinking is the most interesting thing on the
  // screen: show the tail of it, growing, rather than a collapsed label over
  // nothing. It folds itself away the moment the answer starts.
  if (streaming) {
    return (
      <View style={styles.wrap}>
        <Text style={[styles.label, { color: t('fg-2') }]}>Thinking… {seconds}s</Text>
        <Text
          style={[styles.body, { color: t('fg-3'), borderLeftColor: t('border-strong') }]}
          numberOfLines={4}
        >
          {text.trimEnd()}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => [styles.row, pressed && { opacity: PRESSED_OPACITY }]}
      >
        <Text style={[styles.label, { color: t('fg-2') }]}>
          Thought for {seconds}s {open ? '▾' : '▸'}
        </Text>
      </Pressable>
      {open ? (
        <Text style={[styles.body, { color: t('fg-3'), borderLeftColor: t('border-strong') }]}>{text}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 6 },
  row: { minHeight: 22, justifyContent: 'center' },
  label: { fontFamily: fonts.mono(400), fontSize: 11 },
  body: { marginTop: 4, paddingLeft: 9, borderLeftWidth: 2, fontFamily: fonts.sans(400), fontSize: 12.5, lineHeight: 18, fontStyle: 'italic' },
});
