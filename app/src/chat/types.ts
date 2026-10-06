// Hub chat wire + view types — derived from the ACTUAL hub-api contract
// (server/chat/{store,routes,ws,approval,platform}.py and the two
// test files), never from the design doc. Where the live server does not yet
// emit a shape (chat/ws.py names part.upsert / part.delta / thread.patch /
// run.status as frame types that "land automatically the day something
// upstream starts appending them to the event log", but nothing does yet),
// the payload shape below is this build's own forward-declared contract,
// flagged inline as [INFERRED]. Everything else is copied from a live route,
// a live schema column, or a live test fixture.
//
// This file is NOT part of the byte-locked ../lib/types.ts copy — chat wire
// types have no PWA twin to stay parity-checked against (scripts/check-shared-
// parity.mjs only ever compares lib/types.ts).

// --- parts (chat/store.py PART_TYPES) ---------------------------------------
// "Public part types" per store.py's own comment: SingleSelect/MultiSelect/
// Confirm were deleted from the v2 widget catalog in favour of native
// `clarify` (VERDICT-V2 §3), so there is no "approval" or "card" part type —
// an approval-in-flight is a `tool_call` part carrying `state:
// "approval_requested"` (test_chat_approval.py's `deliver_approval` fixture),
// and anything else visual is the catch-all `widget` type.
export type PartType = 'text' | 'reasoning' | 'image' | 'file' | 'tool_call' | 'widget';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ReasoningPart {
  type: 'reasoning';
  text: string;
}

export interface ImagePart {
  type: 'image';
  media_id?: string;
  url?: string;
  mime?: string;
  width?: number | null;
  height?: number | null;
}

export interface FilePart {
  type: 'file';
  name?: string;
  url?: string;
  mime?: string;
  /** The bytes hub-api holds, when it holds them. A file the agent could not
   * upload (too big, unreadable) arrives without one and only names its path. */
  media_id?: string;
  size_bytes?: number;
}

/** The choices T3 (chat/approval.py) will ever accept for one decision — the
 * server re-derives and constrains this itself; a client-side `choices` list
 * is display-only and is never trusted for anything else. */
export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny';

export type ToolCallStatus = 'running' | 'complete' | 'error';

export interface ToolCallPart {
  type: 'tool_call';
  // [INFERRED] tool_call_id/args/result/duration_ms/status/error: the shape
  // VERDICT-V2 §4.5 documents post_tool_call as delivering ("real tool_call_id,
  // args, result, duration_ms, status and error"), not yet emitted by any
  // route this build reads.
  tool_call_id?: string;
  tool_name?: string;
  args?: unknown;
  result?: unknown;
  duration_ms?: number | null;
  status?: ToolCallStatus;
  error?: string | null;
  // Live fixture shape (test_chat_approval.py `deliver_approval`): a tool call
  // awaiting a decision carries `state: "approval_requested"` and an optional
  // `choices` list that chat/approval.py's `_offered_choices` reads for
  // display (falling back to once/deny when absent — chat/approval.py's
  // `_DEFAULT_OFFERED_CHOICES`). `state` is open-ended: this build additionally
  // uses `"answered"` [INFERRED — no live event sets this] once the approval
  // resolves, see `ApprovalAnsweredFrame` below.
  state?: 'approval_requested' | 'answered' | string;
  choices?: ApprovalChoice[];
  /** A delegated task. The plugin's `subagent_start`/`subagent_stop` hooks send
   * the SAME `tool_call` part shape with this extra key
   * (the hub-platform plugin's `hub_wire.py` `subagent_message`),
   * so a delegation is a tool call that knows it is one. Present ⇒ the
   * transcript draws a subagent card instead of a tool row. */
  subagent?: {
    child_session_id?: string;
    child_role?: string;
    phase?: 'start' | 'stop' | string;
    tool_call_count?: number | null;
  };
  /** The choice this approval settled on. `'elsewhere'` is the honest value
   * when it was answered outside the Hub — a Discord button, a typed
   * /approve — where all the Hub ever learns is that the tool subsequently
   * ran. Rendering that as "Approved" would be a guess. */
  resolved_choice?: ApprovalChoice | 'elsewhere' | 'timeout' | 'withdrawn';
}

export interface WidgetPart {
  type: 'widget';
  widget_id?: string;
  kind?: string;
  [key: string]: unknown;
}

export type Part = TextPart | ReasoningPart | ImagePart | FilePart | ToolCallPart | WidgetPart;

// --- messages (chat/store.py `_message_row` / `insert_message`) -------------
export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageStatus = 'complete' | 'streaming' | 'error';

