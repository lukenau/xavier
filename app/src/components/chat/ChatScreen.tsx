// Chat tab root — the Threads list. Replaces the pre-platform stub
// (docs/research/hub-chat/VERDICT-V2.md §5/§9): hub-api's chat store and
// gateway plugin now exist, so this renders the real thing behind the same
// Face-ID cookie gate the terminal uses.
//
// Sections per the approved prototype: Needs you / Pinned / Recent. A thread
// can only ever appear in one — needs-you takes priority over pinned, pinned
// over recent — so counts across sections always add up to the thread total.
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import type { Vitals } from '../../lib/types';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { useChatBootstrap } from '../../chat/hooks';
import { useChatStore, selectNeedsYouThreadIds, selectThreadList } from '../../chat/store';
import type { Thread } from '../../chat/types';
import { turnStateOf } from '../../chat/turnState';
import { PRESSED_OPACITY, PageTitle, RefreshControl, Screen, SectionHead, SkeletonCard, StatePanel } from '../shell';
import { XavierMoment } from '../../whimsy';
import { agentStatus } from './agentStatus';
import { AttentionInbox } from './AttentionInbox';
import { ChatLockGate } from './ChatLockGate';
import { KIND_LABEL, ThreadRow } from './ThreadRow';

function openThread(threadId: string) {
  router.push({ pathname: '/chat/thread', params: { threadId } });
}

/** The prototype's header chip (`<button class="act">New</button>`): the only
 * way to start a conversation — every other thread is opened by the gateway
 * delivering into it. Creates server-side, then opens it. */
function NewThreadButton({ onCreated }: { onCreated: () => void }) {
  const { t } = useTheme();
  const [busy, setBusy] = useState(false);

  async function create() {
    if (busy) return;
    setBusy(true);
    try {
      const { thread } = await api.chatCreateThread();
      onCreated();
      openThread(thread.id);
    } catch {
      // Nothing to recover: the list is unchanged and the button is live again.
    } finally {
      setBusy(false);
    }
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New chat"
      disabled={busy}
      onPress={() => void create()}
      style={({ pressed }) => [
        styles.newChip,
        { borderColor: t('border'), backgroundColor: t('bg-1') },
        (pressed || busy) && { opacity: PRESSED_OPACITY },
      ]}
    >
      <Text style={[styles.newChipLabel, { color: t('fg-3') }]}>New</Text>
    </Pressable>
  );
}

/** A13's way in. Deliberately carries no count: the number of rows waiting is
 * the sheet's own read (`GET /chat/attention`), and a badge here sourced from
 * the socket-hydrated store instead would disagree with what opens. */
function InboxButton({ onPress }: { onPress: () => void }) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Inbox"
      onPress={onPress}
      style={({ pressed }) => [
        styles.newChip,
        { borderColor: t('border'), backgroundColor: t('bg-1') },
        pressed && { opacity: PRESSED_OPACITY },
      ]}
    >
      <Text style={[styles.newChipLabel, { color: t('fg-3') }]}>Inbox</Text>
    </Pressable>
  );
}

/** A7 — the agent-status line. `vitals` is the same query key Home already
 * polls, so on a warm cache this costs nothing; the socket status is local. */
