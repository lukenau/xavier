// PURE (state, frame) -> state. No Date.now(), no store import, no side
// effects, no I/O. wsClient.ts and store.ts are the only callers; they own
// timers, sockets and persistence — this file only ever folds one frame into
// the previous state and hands back the next one.
//
// Every case here is a real chat/ws.py frame type (see types.ts's per-frame
// doc comments for which are live today and which are [INFERRED] forward
// declarations) plus one client-synthesized case, `approval.answered` — see
// its type doc in types.ts for why it belongs in this same reducer rather
// than as separate, independently-maintained store state.
//
// Total: `default` returns the SAME state reference for anything this switch
// doesn't recognise, so an unknown frame type is a no-op, never a crash, and
// never a needless re-render for callers that compare by reference.
import type {
  AttentionInboxItem,
  AttentionItem,
  ChatFrame,
  ChatMessage,
  Part,
  Thread,
  ToolCallPart,
} from './types';
import { isDraftAttentionKind } from './drafts';

export interface ThreadState {
  thread: Thread;
  /** Ascending by `seq`. */
  messages: ChatMessage[];
  /** Open + resolved attention rows for this thread, newest first. */
  attention: AttentionItem[];
}

export interface ChatState {
  threads: Record<string, ThreadState>;
}

export const initialChatState: ChatState = { threads: {} };

const STUB_THREAD_TITLE = null;

/** Prefix of a row the server has never seen — the composer's optimistic echo
 * (hooks.ts `localMessageId`), which can never collide with a `msg_<hex>` id. */
export const LOCAL_ID_PREFIX = 'local:';

export function isLocalMessage(message: ChatMessage): boolean {
  return message.id.startsWith(LOCAL_ID_PREFIX);
}

/** A frame for a thread hub-api hasn't told this client about yet (REST
 * bootstrap races the socket, or a lazily-created thread's first event beats
 * the bootstrap refetch). Stubbed with the frame's own thread_id and sane
 * defaults; a later REST read (`mergeThreadSnapshot`) fills in the rest —
 * this must never throw for want of a `Thread` the caller hasn't fetched. */
function stubThread(threadId: string): Thread {
  return {
    id: threadId,
    kind: 'chat',
    title: STUB_THREAD_TITLE,
    status: 'idle',
    pinned: false,
    archived: false,
    last_seq: 0,
    created_at: '',
    updated_at: '',
    last_read_seq: 0,
    unread: 0,
    preview: null,
    preview_role: null,
    hermes_session_id: null,
    origin_thread_id: null,
    origin_message_id: null,
  };
}

function getOrCreateThreadState(state: ChatState, threadId: string): ThreadState {
  return state.threads[threadId] ?? { thread: stubThread(threadId), messages: [], attention: [] };
}

function withThread(state: ChatState, threadId: string, next: ThreadState): ChatState {
  return { threads: { ...state.threads, [threadId]: next } };
}

/** Ascending-seq insert/replace. Replacing an existing id (same `message.id`)
 * in place makes re-applying an identical `message.upsert` a true no-op
 * (deep-equal to the prior state) rather than a duplicate entry — the
 * idempotency guarantee comes from keying on `id`, not from tracking seen
 * seqs separately. A fresh insert is sorted by `seq` so a frame that arrives
 * out of order still lands in the right place instead of merely being
 * appended. */
/** Whether `next` is news for the row already held. The version is the seq of
 * the last event that touched the row on the server: equal means the same
 * state, and keeping the object keeps the row's identity so nothing
 * re-renders ("things move around in a flash", the user 2026-09-22). A field
 * comparison stood in for this once and could not tell two edits within the
 * same second apart. A stale row yields to anything said whole, and a local
 * row, never versioned, is always replaced. */
function newer(have: ChatMessage, next: ChatMessage): boolean {
  if (isLocalMessage(next) || have.stale) return true;
  return next.version > have.version;
}