/** Only set on a human-typed send (chat/routes.py's `/send`) — null on every
 * agent/system row (chat/store.py's `messages.forward_status` column doc).
 * `'pending'` is the honest, expected value until phase 3 ships the hub
 * adapter's dispatch leg; `'forwarded'` is the day it does. Client-local rows
 * add two values no server route ever sets: `'sending'` (the optimistic echo,
 * before the POST resolves) and `'error'` (the POST failed in transit — never
 * a forward outcome, which is a distinct axis reported on `forward_status`). */
export type MessageStatusLocal = 'sending';

export interface ChatMessage {
  id: string;
  thread_id: string;
  seq: number;
  role: MessageRole | string;
  author_type: string;
  run_id: string | null;
  status: MessageStatus | MessageStatusLocal | string;
  client_msg_id: string | null;
  cron_run_id: string | null;
  created_at: string;
  updated_at: string;
  parts: Part[];
  /** [chat/store.py `messages.version`] The seq of the last event that touched
   * this row. A frame applies iff its seq is newer; a snapshot row replaces
   * this one iff its version is higher. 0 on a local row. */
  version: number;
  /** A delta arrived that this row's text is not the base of — something was
   * missed, or already applied. Nothing more is appended until the thread's
   * snapshot replaces the row (socket.ts asks for it). */
  stale?: boolean;
  /** [chat/store.py `messages.forward_status`] 'pending' | 'forwarded', or
   * absent/null for a row this route never set (every non-`/send` message).
   * Optional so every existing fixture/snapshot that predates `/send`
   * (bootstrap/detail reads, WS `message.upsert` frames — none of which carry
   * this column) still typechecks without it. */
  forward_status?: 'pending' | 'forwarded' | string | null;
  forward_reason?: string | null;
}

// --- threads (chat/routes.py `_thread_payload`) ------------------------------
export type ThreadKind = 'chat' | 'brief' | 'ops' | 'money' | 'cron' | 'followup' | 'automation';

export interface Thread {
  id: string;
  kind: ThreadKind | string;
  title: string | null;
  status: string;
  pinned: boolean;
  archived: boolean;
  last_seq: number;
  created_at: string;
  updated_at: string;
  last_read_seq: number;
  unread: number;
  /** The newest TEXT part said in the thread, collapsed to one bounded line
   * (chat/store.py's `_THREAD_SUMMARY_SELECT`), and the role that said it.
   * Null for a thread nothing has been said in. */
  preview: string | null;
  preview_role: MessageRole | string | null;
  /** The gateway session this thread is bound to (`threads.hermes_session_id`,
   * set on delivery) — the only handle the app has for asking `/api/sessions/{id}`
   * which model is answering in here. Null until the gateway has written once. */
  hermes_session_id: string | null;
  /** `threads.origin_thread_id` / `origin_message_id` — where this thread was
   * spun out of. Real columns, written by nothing yet: the row shows a
   * provenance pill when they are set and nothing when they are not. */
  origin_thread_id: string | null;
  origin_message_id: string | null;
  /** The scheduled-job run this thread is the follow-up to (`kind:
   * 'followup'`). Optional: a payload from before the column existed has none. */
  origin_run_id?: string | null;
  /** hub-api's own read of whether a turn is running here: something is
   * streaming, or the newest message is the user's and the gateway has taken it —
   * both within the last 30 minutes, so a turn the gateway abandoned does not
   * read as working forever (chat/store.py `_THREAD_SUMMARY_SELECT`). Optional
   * because a payload from before the field existed still has to render. */
  working?: boolean;
}

/** chat/routes.py's `POST /threads/{id}/patch` body — the thread menu's three
 * actions. Every field optional; the server rejects a body with none of them. */
export interface ThreadPatchInput {
  pinned?: boolean;
  archived?: boolean;
  title?: string;
}

// --- attention (chat/store.py `attention` table / AttentionSpec) ------------
export type AttentionKind =
  | 'approval'
  | 'question'
  | 'widget'
  | 'run_failed'
  | 'cron_alert'
  | 'mention'
  | 'stalled'
  | 'lease_timeout'
  // An iMessage draft awaiting send/discard (chat/drafts.ts). The server mirrors
  // it with `upsert_imessage_draft` (chat/store.py) as a row of this kind plus a
  // stored approval, so it is delivered through the SAME approval pipeline
  // (`request_id`/`run_id` name that stored approval, and /api/chat/approval/apply
  // answers it identically) — the kind only tells the UI to draw the draft
  // treatment instead of a generic tool approval.
  | 'imessage_draft';

/** `state` on the live schema is a free string defaulting 'open', with
 * `dismissed_at` as the only real transition this slice writes. `'answered'`
 * is a client-local addition (see `ApprovalAnsweredFrame`) — no server route
 * sets it. */
