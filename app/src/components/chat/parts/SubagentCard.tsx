// A delegated task, drawn as its own card rather than a `delegate_task` tool
// row (audit gap A14). The distinction matters in a transcript: a tool call is
// something Xavier did, a subagent is someone Xavier asked — it has a role, a
// goal, a lifetime and a report back, and reading it as one grey row among
// twelve loses all of that.
//
// The payload is the same `tool_call` part every other tool arrives on, with
// the extra `subagent` key the plugin's lifecycle hooks attach
// (hub_wire.py `subagent_message`). `phase: 'start'` rows are replaced in
// place by the `stop` row that follows, because both carry the same
// `tool_call_id` (`subagent:<child_session_id>`).
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { fonts } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import type { TokenName } from '../../../theme/tokens.gen';
import { PRESSED_OPACITY } from '../../shell';
import type { Part, ToolCallPart as ToolCallPartT } from '../../../chat/types';
import { resultSections } from '../../../chat/toolView';
import { useElapsedSeconds } from './useElapsedSeconds';
import { usePoll } from '../../../lib/query';
import { api } from '../../../lib/api';
import { ToolCallPart } from './ToolCallPart';

function goalOf(args: unknown): string | null {
  if (typeof args === 'string') {
    try {
      return goalOf(JSON.parse(args));
    } catch {
      return args.trim() || null;
    }
  }
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const o = args as Record<string, unknown>;
    for (const key of ['goal', 'task', 'prompt', 'instruction', 'description']) {
      const v = o[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

function roleOf(part: ToolCallPartT): string {
  const fromSubagent = part.subagent?.child_role;
  if (fromSubagent && fromSubagent.trim()) return fromSubagent.trim();
  const args = part.args;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const role = (args as Record<string, unknown>).role;
    if (typeof role === 'string' && role.trim()) return role.trim();
  }
  return 'agent';
}

export function SubagentCard({
  part,
  threadId,
  startedAt,
  goal: givenGoal,
  index,
}: {
  part: ToolCallPartT;
  threadId: string;
  startedAt?: string;
  /** From the dispatch record (chat/transcript.ts): the child's own row has
   * no goal of its own. */
  goal?: string | null;
  /** Its place in the delegation, to tell "leaf" from "leaf" when no goal
   * is known either way. */
  index?: number;
}) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);

  // What the child actually did. None of it reaches the Hub while it runs —
  // its tool calls fire hooks under a session that maps to no thread, and it
  // streams no text at all — so the card asks for it when it is opened, and
  // the gateway reads it back out of its own state (the user, 2026-09-22: "like in
  // claude code terminal you can click on a subagent and see their chat
  // window").
  const childSessionId = part.subagent?.child_session_id ?? null;
  const transcript = usePoll(
    ['subagent-transcript', threadId, childSessionId ?? ''],
    () => api.chatSubagentTranscript(threadId, childSessionId as string),
    { enabled: open && !!childSessionId && !!threadId, refetchInterval: false, staleTime: 15_000 },
  );

  const running = part.status === 'running';
  const failed = part.status === 'error';
  // Anchored to the row's own timestamp, so the count survives leaving the
  // thread (the user, 2026-09-22: "the runtime counter for agents and such seems
  // to reset when i leave the chat").
  const liveSeconds = useElapsedSeconds(running, startedAt);

  const goal = givenGoal ?? goalOf(part.args);
  const role = goal || index == null ? roleOf(part) : `${roleOf(part)} ${index}`;
  const calls = part.subagent?.tool_call_count ?? null;
  const report = failed ? null : resultSections(part.result);
  const hasReport = !running && ((report?.length ?? 0) > 0 || failed);
  const canOpen = hasReport || !!childSessionId;

  const tone: TokenName = failed ? 'status-down' : running ? 'accent' : 'petrol';
  const softTone: TokenName = failed ? 'status-down-soft' : running ? 'accent-soft' : 'petrol-soft';
  const borderTone: TokenName = failed ? 'status-down-border' : running ? 'accent-border' : 'petrol-border';

  const duration =
    part.duration_ms != null
      ? `${(part.duration_ms / 1000).toFixed(part.duration_ms >= 10_000 ? 0 : 1)}s`
      : running
        ? `${liveSeconds}s`
        : null;

  const meta = [duration, calls != null ? `${calls} ${calls === 1 ? 'call' : 'calls'}` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <View style={[styles.card, { backgroundColor: t(softTone), borderColor: t(borderTone) }]}>
      <Pressable
        accessibilityRole={canOpen ? 'button' : undefined}
        accessibilityState={canOpen ? { expanded: open } : undefined}
        accessibilityLabel={`Delegated to ${role}`}
        disabled={!canOpen}
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => [styles.head, pressed && canOpen && { opacity: PRESSED_OPACITY }]}
      >
        <Text style={[styles.glyph, { color: t(tone) }]}>⑂</Text>
        <View style={styles.headText}>
          <Text style={[styles.role, { color: t(tone) }]} numberOfLines={1}>
            {role}
          </Text>
          {goal ? (
            <Text style={[styles.goal, { color: t('fg-2') }]} numberOfLines={open ? undefined : 2}>
              {goal}
            </Text>
          ) : null}
        </View>
        <View style={styles.headRight}>
          <Text style={[styles.state, { color: t(tone) }]}>
            {running ? 'working' : failed ? 'failed' : 'done'}
          </Text>
          {meta ? <Text style={[styles.meta, { color: t('fg-2') }]}>{meta}</Text> : null}
        </View>
        {canOpen ? <Text style={[styles.chevron, { color: t('fg-3') }]}>{open ? '▾' : '▸'}</Text> : null}
      </Pressable>

      {failed && part.error ? (
        <Text style={[styles.error, { color: t('status-down') }]} numberOfLines={open ? undefined : 2}>
          {part.error}
        </Text>
      ) : null}

      {open && report
        ? report.map((section) => (
            <View key={section.label} style={styles.section}>
              <Text style={[styles.sectionLabel, { color: t('fg-3') }]}>
                {section.label === 'Output' ? 'Reported back' : section.label}
              </Text>
              <Text style={[styles.body, { color: t('fg-2') }]}>{section.text}</Text>
            </View>
          ))
        : null}

      {open && childSessionId ? (
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: t('fg-3') }]}>What it did</Text>
          {transcript.isPending ? (
            <ActivityIndicator size="small" color={t('fg-3')} />
          ) : transcript.data ? (
            <ChildTranscript parts={transcript.data.parts} truncated={transcript.data.truncated} />
          ) : (
            <Text style={[styles.body, { color: t('fg-3') }]}>
              {running ? 'Readable once it finishes.' : 'Could not read this one back.'}
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

/** The child's own turn, in the same shapes the main transcript uses: its
 * prose, its thinking, and one row per tool call. Read-only — the user asked for
 * visibility, not a second place to talk to them. */
function ChildTranscript({ parts, truncated }: { parts: Part[]; truncated: boolean }) {
  const { t } = useTheme();
  if (parts.length === 0) {
    return <Text style={[styles.body, { color: t('fg-3') }]}>It finished without saying anything.</Text>;
  }
  return (
    <View style={styles.child}>
      {parts.map((p, i) =>
        p.type === 'tool_call' ? (
          <ToolCallPart key={i} part={p} />
        ) : p.type === 'reasoning' ? (
          <Text key={i} style={[styles.childThinking, { color: t('fg-3') }]}>
            {p.text}
          </Text>
        ) : p.type === 'text' ? (
          <Text key={i} style={[styles.body, { color: t('fg-2') }]}>
            {p.text}
          </Text>
        ) : null,
      )}
      {truncated ? (
        <Text style={[styles.childThinking, { color: t('fg-3') }]}>… only the first part is kept</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 11, paddingVertical: 9, gap: 6, marginBottom: 6 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  glyph: { fontFamily: fonts.mono(550), fontSize: 13, lineHeight: 17, width: 12 },
  headText: { flex: 1, minWidth: 0, gap: 2 },
  headRight: { alignItems: 'flex-end', flexShrink: 0, gap: 1 },
  role: { fontFamily: fonts.mono(550), fontSize: 11.5, letterSpacing: 0.2 },
  goal: { fontFamily: fonts.sans(400), fontSize: 12.5, lineHeight: 17 },
  state: { fontFamily: fonts.mono(550), fontSize: 9, letterSpacing: 0.9, textTransform: 'uppercase' },
  meta: { fontFamily: fonts.mono(400), fontSize: 9.5 },
  chevron: { fontFamily: fonts.mono(400), fontSize: 10, lineHeight: 17, flexShrink: 0 },
  error: { fontFamily: fonts.sans(400), fontSize: 12, lineHeight: 16.5 },
  section: { gap: 2 },
  sectionLabel: { fontFamily: fonts.mono(550), fontSize: 8.5, letterSpacing: 1.1, textTransform: 'uppercase' },
  body: { fontFamily: fonts.sans(400), fontSize: 12.5, lineHeight: 17.5 },
  child: { gap: 6 },
  childThinking: { fontFamily: fonts.sans(400), fontSize: 12, lineHeight: 16.5, fontStyle: 'italic' },
});
