// A13 — the attention inbox. The one place that says what is waiting on the user
// across EVERY thread: an approval to answer, a question the agent asked, a
// failed run, a cron alert. Until `GET /api/chat/attention` existed, an
// attention row only ever reached the app inside the payload of the one thread
// it belonged to, so "is anything waiting on me" could only be answered by
// opening each thread in turn (src/chat/hooks.ts says exactly that).
//
// Presented as `DetailSheet` — the in-page page sheet Ops/System and the
// brief's ItemSheet already use — rather than a sheet ROUTE, because tapping a
// row navigates to the thread: a route sheet would have to pop itself off the
// chat stack first, where this one simply closes as the push happens (the same
// order ItemSheet's `followTarget` uses).
//
// Every field rendered here is one hub-api sent. There is no snooze or dismiss
// control: `attention.state` has no route that writes it from the app, and a
// button that silently did nothing would be worse than its absence.
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api } from '../../lib/api';
import { usePoll } from '../../lib/query';
import { relTime, toMs } from '../../shared/time';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import type { TokenName } from '../../theme/tokens.gen';
import type { AttentionInboxItem, ChatAttentionResponse } from '../../chat/types';
import { useChatStore, selectAnsweredAttentionIds } from '../../chat/store';
import { isDraftAttentionKind } from '../../chat/drafts';
import { Card, SkeletonCard, StatePanel } from '../shell';
import { DetailSheet } from '../system/DetailSheet';
import { KIND_LABEL } from './ThreadRow';

interface Tone {
  fg: TokenName;
  bg: TokenName;
  border: TokenName;
}

const TONES: Record<'warn' | 'down' | 'info', Tone> = {
  warn: { fg: 'status-warn', bg: 'status-warn-soft', border: 'status-warn-border' },
  down: { fg: 'status-down', bg: 'status-down-soft', border: 'status-down-border' },
  info: { fg: 'petrol', bg: 'petrol-soft', border: 'petrol-border' },
};

/** A run that failed or a lease that ran out reads as an error; a mention is
 * information; an iMessage draft still waiting on you is the same amber as a
 * generic approval. Everything else is the same amber "waiting on you" the
 * thread list already uses, including a kind this build has never heard of —
 * never under-alert on an unknown group. */
export function toneOf(kind: string): keyof typeof TONES {
  if (kind === 'run_failed' || kind === 'lease_timeout') return 'down';
  if (kind === 'mention') return 'info';
  return 'warn';
}

/** `expires_at_derived` is the approval's own deadline, and only approvals and
 * clarifies carry one — null for every other kind, which renders nothing. An
 * iMessage draft carries one too (it expires ~15 min after the Mac creates
 * it), so its countdown shows the same way. */
export function expiryLabel(expiresAt: string | null, now = Date.now()): string | null {
  const ms = toMs(expiresAt);
  if (ms == null) return null;
  return ms <= now ? 'expired' : `expires ${relTime(expiresAt, now)}`;
}

/** `kind.replace(/_/g, ' ')` is the honest default for a kind this build has
 * never named; the few that read badly lowercased get a title-cased label of
 * their own. An iMessage draft is the one here — "imessage draft" beside an
 * approval pill is exactly what the draft row is for. */
const KIND_TEXT: Record<string, string> = {
  imessage_draft: 'iMessage draft',
};

export function kindLabel(kind: string): string {
  return KIND_TEXT[kind] ?? kind.replace(/_/g, ' ');
}

function threadLabel(row: AttentionInboxItem): string {
  return row.thread_title?.trim() || KIND_LABEL[row.thread_kind] || row.thread_kind;
}

