// The chat app-state store — zustand, same shape-of-purpose as
// src/terminal/lock.ts and src/lib/store.ts: plain state plus the setters
// that feed it, with every side effect (the socket, AsyncStorage, HTTP) owned
// by whoever calls those setters. `ChatSocketClient` (wsClient.ts) and the
// REST reads (chat/routes.py) are wired in by the chat screen/hook, not by
// this file — this store only knows how to fold what it's handed.
import { create } from 'zustand';
import type { ChatConnStatus } from './wsClient';
import {
  applyLocalMessage,
  chatReducer,
  discardLocalMessage,
  initialChatState,
  mergeThreadSnapshot,
  reconcileOpenAttention,
  type ChatState,
} from './reducer';
import type {
  AttentionInboxItem,
  ChatFrame,
  ChatMessage,
  DraftApprovalDetails,
  PendingApprovalView,
  Thread,
  ToolCallPart,
} from './types';
import { draftDetailsFromPart, isDraftAttentionKind, isDraftToolCall } from './drafts';

interface ChatStoreState {
  connection: ChatConnStatus;
  chat: ChatState;
  /** Per-thread composer text, kept here (not component state) so switching
   * threads mid-draft never loses what was typed — deliberately NOT persisted
   * to AsyncStorage: a draft is a live-session convenience, not durable state. */
  drafts: Record<string, string>;

  applyFrame: (frame: ChatFrame) => void;
  /** A batch, folded in ONE state update. Opening a thread replays its whole
   * event log — one WebSocket frame per message — and applying them one at a
   * time re-rendered the list per frame, which is the flicker on open. */
  applyFrames: (frames: ChatFrame[]) => void;
  setConnection: (status: ChatConnStatus) => void;
  /** Folds a REST bootstrap/thread-detail read into state — the same shape a
   * WebSocket frame produces, so every selector below works regardless of
   * which path populated it. */
  hydrateSnapshot: (thread: Thread, messages: ChatMessage[]) => void;
  /** `GET /api/chat/attention`'s open rows, folded in as the truth about what
   * is waiting: a local row the server has resolved stops counting. */
  reconcileAttention: (open: AttentionInboxItem[]) => void;
  /** The composer's send path (chat/hooks.ts's `sendChatMessage`): the
   * optimistic echo, its 'error' flip on a failed POST, and reconciling the
   * placeholder with `/send`'s real response all go through this one setter —
   * see `applyLocalMessage`'s own doc for why there is no second path. */
  upsertLocalMessage: (threadId: string, message: ChatMessage) => void;
  removeLocalMessage: (threadId: string, messageId: string) => void;
  setDraft: (threadId: string, text: string) => void;
  clearDraft: (threadId: string) => void;
  /** Screen unmount / logout: drops everything this session accumulated.
   * Never clears the unlock stamp — that is lock.ts's job. */
  reset: () => void;
}

export const useChatStore = create<ChatStoreState>((set) => ({
  connection: 'connecting',
  chat: initialChatState,
  drafts: {},

  applyFrame: (frame) => set((s) => ({ chat: chatReducer(s.chat, frame) })),
  applyFrames: (frames) =>
    set((s) => (frames.length === 0 ? s : { chat: frames.reduce(chatReducer, s.chat) })),
  setConnection: (status) => set({ connection: status }),
  hydrateSnapshot: (thread, messages) => set((s) => ({ chat: mergeThreadSnapshot(s.chat, thread, messages) })),
  reconcileAttention: (open) =>
    set((s) => {
      const chat = reconcileOpenAttention(s.chat, open);
      return chat === s.chat ? s : { chat };
    }),
  upsertLocalMessage: (threadId, message) =>
    set((s) => ({ chat: applyLocalMessage(s.chat, threadId, message) })),
  removeLocalMessage: (threadId, messageId) =>
    set((s) => ({ chat: discardLocalMessage(s.chat, threadId, messageId) })),

  setDraft: (threadId, text) =>
    set((s) => ({ drafts: { ...s.drafts, [threadId]: text } })),
  clearDraft: (threadId) =>
    set((s) => {
      if (!(threadId in s.drafts)) return s;
      const drafts = { ...s.drafts };
      delete drafts[threadId];
      return { drafts };
    }),

  reset: () => set({ connection: 'connecting', chat: initialChatState, drafts: {} }),
}));

// --- selectors ------------------------------------------------------------------
// Two kinds. Selectors that return something already held by reference in
// the store (`selectThread`, `selectMessages`, `selectDraft`) can be passed to
// `useChatStore(...)` directly. Selectors that DERIVE a new collection
// (`selectThreadList`, `selectNeedsYouThreadIds`, `selectPendingApprovals`)
// take the `chat` slice and must be called inside `useMemo` on
// `useChatStore((s) => s.chat)`: zustand 5 selects through
// useSyncExternalStore, which re-renders forever when a selector hands back a
// fresh array/Set on every call — the "Maximum update depth exceeded" the
// Chat tab hit on the phone on 2026-09-22 (ChatScreen.test.tsx pins it).

/** Pinned first, then most-recently-active — mirrors chat/store.py's
 * `list_threads` ORDER BY exactly, so the app's ordering never drifts from
 * what a REST bootstrap already returned pre-sorted. */
/** A run's follow-up lives under its run and a job's delivery thread under
 * the job; neither is a chat unless he pins it (the user, 2026-09-29). The server
 * keeps them out of the bootstrap, but opening a run hydrates its thread here,
 * so the list has to know too. */
