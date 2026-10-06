// Data-fetching glue between hub-api's REST reads and the chat store — the
// two places a chat screen gets state from besides the live socket. Neither
// hook touches the socket's connection lifecycle beyond subscribe(): the
// socket itself connects lazily (getChatSocket().connect() is a no-op while a
// socket is open or dialling — these effects re-run on every refetch, and
// before 2026-09-22 each one tore the live socket down mid-stream) and stays
// open for the app session, same as the query cache it sits beside.
import { useCallback, useEffect, useRef } from 'react';
import { ApiError, api, newClientMsgId } from '../lib/api';
import { usePoll } from '../lib/query';
import { useChatLock } from './lock';
import { LOCAL_ID_PREFIX } from './reducer';
import { getChatSocket } from './socket';
import { useChatStore } from './store';
import { loadTail, saveTail } from './cache';
import type {
  ChatAttentionResponse,
  ChatBootstrapResponse,
  ChatMessage,
  ChatThreadDetailResponse,
  TextPart,
} from './types';

/** Cold-start / pull-to-refresh: every thread's summary, hydrated into the
 * store, then RESUMED (not replayed) over the socket from each thread's own
 * `last_seq`. Resuming, not replaying from 0, is a deliberate scope cut for
 * the thread list: this screen shows every thread's live status the moment
 * something happens while it's open, but an approval or message that arrived
 * before this app session started won't retroactively appear here until
 * ThreadScreen's own full-replay subscribe (below) has been opened for that
 * thread at least once. A stuck "needs you" pill recovers by opening the
 * thread once — or by opening the attention inbox, which reads every open row
 * across every thread from `GET /chat/attention` (AttentionInbox.tsx). That
 * route deliberately does not feed this store: it answers "what is waiting on
 * me", it is not a second source of truth for thread state. */
/** A 401 from any chat read means the server-side session is gone while this
 * client still holds a valid unlock stamp — the cookie expires on its own hour,
 * and EVERY hub-api restart drops the in-process session table
 * (chat/session.py's `_CHAT_SESSIONS`). Without this the gate renders unlocked,
 * every read 401s, and the screen shows "Chat unavailable" with no way back to
 * Face ID at all (the user, 2026-09-22). Re-locking is what lock.ts's own doc
 * always claimed happened here. */
export function useRelockOn401(error: unknown): void {
  const lock = useChatLock((s) => s.lock);
  const fired = useRef(false);
  useEffect(() => {
    if (!(error instanceof ApiError) || error.status !== 401) {
      fired.current = false;
      return;
    }
    if (fired.current) return;
    fired.current = true;
    void lock();
  }, [error, lock]);
}

export function useChatBootstrap() {
  const hydrateSnapshot = useChatStore((s) => s.hydrateSnapshot);
  const reconcileAttention = useChatStore((s) => s.reconcileAttention);
  const query = usePoll<ChatBootstrapResponse>(['chat-bootstrap'], api.chatBootstrap);
  useRelockOn401(query.error);
  // What is waiting on the user, from the server, once a minute and on focus: the
  // Chat tab's badge is counted off attention rows, and a row whose resolving
  // frame never reached this client stayed open — and red — for as long as
  // the app lived (the user, 2026-09-29).
  const attention = usePoll<ChatAttentionResponse>(['chat-attention'], api.chatAttention, {
    refetchInterval: 60_000,
  });
  useEffect(() => {
    if (attention.data) reconcileAttention(attention.data.attention);
  }, [attention.data, reconcileAttention]);

  useEffect(() => {
    if (!query.data) return;
    const socket = getChatSocket();
    socket.connect();
    for (const thread of query.data.threads) {
      hydrateSnapshot(thread, []);
      // Only a thread the socket has never heard of. This effect re-runs on
      // every poll of the list, and re-subscribing from the list's own
      // last_seq asked the server to replay, every time, everything a thread
      // screen had already been sent.
      socket.subscribeIfNew(thread.id, thread.last_seq);
    }
  }, [query.data, hydrateSnapshot]);

  return query;
}

