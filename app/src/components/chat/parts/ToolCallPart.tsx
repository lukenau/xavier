// One tool call — collapsed to a badge + mono name + arg preview + duration;
// tap to expand args and result.
//
// An error keeps its own row rather than folding away into the turn's activity
// summary, but its BODY is collapsed like any other (the user, 2026-09-22: "the
// tool errors should be collapsed too, this takes up so much space. can still
// be red, just collapsed") — a failed `ls` pasted a four-thousand-character
// directory listing across the whole screen. The red badge and the one-line
// reason are what the collapsed row shows; the payload is a tap away.
//
// An approval-in-flight is the SAME `tool_call` part with
// `state: 'approval_requested'` (chat/types.ts — there is no separate part
// type; SingleSelect/MultiSelect/Confirm were deleted from the widget catalog
// per VERDICT-V2 §3). This component renders that state as a plain pending
// line — the actual choices + countdown live in the ApprovalCard pinned at
// the bottom of the thread (VERDICT-V2 design reference), not duplicated
// here, so `choices`/`expires_at_derived` are deliberately not read below.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fonts, MONO_FEATURES } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import type { TokenName } from '../../../theme/tokens.gen';
import { PRESSED_OPACITY } from '../../shell';
import type { ToolCallPart as ToolCallPartT } from '../../../chat/types';
import { argSections, errorSection, resultSections, toolSummary } from '../../../chat/toolView';
import { toolKindOf } from '../../../chat/toolKind';
import { useElapsedSeconds } from './useElapsedSeconds';

function clamp(text: string, max = 64): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

interface Badge {
  label: string;
  glyph: string;
  tone: TokenName;
  soft: TokenName;
}

/** State wins over kind: an error or a pending approval is what you need to
 *  see first. Only a settled, uneventful call shows its kind glyph, which is
 *  exactly the row that used to be an anonymous grey TOOL badge (gap A15). */
function badgeFor(part: ToolCallPartT): Badge {
  if (part.state === 'approval_requested')
    return { label: 'approval', glyph: '!', tone: 'status-warn', soft: 'status-warn-soft' };
  if (part.state === 'answered') return { label: 'approval', glyph: '✓', tone: 'fg-3', soft: 'bg-2' };
  if (part.status === 'error') return { label: 'error', glyph: '×', tone: 'status-down', soft: 'status-down-soft' };
  const kind = toolKindOf(part.tool_name);
  if (part.status === 'running') return { label: kind.label, glyph: kind.glyph, tone: 'status-up', soft: 'status-up-soft' };
  return { label: kind.label, glyph: kind.glyph, tone: 'fg-3', soft: 'bg-2' };
}

export function ToolCallPart({ part, startedAt }: { part: ToolCallPartT; startedAt?: string }) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  const pending = part.state === 'approval_requested';
  const isError = part.status === 'error';
  const running = part.status === 'running' && !pending;
  // Anchored to the message the server stamped, not to mount: leaving the
  // thread and coming back restarted every counter from zero (the user,
  // 2026-09-22).
  const liveSeconds = useElapsedSeconds(running, startedAt);
  const expanded = open || pending;
  const badge = badgeFor(part);
  const sections = [...argSections(part.args), ...resultSections(part.result)];
  const extraError = errorSection(part.error, sections);

  const durationLabel =
    part.duration_ms != null
      ? `${(part.duration_ms / 1000).toFixed(part.duration_ms >= 10_000 ? 0 : 1)}s`
      : running
        ? `${liveSeconds}s`
        : null;

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        disabled={pending}
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => [styles.row, pressed && !pending && { opacity: PRESSED_OPACITY }]}
      >
        <View style={[styles.badge, { backgroundColor: t(badge.soft) }]}>
          <Text style={[styles.badgeGlyph, { color: t(badge.tone) }]}>{badge.glyph}</Text>
          <Text style={[styles.badgeLabel, { color: t(badge.tone) }]}>{badge.label}</Text>
        </View>
        <Text style={[styles.name, { color: t('fg-1') }]} numberOfLines={1} ellipsizeMode="head">
          {part.tool_name ?? 'tool'}
        </Text>
        {!pending && part.args !== undefined ? (
          <Text style={[styles.preview, { color: t('fg-2') }]} numberOfLines={1}>
            {clamp(toolSummary(part.args))}
          </Text>
        ) : null}
        {durationLabel ? <Text style={[styles.duration, { color: t('fg-2') }]}>{durationLabel}</Text> : null}
        {!pending ? <Text style={[styles.chevron, { color: t('fg-3') }]}>{open ? '▾' : '▸'}</Text> : null}
      </Pressable>

      {pending ? (
        <Text style={[styles.note, { color: t('status-warn') }]}>Waiting for your approval</Text>
      ) : null}
      {isError && !open && part.error ? (
        <Text style={[styles.note, { color: t('status-down') }]} numberOfLines={1}>
          {clamp(part.error, 80)}
        </Text>
      ) : null}
      {part.state === 'answered' ? (
        <Text style={[styles.note, { color: t('fg-2') }]}>
          {part.resolved_choice === 'deny'
            ? 'Denied'
            : part.resolved_choice === 'elsewhere'
              ? 'Answered somewhere else'
              : part.resolved_choice === 'timeout'
                ? 'Timed out, did not run'
                : part.resolved_choice === 'withdrawn'
                  ? 'Withdrawn, did not run'
                  : `Approved (${part.resolved_choice ?? 'once'})`}
        </Text>
      ) : null}

      {expanded && !pending ? (
        <View style={styles.body}>
          {sections.map((section) => (
            <View key={section.label} style={styles.section}>
              <Text style={[styles.sectionLabel, { color: t('fg-3') }]}>{section.label}</Text>
              <Text
                style={[
                  styles.code,
                  { color: isError && section.label !== 'Command' ? t('status-down') : t('fg-2') },
                  MONO_FEATURES,
                ]}
              >
                {section.text}
              </Text>
            </View>
          ))}
          {isError && extraError ? (
            <View style={styles.section}>
              <Text style={[styles.sectionLabel, { color: t('fg-3') }]}>{extraError.label}</Text>
              <Text style={[styles.code, { color: t('status-down') }]}>{extraError.text}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 6 },
  section: { gap: 2 },
  sectionLabel: { fontFamily: fonts.mono(550), fontSize: 8.5, letterSpacing: 1.1, textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 24 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1.5, flexShrink: 0 },
  badgeGlyph: { fontFamily: fonts.mono(550), fontSize: 10, lineHeight: 12 },
  badgeLabel: { fontFamily: fonts.mono(550), fontSize: 9, letterSpacing: 0.5, textTransform: 'uppercase' },
  // An MCP name is `mcp__<server>__<tool>` and routinely 40+ characters; the
  // name gives way first (from the head, since the tool is the tail) so the
  // preview keeps enough room to say what the call did.
  name: { flexShrink: 1, minWidth: 72, fontFamily: fonts.mono(550), fontSize: 11.5 },
  preview: { flex: 1, minWidth: 64, fontFamily: fonts.mono(400), fontSize: 10.5 },
  duration: { flexShrink: 0, fontFamily: fonts.mono(400), fontSize: 10 },
  chevron: { flexShrink: 0, fontFamily: fonts.mono(400), fontSize: 10 },
  note: { marginTop: 2, fontFamily: fonts.sans(400), fontSize: 11.5 },
  body: { marginTop: 5, paddingLeft: 9, gap: 5 },
  code: { fontFamily: fonts.mono(400), fontSize: 11, lineHeight: 16 },
});
