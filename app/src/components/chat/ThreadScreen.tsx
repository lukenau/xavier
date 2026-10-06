// The transcript — Face ID gate → thread header → message list → pinned
// approval card(s) → composer. Structured like src/terminal/TerminalScreen.tsx
// (a raw View surface managing its own insets/keyboard, not <Screen>'s
// ScrollView shape) because the same reasons apply: the composer's keyboard
// has to sit outside anything that owns its own scroll, and the transcript
// needs the remaining height, not a growing content column.
//
// NATIVE-BUILD SWAP: `FlatList` here is RN core, per this slice's
// OTA-only constraint. A native-build slice adding FlashList/LegendList
// swaps the list implementation only — data shape (`ChatMessage[]`,
// inverted) and `renderItem` (`MessageBubble`) do not change.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Clipboard, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiError, api } from '../../lib/api';
import { usePoll } from '../../lib/query';
import type { AgentSession } from '../../lib/types';
import { useSendMessage, useThreadDetail } from '../../chat/hooks';
import { selectDraft, selectMessages, selectPendingApprovals, selectThread, useChatStore } from '../../chat/store';
import { groupTranscript, type TranscriptItem } from '../../chat/transcript';
import { turnStateOf } from '../../chat/turnState';
import { TurnIndicator } from './parts/TurnIndicator';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY, StatePanel, Toast, useHideTabBar } from '../shell';
import { XavierMoment } from '../../whimsy';
import type { ToastKind } from '../shell';
import { ChatLockGate } from './ChatLockGate';
import { Composer, type ComposerHandle, type ComposerMode } from './Composer';
import { MessageBubble } from './MessageBubble';
import { ActivityBlock } from './parts/ActivityBlock';
import { AgentsBlock } from './parts/AgentsBlock';
import { RunningAgentsStrip } from './parts/RunningAgentsStrip';
import { WorkingRow } from './parts/WorkingRow';
import { ApprovalCard } from './parts/ApprovalCard';
import { DraftApprovalCard } from './parts/DraftApprovalCard';
import { ThreadStatusRing } from './parts/ThreadStatusRing';
import { shortModel } from '../home/xavierState';
import { ThreadMenuButton } from './ThreadMenu';
import { KIND_LABEL } from './ThreadRow';

// Stop dispatches the gateway's own `/stop` command, whose `busy_policy` is
// `interrupt_then_dispatch`: a running turn is interrupted and then the command
// runs (the user: "stop is wired to /stop"). The route answers 404 when hub-api has
// no such thread and 502 when the gateway did not take the event — two
// different stories, told apart here rather than collapsed into one string.
export function stopOutcome(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) return 'Nothing to stop — the Hub has no record of this thread.';
  if (err instanceof ApiError && err.status === 502) return "Couldn't reach the agent to stop it.";
  return err instanceof Error && err.message ? `Stop failed: ${err.message}` : 'Stop failed.';
}

export interface ThreadSurfaceProps {
  threadId: string;
  /** What this thread is about, drawn above its first message and scrolling
   * with it — a scheduled job's run, above the follow-up to it. */
  lead?: ReactNode;
  /** Openers offered while nothing has been said yet. Each fills the composer. */
  asks?: string[];
}

/** Exported for ThreadScreen.test.tsx — the gate wrapper below needs a real
 * unlock stamp, and the layout is what the test is about. */