/** One thread's metadata + message history, hydrated into the store, then
 * subscribed from seq 0 — a full event-log replay, paid once per thread per
 * time it's opened. Unlike the list-level subscribe above, this is the only
 * path that can put an attention/approval row that predates this app session
 * INTO THE STORE (`GET /chat/attention` lists the open ones, but it is the
 * inbox's own read and never hydrates a thread — see chat/store.py's module
 * docstring: `events` is the sole record of the row's history, bounded by
 * `prune_events`'s 30-day retention). Idempotent either way: every frame this
 * replays for a message the REST read already delivered is a no-op merge
 * (reducer.ts upserts by id), so re-subscribing on every mount costs a poll
 * tick, not a duplicate. */
export function useThreadDetail(threadId: string) {
  const hydrateSnapshot = useChatStore((s) => s.hydrateSnapshot);
  const query = usePoll<ChatThreadDetailResponse>(
    ['chat-thread', threadId],
    () => api.chatThreadDetail(threadId),
    { enabled: threadId.length > 0, refetchInterval: false },
  );
  useRelockOn401(query.error);

  // Paint from the last visit while the snapshot is in flight. The server's
  // answer replaces it a moment later; until then the thread is readable
  // rather than empty (the user, 2026-09-24).
  useEffect(() => {
    let live = true;
    void loadTail(threadId).then((cached) => {
      if (!live || !cached) return;
      const { messages } = useChatStore.getState().chat.threads[threadId] ?? { messages: [] };
      if (messages.length === 0) hydrateSnapshot(cached.thread, cached.messages);
    });
    return () => {
      live = false;
    };
  }, [threadId, hydrateSnapshot]);

  useEffect(() => {
    if (!query.data) return;
    hydrateSnapshot(query.data.thread, query.data.messages);
    // What is waiting in this thread comes with the snapshot. The socket below
    // resumes from the snapshot's cursor, so an approval raised before the
    // thread was opened is never replayed: its card did not draw and it could
    // not be answered from the Hub (the user, 2026-09-30).
    const waiting = query.data.attention ?? [];
    if (waiting.length > 0) {
      useChatStore.getState().applyFrames(
        waiting.map((row) => ({ ...row, type: 'attention.upsert' as const, seq: 0, thread_id: threadId })),
      );
    }
    void saveTail(query.data.thread, query.data.messages);
    const socket = getChatSocket();
    socket.connect();
    // From the snapshot's own version, never from zero. Subscribing at 0
    // replayed every event since the thread began — thousands of intermediate
    // upserts and deltas, applied in order, on every open — which is what
    // "things pop up or lag at weird rates" was (the user, 2026-09-28). The
    // snapshot already IS the state at `last_seq`; only what lands after it is
    // news. This is the one deliberate lower ask: the socket may already have
    // sent further, and the server replays from here anyway — every row's
    // version gate makes what is already held a no-op, and a row the
    // reducer had marked stale is whole again.
    socket.subscribe(threadId, query.data.thread.last_seq);
  }, [query.data, hydrateSnapshot, threadId]);

  return query;
}

// --- sending a human-typed message -------------------------------------------
/** `id` a locally-originated message uses in the store before `/send`'s
 * response hands back the server's real one — namespaced so it can never
 * collide with a `msg_<hex>` id (chat/store.py's `insert_message`). */
function localMessageId(clientMsgId: string): string {
  return `${LOCAL_ID_PREFIX}${clientMsgId}`;
}

function buildLocalMessage(
  threadId: string,
  clientMsgId: string,
  text: string,
  status: 'sending' | 'error',
): ChatMessage {
  const now = new Date().toISOString();
  return {
    id: localMessageId(clientMsgId),
    thread_id: threadId,
    // Date.now() sorts after every real (small, monotonic-int) seq and after
    // an earlier optimistic echo from the same session — settles to the
    // server's real seq the moment reconciliation (below) replaces this row.
    seq: Date.now(),
    version: 0,
    role: 'user',
    author_type: 'human',
    run_id: null,
    status,
    client_msg_id: clientMsgId,
    cron_run_id: null,
    created_at: now,
    updated_at: now,
    parts: [{ type: 'text', text }],
  };
}