function upsertMessage(messages: ChatMessage[], message: ChatMessage, force = false): ChatMessage[] {
  let idx = messages.findIndex((m) => m.id === message.id);
  if (idx === -1) {
    // The same slot under a different id. `id` is not stable across a server-side
    // rewrite of a row — a re-seeded demo box, a restored store, a rebuilt chat
    // DB all hand back the same conversation under fresh ids. Without this, the
    // cached row (`chat/cache.ts` hydrates the last screenful before the network
    // answers) would sit beside its own replacement and the same message would
    // print twice. `seq` is the server's per-thread ordering key and is unique
    // within a thread, so a snapshot row owns the seq it claims: replace, never
    // stack. Kept as a plain assignment (not `newer`) because a seq collision is
    // the same message by definition, whatever `version` either side carries.
    const sameSeq = messages.findIndex((m) => m.seq === message.seq);
    if (sameSeq !== -1) {
      const replaced = messages.slice();
      replaced[sameSeq] = message;
      return replaced;
    }
    const next = [...messages, message];
    next.sort((a, b) => a.seq - b.seq);
    return next;
  }
  if (messages[idx] === message || (!force && !newer(messages[idx], message))) return messages;
  const next = messages.slice();
  next[idx] = message;
  return next;
}

/** Same idempotency shape as `upsertMessage`, keyed on `attention_id` —
 * matches chat/store.py's own `upsert_attention`, which reuses one row per
 * (thread_id, kind, request_id) rather than inserting a fresh one each time. */
function upsertAttention(attention: AttentionItem[], item: AttentionItem): AttentionItem[] {
  const idx = attention.findIndex((a) => a.id === item.id);
  if (idx === -1) return [item, ...attention];
  if (attention[idx] === item) return attention;
  const next = attention.slice();
  next[idx] = item;
  return next;
}

function setPartAt(parts: Part[], idx: number, part: Part): Part[] {
  if (idx < 0 || idx > parts.length) return parts; // gap beyond the next append slot: ignore
  const next = parts.slice();
  next[idx] = part;
  return next;
}

/** Finds the message a request_id's attention row points at, and the index of
 * its still-open `tool_call` part (`state === 'approval_requested'`) — the
 * pairing `approval.answered` needs to resolve both the attention row and the
 * transcript's own tool_call in one frame. Absence of either half is not an
 * error: an approval whose card was answered before its tool_call ever
 * synced, or whose message hasn't arrived yet, just resolves the half that
 * exists. */
function findOpenApprovalPart(
  messages: ChatMessage[],
  messageId: string | null,
): { messageIdx: number; partIdx: number } | null {
  if (messageId === null) return null;
  const messageIdx = messages.findIndex((m) => m.id === messageId);
  if (messageIdx === -1) return null;
  const partIdx = messages[messageIdx].parts.findIndex(
    (p): p is ToolCallPart => p.type === 'tool_call' && p.state === 'approval_requested',
  );
  return partIdx === -1 ? null : { messageIdx, partIdx };
}

/** Anything arriving in a thread makes that thread the most recent one and
 * moves its cursor. Without this the list kept the ordering and the "3m ago" it
 * was bootstrapped with, however much arrived while it was open (the user,
 * 2026-09-22). `unread` is deliberately left alone — the server owns it, and
 * guessing here would drift from what a refetch says.  */
function touchThread(current: ThreadState, seq: number): ThreadState {
  if (!Number.isFinite(seq) || seq <= current.thread.last_seq) return current;
  return {
    ...current,
    thread: { ...current.thread, last_seq: seq, updated_at: new Date().toISOString() },
  };
}