export type AttentionState = 'open' | 'answered' | 'dismissed';

export interface AttentionItem {
  id: string;
  thread_id: string;
  kind: AttentionKind | string;
  request_id: string | null;
  run_id: string | null;
  message_id: string | null;
  summary: string;
  state: AttentionState | string;
  expires_at_derived: string | null;
  created_at: string;
  dismissed_at: string | null;
}

// --- REST payloads (chat/routes.py) ------------------------------------------
export interface ChatBootstrapResponse {
  threads: Thread[];
}

export interface ChatThreadDetailResponse {
  thread: Thread;
  messages: ChatMessage[];
  /** The thread's open attention rows, shaped as `attention.upsert` carries
   * them. Optional: a hub-api from before 2026-09-30 does not send them. */
  attention?: Omit<AttentionUpsertFrame, 'type' | 'seq' | 'thread_id'>[];
}

export interface MarkReadResponse {
  thread_id: string;
  last_read_seq: number;
  unread: number;
}

/** One row of `GET /api/chat/attention` (chat/store.py `list_open_attention`) —
 * the cross-thread needs-you read. Not `AttentionItem`: that is the per-thread
 * row the socket and the thread payload carry, keyed for the approval it may
 * answer. This one is joined to its thread so the inbox can name where it came
 * from, and carries no `state` because every row here is open by definition. */
export interface AttentionInboxItem {
  id: string;
  thread_id: string;
  thread_title: string | null;
  thread_kind: string;
  kind: AttentionKind | string;
  summary: string;
  created_at: string;
  expires_at_derived: string | null;
}

export interface ChatAttentionResponse {
  attention: AttentionInboxItem[];
}

/** chat/routes.py's `/send` response — the same `ChatMessage` shape every
 * other read returns, plus `deduped`: true means `client_msg_id` matched an
 * existing row (a retry) and nothing new was inserted or forwarded. */
export interface ChatSendResponse {
  message: ChatMessage;
  deduped: boolean;
}

// --- approvals (chat/approval.py) --------------------------------------------
export interface ApprovalDecisionInput {
  run_id: string;
  request_id: string;
  choice: ApprovalChoice;
}

export interface ApprovalDecisionResult {
  request_id: string;
  run_id: string;
  status: 'answered' | 'already_answered';
  choice: ApprovalChoice;
}

export interface ApprovalApplyResponse {
  status: 'ok';
  decisions: ApprovalDecisionResult[];
}

// --- WebSocket wire (chat/ws.py) ---------------------------------------------
/** Client -> server. The only inbound message type the server recognises
 * (`handle_subscribe`); anything else is silently dropped. */
export interface SubscribeMessage {
  type: 'subscribe';
  thread_id: string;
  after_seq: number;
}

interface FrameBase {
  seq: number;
  thread_id: string;
}

/** Live: `_append_event` in `get_or_create_thread`. Fires once, at seq 0, the
 * first time a thread is created — a fresh subscribe from `after_seq: 0`
 * replays it. */
export interface ThreadCreateFrame extends FrameBase {
  type: 'thread.create';
  session_key: string;
  chat_type: string;
  kind: string;
  title: string | null;
}

/** Live: `_append_event` in `insert_message`. */
export interface MessageUpsertFrame extends FrameBase {
  type: 'message.upsert';
  message_id: string;
  role: string;
  author_type: string;
  status: string;
  run_id: string | null;
  parts: Part[];
  /** The row's own place in the thread. `seq` on the envelope is the EVENT's,
   * which is the row's new version; the two are equal only on the insert. */
  message_seq?: number;
  client_msg_id?: string | null;
  created_at?: string;
  updated_at?: string;
  version?: number;
}

/** [INFERRED] Named in chat/ws.py's docstring, not yet emitted: a full
 * replace-or-append of one part at `idx` on an existing message (a tool call
 * moving running -> complete, e.g.). */
export interface PartUpsertFrame extends FrameBase {
  type: 'part.upsert';
  message_id: string;
  idx: number;
  part: Part;
}

/** [INFERRED] Named in chat/ws.py's docstring, not yet emitted: an append-only
 * text delta onto the part at `idx` — "deltas append to the live part". */
export interface PartDeltaFrame extends FrameBase {
  type: 'part.delta';
  message_id: string;
  idx: number;
  delta: string;
  /** The part's text length before and after this delta, in UTF-16 units
   * (`.length`). A part that is not exactly `offset` long is not the text
   * this delta was cut from; the reducer marks the row stale rather than
   * append. Absent on events written before 2026-09-29. */
  offset?: number;
  length?: number;
}