export function ThreadSurface({ threadId, lead, asks }: ThreadSurfaceProps) {
  useHideTabBar();
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const detail = useThreadDetail(threadId);
  // Coming back to a thread re-reads it. The WebSocket is the live path, but a
  // frame it misses used to leave the thread wrong until the app was killed —
  // a half-written reply sat there "working" for ever (the user, 2026-09-22).
  const refetchDetail = detail.refetch;
  useFocusEffect(
    useCallback(() => {
      void refetchDetail();
    }, [refetchDetail]),
  );
  const { send, retry } = useSendMessage(threadId);
  const thread = useChatStore(selectThread(threadId));
  const messages = useChatStore(selectMessages(threadId));
  const chat = useChatStore((s) => s.chat);
  const approvals = useMemo(
    () => selectPendingApprovals(chat).filter((a) => a.thread_id === threadId),
    [chat, threadId],
  );
  // Steer is the default: a message sent mid-turn should redirect the work in
  // flight, not queue behind it and not cut it dead (the user, 2026-09-22).
  const [mode, setMode] = useState<ComposerMode>('steer');
  const draft = useChatStore(selectDraft(threadId));
  const setDraft = useChatStore((s) => s.setDraft);
  const clearDraft = useChatStore((s) => s.clearDraft);
  const [notice, setNotice] = useState<{ kind: ToastKind; text: string } | null>(null);
  const [stopping, setStopping] = useState(false);
  const stopInFlight = useRef(false);
  const composer = useRef<ComposerHandle>(null);

  async function stop() {
    if (stopInFlight.current) return;
    stopInFlight.current = true;
    setStopping(true);
    try {
      await api.chatStopThread(threadId);
      setNotice({ kind: 'ok', text: 'Stop sent' });
    } catch (err) {
      setNotice({ kind: 'err', text: stopOutcome(err) });
    } finally {
      stopInFlight.current = false;
      setStopping(false);
    }
  }

  // Marks read once per (thread, last_seq) pair — `thread?.last_seq` in the
  // deps array already dedups re-fires for the same value; the ref only
  // guards against re-marking the SAME seq again after a threadId switch
  // reuses a lower one transiently during the store's hydrate.
  const markedSeq = useRef(-1);
  useEffect(() => {
    markedSeq.current = -1;
  }, [threadId]);
  useEffect(() => {
    if (!thread || thread.unread === 0) return;
    if (thread.last_seq <= markedSeq.current) return;
    markedSeq.current = thread.last_seq;
    void api.chatMarkRead(threadId, thread.last_seq).catch(() => {});
  }, [threadId, thread?.last_seq, thread?.unread, thread]);

  const title = thread?.title?.trim() || KIND_LABEL[thread?.kind ?? 'chat'] || 'Chat';
  // Derived from the transcript: nothing sets thread.status, so the Stop
  // button never appeared and there was no sign of life between sending and
  // the first token (the user, 2026-09-22).
  const turnState = turnStateOf(messages, Date.now(), thread?.status);
  const running = turnState !== 'idle';
  // A21 — the model, only when the data carries one. The thread knows which
  // gateway session it is bound to (`hermes_session_id`, set on delivery); the
  // session record is the only place a model name exists. No session, no
  // record, or a record without a model: no pill, never a guess.
  const sessionId = thread?.hermes_session_id ?? '';
  const session = usePoll<AgentSession>(
    ['chat-thread-model', sessionId],
    () => api.session(sessionId),
    { enabled: sessionId.length > 0, refetchInterval: false, retry: false },
  );
  const model = session.data?.model ? shortModel(session.data.model) : null;
  // Stable identities, or memoizing the rows buys nothing: a new callback on
  // every render is a new prop, and a new prop is a re-render.
  const copy = useCallback((text: string) => {
    Clipboard.setString(text);
    setNotice({ kind: 'ok', text: 'Copied' });
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: TranscriptItem }) =>
      item.kind === 'progress' ? (
        <WorkingRow progress={item.progress} />
      ) : item.kind === 'activity' ? (
        <ActivityBlock parts={item.parts} toolCount={item.toolCount} durationMs={item.durationMs} />
      ) : item.kind === 'agents' ? (
        <AgentsBlock agents={item.agents} startedAt={item.startedAt} endedAt={item.endedAt} threadId={threadId} />
      ) : (
        <MessageBubble message={item.message} onRetrySend={retry} onCopy={copy} />
      ),
    [retry, copy, threadId],
  );

  // Grouped first, then reversed for the inverted list: a turn's quiet tool
  // calls collapse into one activity row (chat/transcript.ts).
  const reversed = useMemo(() => groupTranscript(messages).reverse(), [messages]);
  const listRef = useRef<FlatList<TranscriptItem>>(null);
  // Agents still working with newer rows below them: pinned, so they are never
  // lost up the transcript; a tap scrolls back to their block.
  const liveAgents = useMemo(() => {
    const index = reversed.findIndex((item) => item.kind === 'agents' && item.running > 0);
    if (index <= 0) return null;
    const item = reversed[index];
    return item.kind === 'agents' ? { index, item } : null;
  }, [reversed]);

  return (
    <View style={[styles.surface, { backgroundColor: t('bg-0') }]}>
      <View style={[styles.header, { paddingTop: insets.top + 4, borderBottomColor: t('border') }]}>
        <Pressable
          accessibilityLabel="Back"
          accessibilityRole="button"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.headerBack, pressed && { opacity: PRESSED_OPACITY }]}
        >
          <Text style={[styles.headerBackGlyph, { color: t('accent') }]}>‹</Text>
        </Pressable>
        <ThreadStatusRing state={turnState} />
        <View style={styles.headerText}>
          <Text numberOfLines={1} style={[styles.headerTitle, { color: t('fg-1') }]}>
            {title}
          </Text>
          {model ? (
            <Text numberOfLines={1} style={[styles.headerModel, { color: t('fg-4') }]}>
              {model}
            </Text>
          ) : null}
        </View>
        {thread ? (
          <ThreadMenuButton thread={thread} onError={(text) => setNotice({ kind: 'err', text })} />
        ) : null}
      </View>

      {detail.isError ? (
        <StatePanel tone="error" title="Thread unavailable" detail={detail.error?.message} />
      ) : null}
      {detail.isLoading && !detail.data ? (
        <StatePanel tone="pending" title="Loading conversation…" />
      ) : null}

      {/* The transcript and the composer share one column that SHRINKS by the
          keyboard height. The first cut pinned the composer with
          KeyboardStickyView, which translates it and resizes nothing (the
          terminal's shape, where a WebView cannot be resized) — so the
          composer slid up over a full-height list and the newest messages
          stayed underneath it, unreachable. A list can resize, so it does. */}
      <KeyboardAvoidingView behavior="padding" style={styles.column}>
        <FlatList
          ref={listRef}
          data={reversed}
          inverted
          // The lead is the list's footer: on an inverted list that is the
          // visual top, above the first message, scrolling with the rest. It
          // stays in the one list rather than swapping to a page view while
          // the transcript is empty — a swap remounts the lead and jumps the
          // moment the first reply lands (review, 2026-09-29).
          ListFooterComponent={lead ? <View style={styles.lead}>{lead}</View> : null}
          onScrollToIndexFailed={() => {}}
          // Anchor the newest message (index 0 of an inverted list) while the
          // rest measure. Without this a thread full of tall cards — a
          // checklist, a weather widget — opened part-way up and then visibly
          // settled as each card found its height (the user, 2026-09-23: "it opens
          // super high up at these messages and then after a sec the ones below
          // start loading").
          // `autoscrollToTopThreshold` is the half that was missing: without it
          // the anchor holds the PREVIOUS newest row in place and a new row —
          // the thinking that just started, the reply that just began — lands
          // below the viewport, unseen until the list re-anchors. That is "it
          // only shows up after it's fully written" and "only flashes in when
          // i reopen the chat" (the user, 2026-09-28). Within 80pt of the bottom
          // the list now follows new content, as a chat should.
          maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 80 }}
          initialNumToRender={8}
          // A cold open used to mount the whole transcript in one commit.
          maxToRenderPerBatch={6}
          updateCellsBatchingPeriod={40}
          windowSize={7}
          keyExtractor={(item) => item.key}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          ListEmptyComponent={
            detail.data && !lead ? (
              // `inverted` is a scaleY(-1) on the list, applied to this component
              // too — it rendered upside down on the user's phone. Cells get their own
              // counter-flip from RN; an empty component does not, so it needs this.
              <View style={styles.unflip}>
                <View style={styles.xavierHero}>
                  <XavierMoment id="chat.empty" size="hero" />
                </View>
                <StatePanel
                  moment={false}
                  tone="neutral"
                  title="No messages yet"
                  detail="This thread is open, nothing has been said."
                />
              </View>
            ) : null
          }
        />

        {asks && asks.length > 0 && messages.length === 0 && thread ? (
          <View style={styles.asks}>
            {asks.map((ask) => (
              <Pressable
                key={ask}
                accessibilityRole="button"
                accessibilityLabel={ask}
                // Into the field, not out the door: he reads it, adds to it
                // or not, and sends it himself.
                onPress={() => composer.current?.fill(ask)}
                style={({ pressed }) => [
                  styles.ask,
                  { backgroundColor: t('petrol-soft'), borderColor: t('petrol-border') },
                  pressed && { opacity: PRESSED_OPACITY },
                ]}
              >
                <Text style={[styles.askLabel, { color: t('fg-0') }]}>{ask}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {approvals.length > 0 ? (
          <View style={styles.approvals}>
            {approvals.map((a) =>
              a.draft ? (
                <DraftApprovalCard key={a.attention_id} approval={a} />
              ) : (
                <ApprovalCard key={a.attention_id} approval={a} />
              ),
            )}
          </View>
        ) : null}

        {liveAgents ? (
          <RunningAgentsStrip
            count={liveAgents.item.running}
            startedAt={liveAgents.item.startedAt}
            goals={liveAgents.item.agents
              .filter((a) => a.part.status === 'running')
              .map((a) => a.goal ?? a.part.subagent?.child_role ?? 'agent')}
            onPress={() => listRef.current?.scrollToIndex({ index: liveAgents.index, animated: true, viewPosition: 0.5 })}
          />
        ) : null}

        <TurnIndicator state={turnState} />
        <Composer
          key={threadId}
          ref={composer}
          initialDraft={draft}
          onDraftChange={(text) => (text ? setDraft(threadId, text) : clearDraft(threadId))}
          mode={mode}
          onModeChange={setMode}
          running={running}
          stopping={stopping}
          unavailable={thread ? null : detail.isError ? 'error' : 'loading'}
          threadId={threadId}
          onSend={(text, sendMode, mediaIds) => {
            clearDraft(threadId);
            void send(text, running ? sendMode : undefined, mediaIds);
          }}
          onStop={() => void stop()}
        />
      </KeyboardAvoidingView>

      {/* OUTSIDE the avoiding column, and a fixed height. Inside it, the height
          had to switch on the keyboard's state, and that JS update ran on a
          different timeline from the avoiding view's own animation — the bar
          dropped too far and slid back up (the flicker the user saw, 2026-09-22).
          Static, the column's bottom edge simply sits this far off the screen
          bottom and KeyboardAvoidingView subtracts it from the padding it
          applies, so the composer lands exactly on the keyboard. Painted, not
          bare: unpainted it showed the ground through as a black strip. */}
      <View style={{ height: insets.bottom, backgroundColor: t('bg-1') }} />

      {notice ? <Toast kind={notice.kind} text={notice.text} onDone={() => setNotice(null)} /> : null}
    </View>
  );
}

export default function ThreadScreen() {
  const { threadId } = useLocalSearchParams<{ threadId?: string }>();

  if (!threadId) {
    return (
      <View style={styles.surface}>
        <StatePanel tone="error" title="No thread" detail="This link is missing a thread id." />
      </View>
    );
  }

  return (
    <ChatLockGate>
      <ThreadSurface threadId={threadId} />
    </ChatLockGate>
  );
}

const styles = StyleSheet.create({
  surface: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
  },
  headerBack: { minWidth: 36, minHeight: 36, justifyContent: 'center' },
  headerBackGlyph: { fontFamily: fonts.sans(400), fontSize: 22 },
  headerText: { flex: 1, minWidth: 0 },
  headerTitle: { fontFamily: fonts.sans(600), fontSize: 15 },
  headerModel: { fontFamily: fonts.mono(400), fontSize: 10, letterSpacing: 0.2, marginTop: 1 },
  column: { flex: 1 },
  unflip: { transform: [{ scaleY: -1 }] },
  xavierHero: { alignItems: 'center', paddingTop: 24, paddingBottom: 8 },
  // No flexGrow: on an INVERTED list it makes the container stretch to the
  // viewport and then re-lay out as rows measure, which is the jump the user
  // filmed — the messages flick up and settle back a beat after the push.
  // The empty state does not need it either; `inverted` already puts it at the
  // visual bottom.
  listContent: { paddingHorizontal: 14, paddingVertical: 12 },
  approvals: { paddingHorizontal: 14, paddingBottom: 8, gap: 8 },
  lead: { marginBottom: 12 },
  asks: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 14, paddingBottom: 10 },
  ask: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 13, paddingVertical: 8 },
  askLabel: { fontFamily: fonts.sans(500), fontSize: 13 },
});