export function chatReducer(state: ChatState, frame: ChatFrame): ChatState {
  switch (frame.type) {
    case 'thread.create': {
      const current = getOrCreateThreadState(state, frame.thread_id);
      return withThread(state, frame.thread_id, {
        ...current,
        thread: { ...current.thread, kind: frame.kind, title: frame.title },
      });
    }

    case 'message.delete': {
      const current = getOrCreateThreadState(state, frame.thread_id);
      // A row the server withdrew — the gateway re-streamed a reply this
      // thread already holds. A local row is never withdrawn by the server:
      // it has never seen one, so an id it does not know simply does not match.
      const messages = current.messages.filter((m) => m.id !== frame.message_id);
      if (messages.length === current.messages.length) return state;
      return withThread(state, frame.thread_id, { ...current, messages });
    }
    case 'message.upsert': {
      const current = getOrCreateThreadState(state, frame.thread_id);
      const existing = current.messages.find((m) => m.id === frame.message_id);
      // A replay, or older than what is held: the same state, so the same
      // reference. The one exception is a stale row, which takes anything
      // said whole.
      if (existing && !existing.stale && existing.version >= frame.seq) return state;
      // Merge onto the existing row, never rebuild it. The frame carries no
      // forward_status, so a fresh literal wiped what `/send` had set: the
      // indicator fell from "Working…" back to "Sent — waiting", and
      // `undelivered` became unreachable (2026-09-22).
      const message: ChatMessage = {
        client_msg_id: null,
        cron_run_id: null,
        created_at: '',
        updated_at: '',
        ...existing,
        id: frame.message_id,
        thread_id: frame.thread_id,
        // The envelope's seq is the event's. The row's place is its own, and
        // the two are equal only on the insert: taking the event's moved a
        // finished reply below every tool card that had landed since, until
        // a snapshot put it back.
        seq: frame.message_seq ?? existing?.seq ?? frame.seq,
        role: frame.role,
        author_type: frame.author_type,
        run_id: frame.run_id,
        status: frame.status,
        parts: frame.parts,
        version: frame.seq,
      };
      if (frame.created_at && !message.created_at) message.created_at = frame.created_at;
      if (frame.updated_at) message.updated_at = frame.updated_at;
      delete message.stale;
      const messages = upsertMessage(current.messages, message);
      if (existing && messages === current.messages) return state;
      // A row that moved (its place was only ever the event's seq before this
      // frame said otherwise) has to be re-sorted, not just replaced.
      const sorted = existing && existing.seq !== message.seq ? messages.slice().sort((a, b) => a.seq - b.seq) : messages;
      return withThread(state, frame.thread_id, touchThread({ ...current, messages: sorted }, frame.seq));
    }

    case 'part.upsert': {
      const current = getOrCreateThreadState(state, frame.thread_id);
      const msgIdx = current.messages.findIndex((m) => m.id === frame.message_id);
      if (msgIdx === -1) return state; // total: no message to attach this part to
      const message = current.messages[msgIdx];
      if (frame.seq <= message.version) return state;
      const parts = setPartAt(message.parts, frame.idx, frame.part);
      if (parts === message.parts) return state;
      const messages = current.messages.slice();
      messages[msgIdx] = { ...message, parts, version: frame.seq };
      return withThread(state, frame.thread_id, touchThread({ ...current, messages }, frame.seq));
    }

    case 'part.delta': {
      const current = getOrCreateThreadState(state, frame.thread_id);
      const msgIdx = current.messages.findIndex((m) => m.id === frame.message_id);
      if (msgIdx === -1) return state;
      const message = current.messages[msgIdx];
      if (frame.seq <= message.version) return state; // already in it, or older than it
      const part = message.parts[frame.idx];
      if (!part || (part.type !== 'text' && part.type !== 'reasoning')) return state;
      const grown = part.text + frame.delta;
      const messages = current.messages.slice();
      if (
        (typeof frame.offset === 'number' && part.text.length !== frame.offset) ||
        (typeof frame.length === 'number' && grown.length !== frame.length)
      ) {
        // Not the text this delta was cut from: something was missed, or
        // this is already in it. Appending would be a guess — the same words
        // twice, or a hole — so the row waits for the thread's snapshot.
        messages[msgIdx] = { ...message, stale: true };
        return withThread(state, frame.thread_id, touchThread({ ...current, messages }, frame.seq));
      }
      const parts = message.parts.slice();
      parts[frame.idx] = { ...part, text: grown };
      // A delta that fits is proof the text is whole again: same length as
      // the server's, so the same text. A row left stale after that kept
      // yielding to every snapshot and asking for more.
      const healed: ChatMessage = { ...message, parts, version: frame.seq };
      delete healed.stale;
      messages[msgIdx] = healed;
      return withThread(state, frame.thread_id, touchThread({ ...current, messages }, frame.seq));
    }

    case 'thread.patch': {
      const current = getOrCreateThreadState(state, frame.thread_id);
      const { type, seq, thread_id, ...patch } = frame;
      return withThread(state, frame.thread_id, {
        ...current,
        thread: { ...current.thread, ...patch },
      });
    }

    case 'attention.upsert': {
      const current = getOrCreateThreadState(state, frame.thread_id);
      const existing = current.attention.find((a) => a.id === frame.attention_id);
      const item: AttentionItem = {
        id: frame.attention_id,
        thread_id: frame.thread_id,
        kind: frame.kind,
        request_id: frame.request_id,
        run_id: frame.run_id,
        message_id: frame.message_id,
        summary: frame.summary,
        state: frame.state ?? existing?.state ?? 'open',
        expires_at_derived: frame.expires_at_derived ?? existing?.expires_at_derived ?? null,
        created_at: frame.created_at ?? existing?.created_at ?? '',
        dismissed_at: null,
      };
      return withThread(state, frame.thread_id, {
        ...current,
        attention: upsertAttention(current.attention, item),
      });
    }

    case 'run.status': {
      const current = getOrCreateThreadState(state, frame.thread_id);
      return withThread(state, frame.thread_id, {
        ...current,
        thread: { ...current.thread, status: frame.status },
      });
    }

    case 'approval.answered': {
      const current = state.threads[frame.thread_id];
      if (!current) return state; // nothing to resolve against
      const attentionIdx = current.attention.findIndex(
        (a) =>
          (a.kind === 'approval' || isDraftAttentionKind(a.kind)) &&
          a.request_id === frame.request_id &&
          a.run_id === frame.run_id,
      );
      const linkedMessageId = attentionIdx === -1 ? null : current.attention[attentionIdx].message_id;
      const target = findOpenApprovalPart(current.messages, linkedMessageId);

      if (attentionIdx === -1 && target === null) return state; // nothing found to resolve

      const attention =
        attentionIdx === -1
          ? current.attention
          : (() => {
              const next = current.attention.slice();
              next[attentionIdx] = { ...next[attentionIdx], state: 'answered' };
              return next;
            })();

      const messages =
        target === null
          ? current.messages
          : (() => {
              const message = current.messages[target.messageIdx];
              const part = message.parts[target.partIdx] as ToolCallPart;
              const parts = setPartAt(message.parts, target.partIdx, {
                ...part,
                state: 'answered',
                resolved_choice: frame.choice,
              });
              const next = current.messages.slice();
              next[target.messageIdx] = { ...message, parts };
              return next;
            })();

      return withThread(state, frame.thread_id, { ...current, attention, messages });
    }

    case 'snapshot_required': {
      const current = getOrCreateThreadState(state, frame.thread_id);
      // The event-log gap means neither the transcript nor the attention list
      // can be trusted to be contiguous from here — clear both and let the
      // REST read routes (chat/routes.py) repopulate via `mergeThreadSnapshot`.
      // `thread` metadata (pin/title/etc.) is left as last known, since it did
      // not come from the pruned event log.
      // Client-local rows survive: a failed send exists only here — the server
      // never saw it, no REST read can restore it, and ThreadScreen.onSend has
      // already cleared the draft, so wiping it lost the user's unsent words.
      return withThread(state, frame.thread_id, {
        ...current,
        messages: current.messages.filter(isLocalMessage),
        attention: [],
      });
    }

    case 'synced':
      return state; // a replay is complete — the socket client's business, not the transcript's

    case 'heartbeat':
      return state; // connection-level liveness signal only — no state to fold

    default:
      return state; // unknown frame type: ignored, never a crash
  }
}

