// One transcript row: user bubbles right-aligned in accent-soft, assistant
// text plain, matching the approved design reference.
//
// Tool-call folding lives here, not in ToolCallPart/WorkedForFold themselves:
// while a message is still streaming, every part (including a completed
// mid-turn tool call) renders individually in original order — that's what
// lets the user watch tools run live. Once the message is `complete`, every
// tool_call part that finished cleanly (status 'complete', or an answered
// approval) is pulled OUT of the inline order and grouped into one
// WorkedForFold summary at the end; a tool_call that errored, or is still an
// open approval_requested, is left in place and rendered individually,
// exactly where it was — never folded away, per the design reference.
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fonts } from '../../theme/fonts';
import { clockOf } from '../../chat/clock';
import { useTheme } from '../../theme/useTheme';
import type { TokenName } from '../../theme/tokens.gen';
import type { ChatMessage, Part, ToolCallPart as ToolCallPartT } from '../../chat/types';
import { FileChip } from './parts/FileChip';
import { ImagePart } from './parts/ImagePart';
import { ReasoningPart } from './parts/ReasoningPart';
import { TextPart } from './parts/TextPart';
import { SubagentCard } from './parts/SubagentCard';
import { ToolCallPart } from './parts/ToolCallPart';
import { WorkedForFold } from './parts/WorkedForFold';
import { WidgetPartView } from './widgets';

/** The send/forward state a human-typed message carries — distinct from
 * `message.status`'s streaming/complete/error (the durable-transcript
 * rendering state). `'sending'`/`'error'` are client-local, set only by
 * chat/hooks.ts's `sendChatMessage` while the POST is in flight or after it
 * failed; `forward_status: 'pending'` is server-truthful and, until phase 3
 * ships the hub adapter's dispatch (chat/routes.py's module docstring), the
 * state EVERY successfully sent message is in — so its caption is quiet, not
 * an error. `'forwarded'` needs no caption at all: that's the silent, expected
 * good outcome every other complete message already renders as. */
function sendCaption(message: ChatMessage): { text: string; tone: TokenName; retryable: boolean } | null {
  if (message.status === 'sending') return { text: 'sending…', tone: 'fg-4', retryable: false };
  if (message.status === 'error') return { text: 'not sent — tap to retry', tone: 'status-warn', retryable: true };
  if (message.forward_status === 'pending') return { text: 'recorded — not yet delivered to the agent', tone: 'fg-4', retryable: false };
  return null;
}

function isFoldableToolCall(part: Part): part is ToolCallPartT {
  if (part.type !== 'tool_call') return false;
  if (part.state === 'approval_requested') return false; // still pending — never fold
  if (part.status === 'error') return false; // errors never fold
  // A delegated task is not one of twelve interchangeable tool rows — it has a
  // role, a goal and a report back, and folding it into "worked for 40s" loses
  // every part of that (gap A14).
  if (part.subagent) return false;
  return part.status === 'complete' || part.state === 'answered';
}

function InlinePart({
  part,
  streaming,
  startedAt,
  endedAt,
  threadId,
  messageId,
  index,
}: {
  part: Part;
  streaming: boolean;
  startedAt: string;
  endedAt: string | null;
  threadId: string;
  messageId: string;
  index: number;
}) {
  const { t } = useTheme();
  switch (part.type) {
    case 'text':
      return <TextPart text={part.text} streaming={streaming} />;
    case 'reasoning':
      return <ReasoningPart text={part.text} streaming={streaming} startedAt={startedAt} endedAt={endedAt} />;
    case 'tool_call':
      return part.subagent ? (
        <SubagentCard part={part} threadId={threadId} startedAt={startedAt} />
      ) : (
        <ToolCallPart part={part} startedAt={startedAt} />
      );
    case 'image':
      return <ImagePart part={part} />;
    case 'file':
      return <FileChip part={part} />;
    case 'widget':
      return <WidgetPartView part={part} threadId={threadId} messageId={messageId} partIndex={index} />;
    default:
      return null;
  }
}

/** Everything a reader would want on the clipboard: the prose, not the tool
 * payloads. Empty when the message is only tool calls, which is why the copy
 * affordance checks it before offering. */