function InboxRow({ row, onPress }: { row: AttentionInboxItem; onPress: () => void }) {
  const { t } = useTheme();
  const tone = TONES[toneOf(row.kind)];
  const thread = threadLabel(row);
  const expiry = expiryLabel(row.expires_at_derived);
  const draft = isDraftAttentionKind(row.kind);

  return (
    <Card onPress={onPress} accessibilityLabel={`${kindLabel(row.kind)} in ${thread}`} style={styles.card}>
      <View style={styles.headRow}>
        <View style={[styles.pill, { backgroundColor: t(tone.bg), borderColor: t(tone.border) }]}>
          <Text style={[styles.pillLabel, { color: t(tone.fg) }]}>{kindLabel(row.kind)}</Text>
        </View>
        <Text style={[styles.time, { color: t('fg-2') }]}>{relTime(row.created_at)}</Text>
      </View>
      {row.summary ? (
        <Text style={[styles.summary, { color: t('fg-1') }]} numberOfLines={3}>
          {row.summary}
        </Text>
      ) : null}
      <View style={styles.metaRow}>
        <Text style={[styles.thread, { color: t('fg-3') }]} numberOfLines={1}>
          {thread}
        </Text>
        {/* A draft is answerable — send or discard — where most rows are read
            and dismissed by opening the thread; say so on the row itself. */}
        {draft ? (
          <Text style={[styles.hint, { color: t(tone.fg) }]}>tap to review</Text>
        ) : null}
        {expiry ? <Text style={[styles.expiry, { color: t(tone.fg) }]}>{expiry}</Text> : null}
      </View>
    </Card>
  );
}

export interface AttentionInboxProps {
  visible: boolean;
  onClose: () => void;
  /** Tapping a row opens its thread. The caller closes this sheet — it owns
   * both the sheet's visibility and the navigation. */
  onOpenThread: (threadId: string) => void;
}

export function AttentionInbox({ visible, onClose, onOpenThread }: AttentionInboxProps) {
  const query = usePoll<ChatAttentionResponse>(['chat-attention'], api.chatAttention, {
    enabled: visible,
  });
  // The server's list is only ever as fresh as its last poll. A row this client
  // already answered (from a thread, or seen resolved by `reconcileAttention`)
  // is filtered out immediately, so a draft that was just sent stops showing
  // here rather than lingering for the next minute.
  const chat = useChatStore((s) => s.chat);
  const answered = useMemo(() => selectAnsweredAttentionIds(chat), [chat]);
  const rows = useMemo(
    () => (query.data?.attention ?? []).filter((r) => !answered.has(r.id)),
    [query.data, answered],
  );
  const settled = !query.isLoading && !query.isError;

  return (
    <DetailSheet visible={visible} onClose={onClose} eyebrow="Chat" title="Needs you">
      {query.isLoading ? <SkeletonCard height={150} /> : null}
      {query.isError ? (
        <StatePanel tone="error" title="Inbox unavailable" detail={query.error?.message} />
      ) : null}
      {settled && rows.length === 0 ? (
        <StatePanel
          tone="neutral"
          title="Nothing is waiting on you"
          detail="Approvals, questions, failed runs and cron alerts land here."
        />
      ) : null}
      {rows.map((row) => (
        <InboxRow key={row.id} row={row} onPress={() => onOpenThread(row.thread_id)} />
      ))}
    </DetailSheet>
  );
}

const styles = StyleSheet.create({
  card: { paddingHorizontal: 14, paddingVertical: 12, marginBottom: 9, gap: 6 },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pill: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
  pillLabel: {
    fontFamily: fonts.mono(400),
    fontSize: 9.5,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  time: { flex: 1, minWidth: 0, textAlign: 'right', fontFamily: fonts.mono(400), fontSize: 10.5 },
  summary: { fontFamily: fonts.sans(400), fontSize: 13.5, lineHeight: 19 },
  metaRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  thread: { flex: 1, minWidth: 0, fontFamily: fonts.sans(550), fontSize: 12 },
  hint: { flexShrink: 0, fontFamily: fonts.sans(550), fontSize: 10.5 },
  expiry: { flexShrink: 0, fontFamily: fonts.mono(400), fontSize: 10.5 },
});