/** Merges a REST snapshot (bootstrap's thread summaries, or one thread's
 * `/api/chat/threads/{id}` detail) into state. Not a `ChatFrame` case — this
 * is how `store.ts` folds in HTTP reads, which is a distinct data source from
 * the event log but must produce state shaped identically, so every selector
 * built against `ChatState` works regardless of which path populated it.
 * Same idempotent-upsert shape as the frame cases: safe to call repeatedly
 * with the same snapshot. */
export function mergeThreadSnapshot(state: ChatState, thread: Thread, messages: ChatMessage[]): ChatState {
  const current = getOrCreateThreadState(state, thread.id);
  const mergedMessages = messages.reduce((acc, m) => upsertMessage(acc, m), current.messages);
  return withThread(state, thread.id, { ...current, thread, messages: mergedMessages });
}

/** Server truth for what is waiting on the user — `GET /api/chat/attention` lists
 * every OPEN row across every thread. A row the store holds as open that the
 * server no longer does was resolved while this client was not listening:
 * the resolving frame is just another frame, a dead socket dropped it, and
 * the badge then counted the row for as long as the app lived ("always has
 * a red circle", the user 2026-09-29). A row the server has that the store lacks
 * is added, so the badge is right before any thread is opened; it carries no
 * request/run ids, and `selectPendingApprovals` leaves such a row out of the
 * signable card. */