export function plainTextOf(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

/** A row re-renders when ITS message changed, not when any message did.
 *
 * Nothing in the transcript was memoized, so a single streamed delta — one
 * every few milliseconds during a reply — re-rendered every bubble in the
 * thread, tall widget cards included. That is the jumpiness (the user, 2026-09-24:
 * "it can be really jumpy and unclean. rendering is an issue it would
 * appear"). The store already keeps a message's identity stable when the
 * server sends it back unchanged, so identity IS the test.
 */
export const MessageBubble = memo(MessageBubbleRow, (before, after) =>
  before.message === after.message &&
  before.onRetrySend === after.onRetrySend &&
  before.onCopy === after.onCopy);

function MessageBubbleRow({
  message,
  onRetrySend,
  onCopy,
}: {
  message: ChatMessage;
  /** Tapping a failed local send's caption. Absent for anything but a
   * client-authored 'error' row — ThreadScreen wires this to `useSendMessage`'s
   * `retry`, which is a no-op for a message that isn't retryable. */
  onRetrySend?: (message: ChatMessage) => void;
  /** Long-press copied the message — the screen owns the confirmation. */
  onCopy?: (text: string) => void;
}) {
  const { t } = useTheme();
  const isUser = message.role === 'user';
  const streaming = message.status === 'streaming';
  const caption = sendCaption(message);

  // Keyed by position in `message.parts`, taken BEFORE the fold: keyed by
  // position in `inline`, completing a turn folded earlier tool calls away,
  // shifted every later key, and remounted — wiping a half-typed clarify answer.
  const inline: Part[] = [];
  const inlineKeys: number[] = [];
  const folded: ToolCallPartT[] = [];
  message.parts.forEach((part, i) => {
    // `!streaming` used to gate this, so a turn's finished tool calls sat inline
    // as their own rows until the reply settled — and then vanished into the
    // fold in the same frame the thinking collapsed. That hard re-layout is the
    // flicker the user sees going tool → thinking, and it re-drew every skill_view /
    // skill_manage card in full mid-turn (2026-10-01: "when you go from tool to
    // thinking it causes a flicker too when the thinking collapses … make sure
    // anything returned as a message from the skill_manage post hook stays
    // collapsed"). A finished call is folded from the moment it is finished; a
    // running one still shows itself until it is.
    if (isFoldableToolCall(part)) folded.push(part);
    else {
      inline.push(part);
      inlineKeys.push(i);
    }
  });

  // A widget is its own object with its own card. Wrapping it in a bubble drew
  // two borders one inside the other, and because the bubble only has a
  // max-width it shrink-wrapped — a calendar or a form has no width of its own,
  // so it collapsed to a sliver and cut its contents off (the user, 2026-09-22:
  // "all of the bubbles are double stuffed… stuff is getting cutoff"). A
  // message that is only widgets is drawn bare at full width; a message that
  // mixes prose and a widget keeps its bubble but at a fixed width.
  const widgetOnly =
    !isUser && folded.length === 0 && inline.length > 0 && inline.every((p) => p.type === 'widget');
  const hasWidget = inline.some((p) => p.type === 'widget');

  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      <View
        style={
          widgetOnly
            ? styles.bare
            : [
                styles.bubble,
                hasWidget && styles.bubbleWithWidget,
                isUser ? styles.bubbleUser : [styles.bubbleAssistant, styles.bubbleAssistantWidth],
                isUser
                  ? { backgroundColor: t('accent-soft'), borderColor: t('accent-border') }
                  : { backgroundColor: t('bg-1'), borderColor: t('border') },
              ]
        }
      >
        {inline.map((part, i) => (
          <InlinePart
            key={inlineKeys[i]}
            part={part}
            streaming={streaming}
            startedAt={message.created_at}
            endedAt={streaming ? null : message.updated_at}
            threadId={message.thread_id}
            messageId={message.id}
            index={inlineKeys[i]}
          />
        ))}
        {folded.length > 0 ? <WorkedForFold parts={folded} /> : null}
        {message.status === 'error' && !isUser ? (
          <Text style={[styles.errorNote, { color: t('status-down') }]}>Something went wrong on this turn.</Text>
        ) : null}
        {caption ? (
          <Pressable
            disabled={!caption.retryable}
            accessibilityRole={caption.retryable ? 'button' : undefined}
            accessibilityLabel={caption.retryable ? 'Retry send' : undefined}
            onPress={() => onRetrySend?.(message)}
          >
            <Text style={[styles.caption, { color: t(caption.tone) }]}>{caption.text}</Text>
          </Pressable>
        ) : null}
        <View style={styles.foot}>
          {/* When it was sent, on both sides — a transcript without times is
              a transcript you cannot reason about (the user, 2026-09-28). */}
          <Text style={[styles.time, { color: t('fg-4') }]} testID="message-time">
            {clockOf(message.created_at)}
          </Text>
          {onCopy && plainTextOf(message) ? (
            // A long press on the bubble used to do this, but the Pressable
            // swallowed the touch and highlighting a phrase became impossible
            // (the user, 2026-09-22). Selection is the native gesture and wins;
            // the whole-message copy gets its own quiet control.
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Copy message"
              hitSlop={8}
              onPress={() => onCopy(plainTextOf(message))}
              style={({ pressed }) => [styles.copy, pressed && { opacity: 0.6 }]}
            >
              <Text style={[styles.copyLabel, { color: t('fg-4') }]}>copy</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { marginBottom: 14, flexDirection: 'row' },
  rowUser: { justifyContent: 'flex-end' },
  rowAssistant: { justifyContent: 'flex-start' },
  // Xavier's replies are bubbled too, in the ground colour rather than the
  // accent — "put the agent response text in a message bubble the same way my
  // messages are, just a diff color; makes them easier to read" (the user,
  // 2026-09-22). The tight corner marks the speaker's side.
  bubble: { maxWidth: '92%', borderRadius: 15, paddingHorizontal: 13, paddingVertical: 10, borderWidth: 1, gap: 2 },
  // A widget-only message runs full width, so a prose reply beside it at 92%
  // left the transcript with two right margins that swapped every few rows
  // (design review, 2026-09-22). Only the user's own side stays inset — that, and
  // the tight corner, is what marks the speaker.
  bubbleAssistantWidth: { maxWidth: '100%' },
  bubbleWithWidget: { width: '100%' },
  bare: { width: '100%', gap: 8 },
  bubbleUser: { borderBottomRightRadius: 5 },
  bubbleAssistant: { borderBottomLeftRadius: 5 },
  errorNote: { marginTop: 4, fontFamily: fonts.sans(500), fontSize: 12 },
  caption: { marginTop: 3, fontFamily: fonts.mono(400), fontSize: 10.5 },
  foot: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 4, gap: 10 },
  time: { fontFamily: fonts.mono(400), fontSize: 10, letterSpacing: 0.3 },
  copy: { paddingHorizontal: 2 },
  copyLabel: { fontFamily: fonts.mono(400), fontSize: 10, letterSpacing: 0.4 },
});