function AgentStatusLine() {
  const { t } = useTheme();
  const vitals = usePoll<Vitals>(['vitals'], api.vitals, QUERY_TUNING.vitals);
  const connection = useChatStore((s) => s.connection);
  const { label, tone } = agentStatus(vitals.data, connection);

  return (
    <View style={styles.agentRow}>
      <View style={[styles.agentDot, { backgroundColor: t(tone) }]} />
      <Text style={[styles.agentLabel, { color: t('fg-3') }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function ThreadList() {
  const query = useChatBootstrap();
  const [inboxOpen, setInboxOpen] = useState(false);
  // One stable slice in, derived collections out under useMemo — see the
  // selectors note in chat/store.ts for why they must not go through the hook.
  const chat = useChatStore((s) => s.chat);
  const threads = useMemo(() => selectThreadList(chat), [chat]);
  const needsYouIds = useMemo(() => selectNeedsYouThreadIds(chat), [chat]);
  const byThread = chat.threads;

  const { needsYou, pinned, recent } = useMemo(() => {
    const needsYou: Thread[] = [];
    const pinned: Thread[] = [];
    const recent: Thread[] = [];
    // Archived threads leave the list — that is what archiving them does. They
    // are not deleted: unarchiving is a `patch` away and the transcript is
    // untouched.
    for (const thread of threads.filter((t) => !t.archived)) {
      if (needsYouIds.has(thread.id)) needsYou.push(thread);
      else if (thread.pinned) pinned.push(thread);
      else recent.push(thread);
    }
    return { needsYou, pinned, recent };
  }, [threads, needsYouIds]);

  function attentionSummaryFor(thread: Thread): string | null {
    const open = byThread[thread.id]?.attention.find((a) => a.state === 'open');
    return open?.summary || null;
  }

  /** A10 — names the thread this one was spun out of, from the threads this
   * client already holds. `origin_thread_id` pointing somewhere unknown still
   * earns a pill: the link is a fact even when the far end isn't loaded. */
  function originLabelFor(thread: Thread): string | null {
    if (!thread.origin_thread_id) return null;
    const origin = byThread[thread.origin_thread_id]?.thread;
    if (!origin) return 'linked';
    return origin.title?.trim() || KIND_LABEL[origin.kind] || origin.kind;
  }

  /** The server's read, or — for a thread whose messages this screen already
   *  holds — the transcript's own live state, which moves the moment a frame
   *  arrives rather than at the next list poll. */
  function workingFor(thread: Thread): boolean {
    const messages = byThread[thread.id]?.messages;
    const live = messages && messages.length > 0 ? turnStateOf(messages, Date.now(), thread.status) : null;
    return live === 'working' || live === 'waiting' || (live === null && Boolean(thread.working));
  }

  function rowProps(thread: Thread) {
    return {
      thread,
      attentionSummary: attentionSummaryFor(thread),
      originLabel: originLabelFor(thread),
      working: workingFor(thread),
      onPress: () => openThread(thread.id),
    };
  }

  return (
    <Screen
      header={
        <>
          <PageTitle
            right={
              <View style={styles.headerActions}>
                <InboxButton onPress={() => setInboxOpen(true)} />
                <NewThreadButton onCreated={() => void query.refetch()} />
                <RefreshControl queries={[query]} />
              </View>
            }
          >
            Chat
          </PageTitle>
          <AgentStatusLine />
        </>
      }
    >
      {query.isLoading && !query.data ? <SkeletonCard height={220} /> : null}
      {query.isError ? (
        <StatePanel tone="error" title="Chat unavailable" detail={query.error?.message} />
      ) : null}
      {query.data && needsYou.length + pinned.length + recent.length === 0 ? (
        <>
          <View style={styles.xavierHero}>
            <XavierMoment id="welcome" size="hero" />
          </View>
          <StatePanel
            moment={false}
            tone="neutral"
            title="No threads yet"
            detail="Tap New to start one. Brief, Ops, Money and Cron open themselves the first time Xavier writes to them."
          />
        </>
      ) : null}

      {needsYou.length > 0 ? (
        <>
          <SectionHead label="Needs you" count={`${needsYou.length}`} />
          {needsYou.map((thread) => (
            <ThreadRow key={thread.id} needsYou {...rowProps(thread)} />
          ))}
        </>
      ) : null}

      {pinned.length > 0 ? (
        <>
          <SectionHead label="Pinned" count={`${pinned.length}`} />
          {pinned.map((thread) => (
            <ThreadRow key={thread.id} needsYou={false} {...rowProps(thread)} />
          ))}
        </>
      ) : null}

      {recent.length > 0 ? (
        <>
          <SectionHead label="Recent" count={`${recent.length}`} />
          {recent.map((thread) => (
            <ThreadRow key={thread.id} needsYou={false} {...rowProps(thread)} />
          ))}
        </>
      ) : null}

      {/* Mounted whether or not it is open, so its dismissal is the system's
          animation rather than an unmount (ItemSheet keeps its modal the same
          way). Closing before the push means the thread is never pushed under
          a presented sheet. */}
      <AttentionInbox
        visible={inboxOpen}
        onClose={() => setInboxOpen(false)}
        onOpenThread={(threadId) => {
          setInboxOpen(false);
          openThread(threadId);
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  xavierHero: { alignItems: 'center', paddingTop: 8, paddingBottom: 4 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  agentRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: -2, marginBottom: 4 },
  agentDot: { width: 6, height: 6, borderRadius: 3 },
  agentLabel: { flex: 1, minWidth: 0, fontFamily: fonts.mono(400), fontSize: 11 },
  newChip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 },
  newChipLabel: { fontFamily: fonts.mono(400), fontSize: 10.5, letterSpacing: 0.3 },
});

export default function ChatScreen() {
  return (
    <ChatLockGate header={<PageTitle>Chat</PageTitle>}>
      <ThreadList />
    </ChatLockGate>
  );
}