export function reconcileOpenAttention(state: ChatState, open: AttentionInboxItem[]): ChatState {
  const openIds = new Set(open.map((row) => row.id));
  let threads = state.threads;
  for (const [threadId, current] of Object.entries(state.threads)) {
    if (!current.attention.some((a) => a.state === 'open' && !openIds.has(a.id))) continue;
    const attention = current.attention.map((a) =>
      a.state === 'open' && !openIds.has(a.id) ? { ...a, state: 'answered' } : a,
    );
    threads = { ...threads, [threadId]: { ...current, attention } };
  }
  for (const row of open) {
    const current = threads[row.thread_id] ?? { thread: stubThread(row.thread_id), messages: [], attention: [] };
    if (current.attention.some((a) => a.id === row.id)) continue;
    const item: AttentionItem = {
      id: row.id,
      thread_id: row.thread_id,
      kind: row.kind,
      request_id: null,
      run_id: null,
      message_id: null,
      summary: row.summary,
      state: 'open',
      expires_at_derived: row.expires_at_derived,
      created_at: row.created_at,
      dismissed_at: null,
    };
    threads = { ...threads, [row.thread_id]: { ...current, attention: upsertAttention(current.attention, item) } };
  }
  return threads === state.threads ? state : { threads };
}

/** Inserts or replaces one message directly, keyed by `id` — the SAME
 * idempotent upsert `chatReducer`'s `message.upsert` case and
 * `mergeThreadSnapshot` both use (`upsertMessage` above). This is the seam a
 * locally-originated message goes through: the composer's optimistic echo,
 * flipping it to 'error' on a failed send, and reconciling it with the real
 * row `/send`'s response returns — never a second, independently-maintained
 * path for client-authored messages. */
export function applyLocalMessage(state: ChatState, threadId: string, message: ChatMessage): ChatState {
  const current = getOrCreateThreadState(state, threadId);
  // Always taken, whatever version the row already holds: `/send`'s response
  // is the only carrier of forward_status, and the socket's own insert frame
  // for the same row — same version — usually lands first. Gating it lost the
  // status, and "Sent — waiting" never became "Working…".
  return withThread(state, threadId, { ...current, messages: upsertMessage(current.messages, message, true) });
}

/** Removes one message by id — used only once, to drop an optimistic
 * placeholder after `/send` hands back the real row under a different
 * (server-minted) id. Total: a miss is a same-reference no-op, matching every
 * other case in this file. */
export function discardLocalMessage(state: ChatState, threadId: string, messageId: string): ChatState {
  const current = state.threads[threadId];
  if (!current) return state;
  const messages = current.messages.filter((m) => m.id !== messageId);
  if (messages.length === current.messages.length) return state;
  return withThread(state, threadId, { ...current, messages });
}
