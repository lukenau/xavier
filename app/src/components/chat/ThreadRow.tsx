// One row in the Threads list — a CARD, like the prototype and like every
// other list in the Hub: filled, bordered, rounded, spaced. It shipped as a
// flat divider row and the user spotted the difference against the prototype on
// sight (2026-09-22). The chrome comes from the shell's own `Card` rather than
// the prototype's raw CSS values, so a chat row and a Home row stay the same
// object — the "content exact, chrome native" parity rule.
//
// Every pill here is a field hub-api actually sent: `kind`, `pinned`, `unread`,
// `origin_thread_id`. The design's cost pill is still absent — no cost reaches
// the Hub at all (FEEDBACK-AND-PLAN.md D2) — and nothing renders a number the
// server never gave.
import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { relTime } from '../../shared/time';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import type { TokenName } from '../../theme/tokens.gen';
import { Card } from '../shell';
import type { Thread } from '../../chat/types';

export const KIND_LABEL: Record<string, string> = {
  chat: 'Chat',
  brief: 'Brief',
  ops: 'Ops',
  money: 'Money',
  cron: 'Cron',
  followup: 'Follow-up',
};

// `thread.status` exists on the wire but nothing ever sets it, so the old
// "active" branch here never fired and every thread looked idle (the user,
// 2026-09-22: "show an active color dot signal on the threads that are actively
// working"). The caller now says whether a turn is running.
function statusTone(thread: Thread, needsYou: boolean, working: boolean): TokenName {
  if (needsYou) return 'status-warn';
  if (thread.status === 'error') return 'status-down';
  if (working) return 'accent';
  return 'fg-4';
}

/** The row's dot. A working thread's dot breathes, so it reads as live at a
 *  glance rather than as one more colour to decode. */
function StatusDot({ tone, working }: { tone: TokenName; working: boolean }) {
  const { t } = useTheme();
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!working) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [working, pulse]);
  return <Animated.View testID="thread-status-dot" style={[styles.dot, { backgroundColor: t(tone), opacity: pulse }]} />;
}

/** What a row says under its title. The open attention row wins — "what is
 * waiting on you" beats "what was last said" — and a quiet thread falls back
 * to its own last words, which is the line it had none of before. the user's own
 * messages are marked as his: without it a preview of what HE said reads as
 * something Xavier told him. */
export function previewLine(thread: Thread, attentionSummary: string | null): string | null {
  if (attentionSummary) return attentionSummary;
  if (!thread.preview) return null;
  return thread.preview_role === 'user' ? `You: ${thread.preview}` : thread.preview;
}

function Pill({
  label,
  fg,
  bg,
  border,
}: {
  label: string;
  fg: TokenName;
  bg: TokenName;
  border: TokenName;
}) {
  const { t } = useTheme();
  return (
    <View style={[styles.pill, { backgroundColor: t(bg), borderColor: t(border) }]}>
      <Text style={[styles.pillLabel, { color: t(fg) }]}>{label}</Text>
    </View>
  );
}

export interface ThreadRowProps {
  thread: Thread;
  needsYou: boolean;
  /** The open attention row's own summary, when there is one — see `previewLine`. */
  attentionSummary: string | null;
  /** What this thread was spun out of, named by the caller from the threads it
   * already holds (`ChatScreen`). Null when `origin_thread_id` is unset — the
   * pill is then absent rather than guessing at a source. */
  originLabel: string | null;
  /** A turn is running in this thread right now. */
  working?: boolean;
  onPress: () => void;
}

export function ThreadRow({ thread, needsYou, attentionSummary, originLabel, working = false, onPress }: ThreadRowProps) {
  const { t } = useTheme();
  const title = thread.title?.trim() || KIND_LABEL[thread.kind] || 'Chat';
  const preview = previewLine(thread, attentionSummary);
  // A plain chat needs no badge saying so; anything the gateway opened itself does.
  const kindLabel = thread.kind === 'chat' ? null : KIND_LABEL[thread.kind] || thread.kind;
  // No "needs you" pill: such a row only ever appears under the "Needs you"
  // section head, and its amber dot already says it.
  const pills = thread.pinned || thread.unread > 0 || kindLabel || originLabel;

  return (
    <Card onPress={onPress} accessibilityLabel={title} style={styles.card}>
      <View style={styles.row}>
        <StatusDot tone={statusTone(thread, needsYou, working)} working={working} />
        <View style={styles.body}>
          <View style={styles.titleRow}>
            <Text style={[styles.title, { color: t('fg-0') }]} numberOfLines={1}>
              {title}
            </Text>
            <Text style={[styles.time, { color: t('fg-2') }]}>{relTime(thread.updated_at)}</Text>
          </View>
          {preview ? (
            <Text style={[styles.preview, { color: t('fg-3') }]} numberOfLines={1}>
              {preview}
            </Text>
          ) : null}
          {pills ? (
            <View style={styles.pills}>
              {kindLabel ? (
                <Pill label={kindLabel} fg="petrol" bg="petrol-soft" border="petrol-border" />
              ) : null}
              {originLabel ? (
                <Pill label={`from ${originLabel}`} fg="fg-3" bg="bg-2" border="border" />
              ) : null}
              {thread.pinned ? (
                <Pill label="pinned" fg="accent" bg="accent-soft" border="accent-border" />
              ) : null}
              {thread.unread > 0 ? (
                <Pill label={`${thread.unread} new`} fg="fg-2" bg="bg-2" border="border-strong" />
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  // Denser than the shell default (18/14) because this is a list, not a panel —
  // Home's cards set their own padding the same way.
  card: { paddingHorizontal: 14, paddingVertical: 12, marginBottom: 9 },
  row: { flexDirection: 'row', gap: 10 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  body: { flex: 1, minWidth: 0, gap: 3 },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  title: { flex: 1, minWidth: 0, fontFamily: fonts.sans(580), fontSize: 14.5 },
  time: { flexShrink: 0, fontFamily: fonts.mono(400), fontSize: 10.5 },
  preview: { fontFamily: fonts.sans(400), fontSize: 12.5, lineHeight: 17 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  pill: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
  pillLabel: { fontFamily: fonts.mono(400), fontSize: 9.5, letterSpacing: 0.6, textTransform: 'uppercase' },
});