/** Dependency seam for `sendChatMessage` — the store setters and the HTTP
 * call, injected so the optimistic-echo-then-reconcile path (and the error
 * path) are testable without rendering `useSendMessage`'s hook. */
export interface SendChatMessageDeps {
  upsertLocalMessage: (threadId: string, message: ChatMessage) => void;
  removeLocalMessage: (threadId: string, messageId: string) => void;
  chatSend: (
    threadId: string,
    text: string,
    clientMsgId: string,
    mode?: 'queue' | 'steer' | 'redirect',
    mediaIds?: string[],
  ) => ReturnType<typeof api.chatSend>;
}

/** The composer's whole send path: echo immediately (it is the user's own words —
 * it must appear at once, forward leg or no), attempt the POST, and either
 * reconcile the echo with the real row `/send` returns or flip it to 'error'
 * so it can be retried with the SAME `clientMsgId` (see `retryPayload`).
 * Never throws — a failed send is recorded locally, not raised past this
 * function, the same "never lose it, never fake success" contract
 * chat/routes.py's `/send` itself keeps server-side. */
export async function sendChatMessage(
  deps: SendChatMessageDeps,
  threadId: string,
  text: string,
  clientMsgId: string,
  mode?: 'queue' | 'steer' | 'redirect',
  mediaIds?: string[],
): Promise<void> {
  const localId = localMessageId(clientMsgId);
  deps.upsertLocalMessage(threadId, buildLocalMessage(threadId, clientMsgId, text, 'sending'));
  try {
    // The mode and any attachments were accepted here and then dropped on the
    // way to the call, so the composer's chip could never reach the gateway
    // and Queue/Redirect did nothing at all (2026-09-23).
    const { message } = await deps.chatSend(threadId, text, clientMsgId, mode, mediaIds);
    deps.removeLocalMessage(threadId, localId);
    deps.upsertLocalMessage(threadId, message);
  } catch {
    deps.upsertLocalMessage(threadId, buildLocalMessage(threadId, clientMsgId, text, 'error'));
  }
}

/** What a retry resends: the SAME text and the SAME `client_msg_id` a failed
 * local message already carries — reusing it is what makes
 * `insert_message`'s dedup index protect a retry from double-sending, rather
 * than minting a second row. `null` for anything not retryable (no
 * client_msg_id, or no text part) — neither should happen for a message this
 * module itself created. */
export function retryPayload(message: ChatMessage): { text: string; clientMsgId: string } | null {
  if (!message.client_msg_id) return null;
  const part = message.parts.find((p): p is TextPart => p.type === 'text');
  if (!part) return null;
  return { text: part.text, clientMsgId: message.client_msg_id };
}

/** Composer wiring: `send` for a fresh message, `retry` for a failed local
 * one (ThreadScreen ties this to tapping a bubble whose `status === 'error'`).
 * Both funnel through `sendChatMessage` — retry is not a second code path,
 * only a different source for its `text`/`clientMsgId` arguments. */
export function useSendMessage(threadId: string) {
  const upsertLocalMessage = useChatStore((s) => s.upsertLocalMessage);
  const removeLocalMessage = useChatStore((s) => s.removeLocalMessage);

  const send = useCallback(
    (text: string, mode?: 'queue' | 'steer' | 'redirect', mediaIds?: string[]) =>
      sendChatMessage(
        { upsertLocalMessage, removeLocalMessage, chatSend: api.chatSend },
        threadId,
        text,
        newClientMsgId(),
        mode,
        mediaIds,
      ),
    [threadId, upsertLocalMessage, removeLocalMessage],
  );

  const retry = useCallback(
    (message: ChatMessage) => {
      const payload = retryPayload(message);
      if (!payload) return Promise.resolve();
      return sendChatMessage(
        { upsertLocalMessage, removeLocalMessage, chatSend: api.chatSend },
        threadId,
        payload.text,
        payload.clientMsgId,
      );
    },
    [threadId, upsertLocalMessage, removeLocalMessage],
  );

  return { send, retry };
}