export function inChatList(thread: Thread): boolean {
  if (thread.kind === 'automation') return false;
  if (thread.kind === 'followup') return thread.pinned;
  return true;
}

export function selectThreadList(chat: ChatState): Thread[] {
  return Object.values(chat.threads)
    .map((t) => t.thread)
    .filter(inChatList)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0;
    });
}

// One shared empty array: a fresh `[]` per call would be a new reference every
// render for a thread the store has not hydrated yet — the same loop as above.
const NO_MESSAGES: ChatMessage[] = [];

export function selectMessages(threadId: string): (state: ChatStoreState) => ChatMessage[] {
  return (state) => state.chat.threads[threadId]?.messages ?? NO_MESSAGES;
}

export function selectThread(threadId: string): (state: ChatStoreState) => Thread | null {
  return (state) => state.chat.threads[threadId]?.thread ?? null;
}

/** Every open approval OR iMessage draft across every thread, flattened for a
 * single bottom card / badge count — `request_id`/`run_id` are guaranteed
 * non-null for kind='approval' by the server's own `AttentionSpec` validator
 * (chat/platform.py), so a row missing either is dropped rather than shown
 * with a broken sign-and-apply target. The iMessage draft kind rides the same
 * pipeline (chat/drafts.ts), so it is selected the same way; its `draft`
 * details come from the linked tool_call's args, leaving generic approvals
 * with `draft: null`. Offered choices fall back to once/deny, matching
 * chat/approval.py's `_DEFAULT_OFFERED_CHOICES` — this is the same fallback
 * the server itself applies when a delivered frame carries no explicit
 * `choices`, so the card never offers something the apply call would then 400
 * on. */
export function selectPendingApprovals(chat: ChatState): PendingApprovalView[] {
  const out: PendingApprovalView[] = [];
  for (const { thread, attention, messages } of Object.values(chat.threads)) {
    for (const item of attention) {
      const draftKind = isDraftAttentionKind(item.kind);
      if (item.kind !== 'approval' && !draftKind) continue;
      if (item.state !== 'open') continue;
      if (!item.request_id || !item.run_id) continue;
      const message = item.message_id ? messages.find((m) => m.id === item.message_id) : undefined;
      const toolCall = message?.parts.find(
        (p): p is ToolCallPart => p.type === 'tool_call' && p.state === 'approval_requested',
      );
      // The draft's own part may not be the open one — or the linked message may
      // not have synced yet — so recognise it by tool_name anywhere in the
      // message, and fall back to the open part. A draft-kind row with nothing
      // readable still renders as a draft (all-null details → summary), never as
      // a generic tool approval.
      const details = draftDetailsFromPart(message?.parts.find(isDraftToolCall)) ?? draftDetailsFromPart(toolCall);
      const draft: DraftApprovalDetails | null =
        draftKind || details ? details ?? { to: null, text: null, draft_id: null } : null;
      out.push({
        thread_id: thread.id,
        attention_id: item.id,
        request_id: item.request_id,
        run_id: item.run_id,
        message_id: item.message_id,
        summary: item.summary,
        choices: toolCall?.choices ?? ['once', 'deny'],
        expires_at_derived: item.expires_at_derived,
        draft,
      });
    }
  }
  return out;
}

/** Ids of attention rows this client already knows are resolved (answered or
 * dismissed) — `GET /chat/attention` lists only what the SERVER still holds
 * open, so a row answered from a thread moments ago is still in that list until
 * its next poll. The inbox filters those ids out so a draft (or any approval)
 * it just answered disappears at once rather than lingering red for a minute. */
export function selectAnsweredAttentionIds(chat: ChatState): Set<string> {
  const ids = new Set<string>();
  for (const { attention } of Object.values(chat.threads)) {
    for (const a of attention) if (a.state !== 'open') ids.add(a.id);
  }
  return ids;
}

export function selectDraft(threadId: string): (state: ChatStoreState) => string {
  return (state) => state.drafts[threadId] ?? '';
}

/** Whether a clarify question has been answered: chat/routes.py's clarify
 * route closes the thread's `question` attention row keyed by the clarify id,
 * and that `attention.upsert` lands here. A boolean, so safe to pass straight
 * to `useChatStore`. */
export function selectClarifyAnswered(
  threadId: string,
  clarifyId: string,
): (state: ChatStoreState) => boolean {
  return (state) =>
    (state.chat.threads[threadId]?.attention ?? []).some(
      (a) => a.kind === 'question' && a.request_id === clarifyId && a.state === 'answered',
    );
}

/** Thread ids carrying at least one OPEN attention row — every kind, not only
 * `approval` (selectPendingApprovals above is scoped to approvals because
 * that's the only kind with a signable card; this is the broader "does this
 * thread need a look" signal the thread list's Needs-you section groups on).
 * A fresh Set per call — derive it under useMemo, never pass it to useChatStore. */
export function selectNeedsYouThreadIds(chat: ChatState): Set<string> {
  const ids = new Set<string>();
  for (const { thread, attention } of Object.values(chat.threads)) {
    if (attention.some((a) => a.state === 'open')) ids.add(thread.id);
  }
  return ids;
}

/** How many threads are waiting on the user — the Chat tab's badge. A number, so
 * unlike the Set above it is safe to pass straight to `useChatStore`: the tab
 * bar lives in app/_layout.tsx, outside any screen that could useMemo it. */
export function selectNeedsYouCount(state: ChatStoreState): number {
  let count = 0;
  for (const { attention } of Object.values(state.chat.threads)) {
    if (attention.some((a) => a.state === 'open')) count += 1;
  }
  return count;
}
