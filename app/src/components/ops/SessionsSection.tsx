// Ops.tsx:127-261 — Hermes AGENT sessions (what Xavier has been doing), and
// the transcript sheet behind each row. Not to be confused with ShellsSection,
// which lists host tmux sessions running the `claude` CLI.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { UseQueryResult } from '@tanstack/react-query';
import { SectionHead, StatePanel } from '../shell';
import { DetailSheet } from '../system/DetailSheet';
import { ChevronRight, OpsCard, OPS_PRESSED } from './parts';
import {
  SESSIONS_COLLAPSED_COUNT,
  sessionMeta,
  sessionRowHasBorder,
  sourceBadgeTone,
} from './opsFormat';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import type { AgentSession, SessionMessage } from '../../lib/types';

/** Ops.tsx:156-199. Only `user` (with content) and `assistant` rows render;
 * `system` and `tool` rows, and assistants with neither content nor a named
 * tool call, render nothing at all. */
function Message({ m }: { m: SessionMessage }) {
  const { t } = useTheme();
  if (m.role === 'user' && m.content) {
    return (
      <View style={styles.userRow}>
        <View style={[styles.bubble, { backgroundColor: t('accent-soft'), borderColor: t('accent-border') }]}>
          <Text style={[styles.bubbleText, { color: t('fg-0') }]}>{m.content}</Text>
        </View>
      </View>
    );
  }
  if (m.role === 'assistant') {
    const tools = (m.tool_calls ?? []).filter((tc) => tc.name);
    if (!m.content && tools.length === 0) return null;
    return (
      <View style={styles.assistantRow}>
        {m.content ? (
          <View style={[styles.bubble, { backgroundColor: t('bg-0'), borderColor: t('border') }]}>
            <Text style={[styles.bubbleText, { color: t('fg-1') }]}>{m.content}</Text>
          </View>
        ) : null}
        {tools.length > 0 ? (
          <View style={styles.toolRow}>
            {tools.map((tc, j) => (
              <View key={j} style={[styles.toolChip, { backgroundColor: t('bg-2'), borderColor: t('border') }]}>
                <Text style={[styles.toolLabel, { color: t('fg-3') }]}>⚙ {tc.name}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    );
  }
  return null;
}

function SessionSheet({ session, onClose }: { session: AgentSession | null; onClose: () => void }) {
  const q = usePoll<SessionMessage[]>(
    ['session', session?.id ?? ''],
    () => api.sessionMessages(session!.id),
    { ...QUERY_TUNING['session-messages'], enabled: session !== null },
  );

  return (
    <DetailSheet
      visible={session !== null}
      onClose={onClose}
      eyebrow="Session"
      title={session?.title ?? session?.source ?? ''}
    >
      {q.isLoading ? <StatePanel tone="pending" title="Loading messages…" /> : null}
      {q.isError ? <StatePanel tone="error" title="Messages unavailable" detail={q.error?.message ?? ''} /> : null}
      {q.data && q.data.length === 0 ? (
        <StatePanel tone="neutral" title="No messages" detail="This session has no transcript." />
      ) : null}
      {q.data && q.data.length > 0 ? (
        <View style={styles.transcript}>
          {q.data.map((m, i) => (
            <Message key={m.id ?? i} m={m} />
          ))}
        </View>
      ) : null}
    </DetailSheet>
  );
}

export function SessionsSection({ q }: { q: UseQueryResult<AgentSession[], Error> }) {
  const { t } = useTheme();
  const [selected, setSelected] = useState<AgentSession | null>(null);
  const [showAll, setShowAll] = useState(false);

  const sessions = q.data ?? [];
  const shown = showAll ? sessions : sessions.slice(0, SESSIONS_COLLAPSED_COUNT);

  return (
    <View style={styles.section}>
      <SectionHead label="Sessions" count={q.data ? `${sessions.length}` : ''} />
      {q.isLoading ? <StatePanel tone="pending" title="Loading sessions…" detail="gateway session store" /> : null}
      {q.isError ? <StatePanel tone="error" title="Sessions unavailable" detail={q.error?.message ?? ''} /> : null}
      {q.data && sessions.length === 0 ? (
        <StatePanel tone="neutral" title="No sessions yet" detail="Xavier hasn't run any sessions." />
      ) : null}
      {q.data && sessions.length > 0 ? (
        <OpsCard>
          {shown.map((s, i) => {
            const badge = sourceBadgeTone(s.source);
            return (
              <Pressable
                key={s.id}
                onPress={() => setSelected(s)}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.row,
                  sessionRowHasBorder(i, shown.length, sessions.length)
                    ? { borderBottomWidth: 1, borderBottomColor: t('border') }
                    : null,
                  pressed && { opacity: OPS_PRESSED },
                ]}
              >
                <View style={[styles.badge, { backgroundColor: t(badge.bg), borderColor: t(badge.border) }]}>
                  <Text style={[styles.badgeLabel, { color: t(badge.fg) }]}>{s.source}</Text>
                </View>
                <View style={styles.rowText}>
                  <Text style={[styles.title, { color: t('fg-0') }]} numberOfLines={1} ellipsizeMode="tail">
                    {s.title ?? s.preview ?? s.id}
                  </Text>
                  <Text style={[styles.meta, { color: t('fg-3') }]} numberOfLines={1} ellipsizeMode="tail">
                    {sessionMeta(s)}
                  </Text>
                </View>
                <ChevronRight />
              </Pressable>
            );
          })}
          {sessions.length > SESSIONS_COLLAPSED_COUNT ? (
            <Pressable
              onPress={() => setShowAll((v) => !v)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.showAll, pressed && { opacity: OPS_PRESSED }]}
            >
              <Text style={[styles.showAllLabel, { color: t('fg-2') }]}>
                {showAll ? 'Show fewer' : `Show all ${sessions.length}`}
              </Text>
            </Pressable>
          ) : null}
        </OpsCard>
      ) : null}
      <SessionSheet session={selected} onClose={() => setSelected(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  rowText: { flex: 1, minWidth: 0 },
  badge: { flexShrink: 0, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 3, borderWidth: 1 },
  badgeLabel: { fontFamily: fonts.mono(400), fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase' },
  title: { fontFamily: fonts.sans(520), fontSize: 15 },
  meta: { fontFamily: fonts.mono(400), fontSize: 10.5 },
  showAll: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  showAllLabel: { fontFamily: fonts.sans(400), fontSize: 12 },
  transcript: { flexDirection: 'column', paddingHorizontal: 4, paddingBottom: 4 },
  userRow: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 8 },
  assistantRow: { flexDirection: 'column', alignItems: 'flex-start', marginBottom: 8 },
  bubble: { maxWidth: '85%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1 },
  bubbleText: { fontFamily: fonts.sans(400), fontSize: 13, lineHeight: 18.85 },
  toolRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 5, maxWidth: '85%' },
  toolChip: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1 },
  toolLabel: { fontFamily: fonts.mono(400), fontSize: 10.5 },
});