/** Live: `_append_event` in `set_thread_title` (the namer and the re-titling
 * job) and in `patch_thread` (the thread menu's pin / rename / archive). The
 * changed fields ride FLAT in the envelope, not under a `patch` key — chat/ws.py's
 * `_event_frame` spreads an event's payload, the same as every other frame here. */
export interface ThreadPatchFrame
  extends FrameBase,
    Partial<Pick<Thread, 'title' | 'status' | 'pinned' | 'archived' | 'kind'>> {
  type: 'thread.patch';
}

/** Live: `_append_event` in `upsert_attention`. */
export interface AttentionUpsertFrame extends FrameBase {
  type: 'attention.upsert';
  attention_id: string;
  kind: AttentionKind | string;
  request_id: string | null;
  run_id: string | null;
  summary: string;
  message_id: string | null;
  /** The three the client cannot derive. Without `expires_at_derived` a
   * WS-delivered approval had no countdown until a refetch (gap A27); without
   * `state` a resolved row could never be closed live, so the tab badge stayed
   * lit until the app was reopened. Optional because a frame replayed from
   * before hub-api carried them still has to apply. */
  state?: AttentionState | string;
  expires_at_derived?: string | null;
  created_at?: string;
}

/** [INFERRED] Named in chat/ws.py's docstring, not yet emitted: a run-level
 * status change (e.g. surfacing "Worked for Ns" once a turn's tool calls stop). */
export interface RunStatusFrame extends FrameBase {
  type: 'run.status';
  run_id: string;
  status: string;
}

/** Live: connection-level, no seq/thread_id — chat/ws.py's `poll_loop` emits
 * this whenever a tick sends nothing else. */
export interface HeartbeatFrame {
  type: 'heartbeat';
}

/** Live: `handle_subscribe`'s gap check. The client must resync this thread
 * from the REST read routes rather than trust any further replay. */
export interface SnapshotRequiredFrame extends FrameBase {
  type: 'snapshot_required';
}

/** Live: `handle_subscribe` sends this once a subscribe's replay is complete.
 * `seq` is the thread's last seq as of that moment — the client is current.
 * The transcript ignores it; the socket client uses it to know a probe was
 * answered. */
export interface SyncedFrame extends FrameBase {
  type: 'synced';
}

/** NOT a server push. `/api/chat/approval/apply` resolves a decision over
 * plain REST (chat/approval.py) — this slice's WebSocket never broadcasts the
 * outcome (chat/store.py's `forward_status` stays 'pending' throughout). The
 * chat store feeds this synthetic frame into the SAME reducer right after a
 * successful apply, so the transcript and the attention list update through
 * one code path instead of two independently-maintained ones. */
export interface ApprovalAnsweredFrame {
  type: 'approval.answered';
  thread_id: string;
  run_id: string;
  request_id: string;
  choice: ApprovalChoice;
}

/** A row the server has withdrawn: the gateway streamed a reply the thread
 * already holds, so the duplicate is taken back rather than left standing
 * (chat/store.py `_delete_message`). The only frame that removes a message. */
export interface MessageDeleteFrame extends FrameBase {
  type: 'message.delete';
  message_id: string;
  version: number;
}

export type ChatFrame =
  | ThreadCreateFrame
  | MessageUpsertFrame
  | MessageDeleteFrame
  | PartUpsertFrame
  | PartDeltaFrame
  | ThreadPatchFrame
  | AttentionUpsertFrame
  | RunStatusFrame
  | HeartbeatFrame
  | SnapshotRequiredFrame
  | SyncedFrame
  | ApprovalAnsweredFrame;

// --- view types ---------------------------------------------------------------
/** The recipient / body / Mac draft id an iMessage draft approval names. Read
 * out of the linked tool_call part's `args` (chat/drafts.ts); every field is
 * nullable because the server's `args` shape is untyped `unknown` at the wire
 * boundary, and a missing half is left absent rather than invented. */
export interface DraftApprovalDetails {
  to: string | null;
  text: string | null;
  draft_id: number | null;
}

/** One open, unanswered approval, flattened for a bottom-pinned card — the
 * fields a card needs to render and to sign, nothing the server doesn't
 * already carry on the attention row + its linked tool_call part. */
export interface PendingApprovalView {
  thread_id: string;
  attention_id: string;
  request_id: string;
  run_id: string;
  message_id: string | null;
  summary: string;
  choices: ApprovalChoice[];
  expires_at_derived: string | null;
  /** Present when this approval is an iMessage draft (chat/drafts.ts). Null /
   * undefined for a generic tool approval, which is what picks DraftApprovalCard
   * over ApprovalCard. Details may be all-null when the part carried no readable
   * args — the card then falls back to `summary`. */
  draft?: DraftApprovalDetails | null;
}
