"""The Hub chat canonical store — SQLite, WAL, single writer.

Per VERDICT-V2 §4.2 (threads) and §0/§1 of v2-decision-reliability.md: hub-api is a thin
relay + local mirror. All turn state and approval state live in the `example-gateway`
process; this store is chat's own durable transcript (threads, messages, parts) plus a
per-thread event log for reconnect replay, and it is the SOLE seq allocator.

Single writer is load-bearing, same as the WebAuthn challenge cache
(webauthn_gate.py's `_ChallengeCache`, and the Dockerfile's own comment) — hub-api runs
one uvicorn worker, permanently (v2-decision-reliability.md §1). One `threading.RLock`
around every read AND write below is therefore sufficient: there is exactly one process,
and sync FastAPI handlers run in uvicorn's threadpool, so genuine interleaving across
requests is real even with one worker (same reasoning as devicekeys.py's `_store_lock`).

THREADS. One Hub thread = one Hermes session, keyed `agent:main:hub:<chat_type>:<thread_id>`
— `chat_type` and `thread_id` are HARDCODED into that key wherever it is built, never
recomputed from anything else, because a drift there silently forks the session
(VERDICT-V2 §4.2, v2-decision-security.md §3). The mapping is stored once, at creation,
in `threads.session_key` — nothing downstream reconstructs it. Threads are created
LAZILY (`get_or_create_thread`): no pre-seed, no re-bind. **Never** add an `end_reason`
column or write one — VERDICT-V2 is explicit that this forecloses the session's
post-restart recovery path, and the regression would not show up in any test that
doesn't restart the gateway.

IDEMPOTENCY. A cron delivery dedups on `(thread_id, cron_run_id)`; a client send
(chat/routes.py's `/send`) dedups on `(thread_id, client_msg_id)`. Both are enforced
as partial UNIQUE indexes on `messages`, not only as an application-level
check-then-insert — see `insert_message`.

THE EVENT LOG. `events` is the per-thread monotonic seq log a reconnecting client
replays from a cursor (`after_seq`). It is the fast path, not the sole record — the
durable transcript is `messages`/`parts`/`threads`/`attention`, so a client that has been
offline longer than the event-retention window (see `prune_events`) resyncs from a fresh
snapshot instead of replaying. This is what keeps chat.db's growth bounded on a box
already at 78% disk: the transcript itself is kept, but the delta log is not.

MEDIA. Bytes arrive as base64 in the JSON body (hub-api has neither `python-multipart`
nor Pillow — VERDICT-V2 §9, confirmed live) and are written under `media/<thread_id>/`.
There is deliberately no server-side image validation (a named limitation, not a gap to
silently patch around). Growth is bounded by a hard cap on total stored bytes
(`HUB_CHAT_MEDIA_MAX_BYTES`), checked before every write — see `chat/platform.py`.
"""
from __future__ import annotations

import json
import re
import secrets
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# Public "part" types (VERDICT.md §3.2 schema; SingleSelect/MultiSelect/Confirm were
# deleted from the v2 widget catalog in favour of native `clarify`, so they are not part
# types — `widget` covers whatever survives of the fenced-block convention instead).
PART_TYPES = frozenset({"text", "reasoning", "image", "file", "tool_call", "widget"})

# "The topic has shifted" is decided in two cheap stages (L50). Stage 1 is here and is
# pure SQL: a thread is worth LOOKING at once this many messages have landed since its
# title was last decided. Stage 2 — whether the name is actually wrong now — is the
# review job's judgement and costs an inference call, so this threshold is what keeps
# that call rare on a busy box.
TITLE_REVIEW_MIN_MESSAGES = 8
# What the job judges on: the tail of what was said since the title, never the
# transcript. Bounded so one read stays one small response however busy the thread.
TITLE_REVIEW_EXCERPTS = 6
TITLE_REVIEW_EXCERPT_CHARS = 240

_EXT_BY_MIME = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
}

_SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL UNIQUE,
    chat_type TEXT NOT NULL DEFAULT 'dm',
    hermes_session_id TEXT,
    kind TEXT NOT NULL DEFAULT 'chat',
    title TEXT,
    -- The seq the title was last decided at. Everything after it is what the thread
    -- has talked about SINCE it was named, which is the whole of "has the topic
    -- moved on" (`list_title_review_candidates`). 0 = never named.
    title_seq INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'idle',
    pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    -- the user's "finished with this thread" mark and the free-form bucket they file
    -- it under. Both are patch-route-only state: nothing server-side derives
    -- them (see patch_thread — no hidden auto-undone on a new message).
    done INTEGER NOT NULL DEFAULT 0,
    category TEXT,
    parent_thread_id TEXT REFERENCES threads(id),
    origin_thread_id TEXT,
    origin_message_id TEXT,
    last_seq INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Per-user read/attention state, split from `threads` (v1 §3.8: "hub-owned last_read_seq").
-- Single-user estate today (hub_user_id defaults 'user'), keyed so it is not a rewrite
-- to add a second user later.
CREATE TABLE IF NOT EXISTS thread_user_state (
    thread_id TEXT NOT NULL REFERENCES threads(id),
    hub_user_id TEXT NOT NULL DEFAULT 'user',
    last_read_seq INTEGER NOT NULL DEFAULT 0,
    unread INTEGER NOT NULL DEFAULT 0,
    snoozed_until TEXT,
    muted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (thread_id, hub_user_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    author_type TEXT NOT NULL,
    run_id TEXT,
    status TEXT NOT NULL DEFAULT 'complete',
    hermes_row_ids TEXT,
    client_msg_id TEXT,
    cron_run_id TEXT,
    -- Set only on a human-typed send (chat/routes.py's `/send`); left NULL on
    -- every agent/system row `/api/platform/hub/deliver` inserts, which IS the
    -- delivery, not something that itself needs forwarding anywhere. 'pending'
    -- with a short reason today (the hub adapter's inbound leg is Phase 1
    -- observer-only — see adapter.py), 'forwarded' once phase 3's dispatch
    -- succeeds. A separate axis from `status` above (streaming/complete/error
    -- on the DURABLE transcript) — whether the words reached a live turn at
    -- all, not whether they finished rendering.
    forward_status TEXT,
    forward_reason TEXT,
    -- The seq of the last event that touched this row. A client compares a
    -- frame's seq against it to know whether the frame is news; nothing else
    -- about the row (not updated_at, not the part count) can answer that.
    version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (thread_id, seq)
);
-- Idempotency, enforced in the schema (not only in app code): a retried delivery or
-- client send must not double-insert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_cron_dedup
    ON messages(thread_id, cron_run_id) WHERE cron_run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_dedup
    ON messages(thread_id, client_msg_id) WHERE client_msg_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL REFERENCES messages(id),
    idx INTEGER NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (message_id, idx)
);

-- The per-thread monotonic seq log. hub-api is the SOLE allocator (`_allocate_seq`);
-- every mutation that a connected client must see stamps one row here so a reconnect
-- can replay `WHERE thread_id=? AND seq > ?` instead of re-deriving state.
CREATE TABLE IF NOT EXISTS events (
    thread_id TEXT NOT NULL REFERENCES threads(id),
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);

-- Needs-you inbox rows (v1 §3.8). Never itself the record of an approval decision —
-- that's `approvals` below; this is what makes it show up in the inbox.
CREATE TABLE IF NOT EXISTS attention (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    kind TEXT NOT NULL,
    request_id TEXT,
    run_id TEXT,
    message_id TEXT,
    summary TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'open',
    expires_at_derived TEXT,
    created_at TEXT NOT NULL,
    dismissed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_attention_thread ON attention(thread_id, state);

-- Keyed (run_id, request_id) per v1 §3.4's design ("hub-api owns an approvals table
-- keyed (run_id, request_id) with the full frame, queue_pos, and an answered set").
-- `choice` is deliberately unconstrained here at the DB layer — T3 in VERDICT-V2 §7
-- requires the *server* to re-derive/constrain `choice` against the stored frame
-- before ever accepting one, which is `chat/approval.py`'s job (`answer_approval`
-- below), not this store's.
--
-- `answered` IS the local answered-set T3's §(d) requires: `answer_approval`'s CAS
-- (`WHERE answered=0`) makes a retry or double-tap on an already-answered row a no-op
-- read of what was already recorded, never a second write. `forward_status` exists so
-- an answered-but-not-yet-forwarded row is durably distinguishable — phase 3 (not this
-- slice) forwards to the gateway and flips it 'pending' -> 'forwarded'; nothing in this
-- slice ever sets it to anything but 'pending'.
CREATE TABLE IF NOT EXISTS approvals (
    request_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    queue_pos INTEGER NOT NULL DEFAULT 0,
    frame TEXT NOT NULL,
    choice TEXT,
    answered INTEGER NOT NULL DEFAULT 0,
    forward_status TEXT NOT NULL DEFAULT 'pending',
    forward_reason TEXT,
    created_at TEXT NOT NULL,
    answered_at TEXT,
    PRIMARY KEY (run_id, request_id)
);

-- iMessage drafts awaiting a human decision. hub-api's own record of a draft that
-- exists on the Mac (`POST /api/chat/imessage/draft` writes one the moment the Mac
-- returns a draft id). A draft travels the EXISTING chat approval pipeline so every
-- surface answers it the same way: `upsert_imessage_draft` puts a `tool_call` part
-- named `draft_imessage` (with `args` = to/text/draft_id) in the Hub thread, an
-- `attention` row of kind `imessage_draft`, and an `approvals` row keyed
-- (run_id, request_id) — the (run_id, request_id) pair below is that same pair, and
-- `answer_approval`'s `WHERE answered=0` CAS is the ONE first-answer-wins store the
-- Hub apply route, the Discord #approvals button and the web approval link all
-- share. `choice` mirrors the approvals choice (once|deny); `outcome` records what
-- the Mac then did with a send (sent|pending|unreachable|error|unconfirmed), so the
-- thread card states what really happened. Never written by the platform ingest
-- path — a draft originates hub-side, not from the gateway.
CREATE TABLE IF NOT EXISTS imessage_drafts (
    draft_id INTEGER PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    message_id TEXT,
    run_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    contact TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    choice TEXT,
    outcome TEXT,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    answered_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_imessage_drafts_request ON imessage_drafts(request_id);
CREATE INDEX IF NOT EXISTS idx_imessage_drafts_thread ON imessage_drafts(thread_id);

-- A widget's answer is committed to the gateway as plain user text (v1 §3.7 — the
-- gateway has no `display_kind`/`display_metadata` support on this path); the
-- structured values that plain text summarizes live here, joined by the gateway row id.
-- Not written by this slice (no widget tool yet) — the table exists so the schema is
-- right from the start rather than migrated later.
CREATE TABLE IF NOT EXISTS widget_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    message_id TEXT,
    widget_id TEXT NOT NULL,
    "values" TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    thread_id TEXT REFERENCES threads(id),
    mime TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    origin TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- Automations (chat/automation_store.py). A RUN is keyed "<job_id>:<run file stem>",
-- and the job id is the run file's directory name, so every run belongs to exactly
-- one job by construction — nothing here groups by thread, title or text.
CREATE TABLE IF NOT EXISTS automation_jobs (
    job_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    schedule TEXT,
    deliver TEXT,
    state TEXT NOT NULL DEFAULT 'active',
    mode TEXT NOT NULL DEFAULT 'agent',
    category TEXT NOT NULL DEFAULT 'ops',
    origin_thread_id TEXT,
    next_run_at TEXT,
    last_status TEXT,
    last_error TEXT,
    -- push | quiet (no push, still counts) | muted (no push, never counts)
    notify TEXT NOT NULL DEFAULT 'push',
    snoozed_until TEXT,
    -- Runs at or before this run_time are read.
    read_through TEXT,
    snoozed_at TEXT,
    snoozed_severity TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_runs (
    run_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    run_time TEXT NOT NULL,
    -- ok | silent | failed
    status TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    output TEXT NOT NULL DEFAULT '',
    truncated INTEGER NOT NULL DEFAULT 0,
    fingerprint TEXT NOT NULL DEFAULT '',
    unchanged INTEGER NOT NULL DEFAULT 0,
    new_lines INTEGER NOT NULL DEFAULT 0,
    streak INTEGER NOT NULL DEFAULT 1,
    streak_since TEXT,
    -- file | delivery | backfill
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_job ON automation_runs(job_id, run_time);
CREATE INDEX IF NOT EXISTS idx_automation_runs_time ON automation_runs(run_time);
"""

# Thread kinds that never appear in the Chat list: a per-job delivery thread is
# read through Automations, and a run's follow-up lives under its run unless
# the user pins it. The four catch-all kinds drop out once every row in them is
# attributed to a job — a row nothing has claimed keeps its thread visible, so
# nothing becomes unreachable by being hidden.
LEGACY_DELIVERY_KINDS = ("brief", "ops", "money", "cron")
_CHAT_LIST_FILTER = (
    "WHERE t.kind != 'automation' "
    "AND (t.kind != 'followup' OR t.pinned = 1) "
    "AND (t.kind NOT IN ('brief','ops','money','cron') OR EXISTS ("
    "SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.job_id IS NULL)) "
)


# One thread summary: the row plus this user's cursor, unread, and the last
# thing said in it. The preview is the newest TEXT part in the thread — a
# thread whose last message is an image or a tool card previews the last words
# instead of nothing. Two subqueries rather than one because SQLite scalar
# subqueries return a single column, and both halves must come from the same
# (newest text part) row: identical ORDER BY, so they always do.
#
# `unread` COUNTS MESSAGES past the cursor rather than subtracting seqs. Not
# every seq is a message: a `thread.patch` (a rename, a pin) allocates one too,
# so the arithmetic version reported "1 new" for a thread nobody had said
# anything in since it was read.
_THREAD_SUMMARY_SELECT = (
    "SELECT t.*, COALESCE(s.last_read_seq, 0) AS last_read_seq, "
    "(SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id "
    "AND m.seq > COALESCE(s.last_read_seq, 0)) AS unread, "
    "(SELECT p.data FROM messages m JOIN parts p ON p.message_id = m.id "
    "WHERE m.thread_id = t.id AND p.type = 'text' ORDER BY m.seq DESC, p.idx LIMIT 1) AS preview_data, "
    "(SELECT m.role FROM messages m JOIN parts p ON p.message_id = m.id "
    "WHERE m.thread_id = t.id AND p.type = 'text' ORDER BY m.seq DESC, p.idx LIMIT 1) AS preview_role, "
    # Is a turn running in this thread right now? Either something is still
    # streaming, or the newest message is the user's and the gateway has taken it.
    # Both are bounded by WORKING_WINDOW: a turn the gateway died in the middle
    # of leaves a row marked streaming forever, and without the bound the list
    # would show that thread as working for good. A live streaming row's
    # updated_at moves on every delta, so a real turn stays inside the window.
    # The first of these is the turn itself (`begin_run`/`end_run`); the other
    # two are the older row-shaped guesses, kept for a thread whose turn began
    # before this column existed.
    "(CASE WHEN (t.status = 'running' AND t.updated_at > ?) "
    "OR EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id "
    "AND m.status = 'streaming' AND m.updated_at > ?) "
    "OR EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id "
    "AND m.seq = (SELECT MAX(m2.seq) FROM messages m2 WHERE m2.thread_id = t.id) "
    "AND m.role = 'user' AND m.forward_status = 'forwarded' AND m.created_at > ?) "
    "THEN 1 ELSE 0 END) AS working "
    "FROM threads t LEFT JOIN thread_user_state s "
    "ON s.thread_id = t.id AND s.hub_user_id = ? "
)

PREVIEW_MAX_LEN = 140
WORKING_WINDOW = timedelta(minutes=30)


def _working_cutoff() -> str:
    return (datetime.now(timezone.utc) - WORKING_WINDOW).strftime("%Y-%m-%dT%H:%M:%SZ")


def _thread_summary_row(row: sqlite3.Row) -> dict[str, Any]:
    """`preview_data` (one stored part's JSON) collapsed to the one line a thread
    row shows; `preview_role` is left as-is so the client can mark the user's own
    words as his."""
    out = dict(row)
    out["working"] = bool(out.get("working"))
    raw = out.pop("preview_data", None)
    # A part's text is agent-written and not type-checked on ingest; a non-string
    # there must not take the whole thread list down with it.
    value = json.loads(raw).get("text") if raw else None
    text = " ".join(value.split()) if isinstance(value, str) else ""
    if len(text) > PREVIEW_MAX_LEN:
        text = text[: PREVIEW_MAX_LEN - 1] + "…"
    out["preview"] = text or None
    if not text:
        out["preview_role"] = None
    return out


# A stream that has got stuck repeating one character. Real prose never runs a
# single character this far — the longest legitimate run in a reasoning trace is
# a rule or an ellipsis, an order of magnitude shorter. Whitespace is excluded:
# a long indent or a run of blank lines is ordinary formatting.
_DEGENERATE_RUN = 48
_DEGENERATE_RE = re.compile(r"(\S)\1{" + str(_DEGENERATE_RUN - 1) + r",}")


def _is_degenerate_tail(text: str) -> bool:
    if len(text) < _DEGENERATE_RUN:
        return False
    tail = text[-_DEGENERATE_RUN:]
    first = tail[0]
    return not first.isspace() and tail == first * _DEGENERATE_RUN


def _collapse_degenerate_runs(text: str) -> str:
    """Shorten every run of one repeated character down to something readable.

    The plugin now merges the stream deltas already queued behind each other, so
    a single delta can carry a whole stuck stream rather than one character of
    it. Refusing the delta outright would then throw away any real text sharing
    that post, so the run is cut and the rest kept."""
    return _DEGENERATE_RE.sub(lambda m: m.group(1) * 8, text)


def _attention_payload(row: Any) -> dict[str, Any]:
    """The frame an `attention.upsert` carries.

    `state` and `expires_at_derived` are on it because the client cannot derive
    either: without the expiry a WS-delivered approval had no countdown until a
    refetch (gap A27), and without the state a resolved row could never be
    closed live.
    """
    return {
        "attention_id": row["id"],
        "kind": row["kind"],
        "request_id": row["request_id"],
        "run_id": row["run_id"],
        "summary": row["summary"],
        "message_id": row["message_id"],
        "state": row["state"],
        "expires_at_derived": row["expires_at_derived"],
        "created_at": row["created_at"],
    }


# The attention kind a Hub-visible iMessage draft's needs-you row carries. Its
# `request_id` is `_imessage_draft_request_id(draft_id)`, so one open row keys each
# draft and the same pair names its `approvals` row.
ATTENTION_KIND_IMESSAGE_DRAFT = "imessage_draft"
# The (archived, message-free) thread id an AUTOMATION's draft anchors its
# schema-required thread reference to — never surfaced as a conversation.
ATTENTION_THREAD_ANCHOR = "_imessage_automation"


def _imessage_draft_request_id(draft_id: int) -> str:
    """The (run_id, request_id) pair a draft's approval is keyed on — and the
    `tool_call_id` on its thread part. One draft, one str, so every surface can
    address the same stored approval."""
    return f"imessage_draft_{draft_id}"


def _imessage_draft_status(row: Any) -> str:
    """One line for the draft's thread card and its inbox summary, from the
    choice/outcome the row actually holds. Never claims a send the Mac did not
    confirm — an unrecognised Mac reply reads as 'not confirmed sent'."""
    choice, outcome = row["choice"], row["outcome"]
    if choice is None:
        return "waiting for your approval"
    if choice == "deny":
        return "denied — not sent"
    return {
        None: "approved — sending",
        "sent": "sent",
        "pending": "the Mac is still holding it for approval there",
        "unreachable": "not sent — the Mac was unreachable",
        "error": "not sent — the Mac refused it",
        "unconfirmed": "not confirmed sent",
        "denied": "denied — not sent",
    }.get(outcome, "not confirmed sent")


def _imessage_draft_parts(row: Any) -> list[dict[str, Any]]:
    """The thread message that surfaces one draft: a text line any client shows,
    plus the `tool_call` part the chat approval pipeline reads — `tool_name`
    `draft_imessage` with `args` = to/text/draft_id, `choices` once/deny (send /
    discard), and a `state` that flips to `answered` the moment the decision lands.
    `DraftApprovalCard`/chat/drafts.ts match the part by `tool_name`; the generic
    `_resolve_approval_part` matches it by `tool_call_id` = request_id."""
    contact = str(row["contact"] or "")
    body = str(row["text"] or "")
    preview = body[:160] + ("…" if len(body) > 160 else "")
    status = _imessage_draft_status(row)
    to_line = f"to {contact}" if contact else "iMessage"
    decided = row["choice"] is not None
    tool_call: dict[str, Any] = {
        "type": "tool_call",
        "tool_name": "draft_imessage",
        "tool_call_id": str(row["request_id"]),
        "state": "answered" if decided else "approval_requested",
        "status": "complete" if decided else "running",
        "choices": ["once", "deny"],
        "args": {"to": contact, "text": body, "draft_id": row["draft_id"]},
    }
    if decided:
        tool_call["resolved_choice"] = row["choice"]
    return [
        {"type": "text", "text": f"iMessage draft #{row['draft_id']} {to_line}: {preview} — {status}"},
        tool_call,
    ]


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _expiry_passed(value: str, now: str) -> bool:
    """True when an attention row's `expires_at_derived` is in the past. ISO
    timestamps of the same shape compare as strings, but a value written in any
    other format must be PARSED, not guessed: an unparseable expiry never
    expires rather than expiring everything."""
    if not value:
        return False
    if len(value) == len(now) and value[-1] == "Z" == now[-1]:
        return value <= now
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")) <= datetime.now(timezone.utc)
    except ValueError:
        return False


def _utf16_len(text: str) -> int:
    """The length the app's `.length` reports. JS counts UTF-16 units and Python
    counts code points; one emoji makes them disagree, and a delta's offset has
    to be in the client's units or every reply with an emoji in it goes stale."""
    # A lone surrogate is one unit to JS and an encode error to Python.
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


_WS_RE = re.compile(r"\s+")


def _same_reply(had: str, text: str) -> bool:
    """Two tellings of one reply, or two replies?

    One is a prefix of the other (the interim final and the true final), or the
    longer contains nearly every line of the shorter (a streamed copy with a
    hole in the middle). Anything else is a second message and keeps its row.

    Whitespace is not identity. The streamed copy of a reply on 2026-09-30 was
    the delivered one minus six characters — three paragraph breaks the stream
    never carried — and the sentence pieces then matched nothing, so the reply
    landed a second time and the user saw it twice.
    """
    a, b = had.strip(), text.strip()
    if not a or not b:
        return False
    # Every comparison below is made on the words alone. The difference was
    # not different whitespace but MISSING whitespace, which collapsing cannot
    # put back.
    bare_a, bare_b = _WS_RE.sub("", a), _WS_RE.sub("", b)
    if bare_a.startswith(bare_b) or bare_b.startswith(bare_a):
        return True
    shorter, longer = (a, b) if len(bare_a) <= len(bare_b) else (b, a)
    bare_longer = _WS_RE.sub("", longer)
    # Sentences, not lines: a hole can sit inside one paragraph as easily as
    # between two.
    pieces = [_WS_RE.sub("", pc) for pc in re.split(r"(?<=[.!?])\s+|\n+", shorter)]
    pieces = [pc for pc in pieces if len(pc) >= 12]
    if not pieces:
        return False
    found = sum(1 for pc in pieces if pc in bare_longer)
    return found / len(pieces) >= 0.9



class ChatStore:
    """One instance per process (a lazy singleton in chat/platform.py); tests construct
    their own against a tmpdir path, same idiom as `devicekeys.DEVICEKEYS_JSON`."""

    def __init__(self, db_path: Path | str, media_dir: Path | str | None = None):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        # Unlike devicekeys.json (public keys — 0600 buys nothing on read, see its own
        # comment), chat.db IS the conversation transcript: message text, approval
        # frames, attention summaries. sqlite3.connect() creates it at the umask default
        # (0644 observed), which the media file below deliberately does NOT get away
        # with (chmod 0640). Lock the containing dir instead of every file in it — chmod
        # is idempotent so this also self-heals a pre-existing world-readable dir on
        # every process start.
        self.db_path.parent.chmod(0o700)
        self.media_dir = Path(media_dir) if media_dir else self.db_path.parent / "media"
        self._lock = threading.RLock()
        # check_same_thread=False: uvicorn's threadpool means different requests land on
        # different threads even with one worker process; `_lock` is what actually
        # serializes access, matching the single-writer contract the Dockerfile documents.
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._migrate()
            self._conn.commit()

    def _migrate(self) -> None:
        """`CREATE TABLE IF NOT EXISTS` never reshapes a table that already exists, so a
        column added after chat.db went live has to be ALTERed in. Idempotent; an
        existing thread lands on `title_seq` 0, which reads as "never reviewed" and is
        exactly right — nothing named before this column existed has been."""
        cols = {r["name"] for r in self._conn.execute("PRAGMA table_info(threads)").fetchall()}
        if "title_seq" not in cols:
            self._conn.execute("ALTER TABLE threads ADD COLUMN title_seq INTEGER NOT NULL DEFAULT 0")
        if "done" not in cols:
            # Existing threads land on done=0 (not finished) and category NULL
            # (unfiled), which is exactly what a thread patched before these
            # columns existed means.
            self._conn.execute("ALTER TABLE threads ADD COLUMN done INTEGER NOT NULL DEFAULT 0")
            self._conn.execute("ALTER TABLE threads ADD COLUMN category TEXT")
        tcols = {r["name"] for r in self._conn.execute("PRAGMA table_info(threads)").fetchall()}
        if "active_run_id" not in tcols:
            self._conn.execute("ALTER TABLE threads ADD COLUMN active_run_id TEXT")
        mcols = {r["name"] for r in self._conn.execute("PRAGMA table_info(messages)").fetchall()}
        if "origin_run_id" not in cols:
            self._conn.execute("ALTER TABLE threads ADD COLUMN origin_run_id TEXT")
        if "job_id" not in mcols:
            self._conn.execute("ALTER TABLE messages ADD COLUMN job_id TEXT")
            self._conn.execute("ALTER TABLE messages ADD COLUMN job_run_id TEXT")
        self._conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_job_run ON messages(job_run_id)")
        jcols = {r["name"] for r in self._conn.execute("PRAGMA table_info(automation_jobs)").fetchall()}
        rcols = {r["name"] for r in self._conn.execute("PRAGMA table_info(automation_runs)").fetchall()}
        if "streak" not in rcols:
            self._conn.execute("ALTER TABLE automation_runs ADD COLUMN streak INTEGER NOT NULL DEFAULT 1")
            self._conn.execute("ALTER TABLE automation_runs ADD COLUMN streak_since TEXT")
        if "snoozed_at" not in jcols:
            self._conn.execute("ALTER TABLE automation_jobs ADD COLUMN snoozed_at TEXT")
            self._conn.execute("ALTER TABLE automation_jobs ADD COLUMN snoozed_severity TEXT")
        self._conn.execute("CREATE INDEX IF NOT EXISTS idx_threads_origin_run ON threads(origin_run_id)")
        if "version" not in mcols:
            self._conn.execute("ALTER TABLE messages ADD COLUMN version INTEGER NOT NULL DEFAULT 0")
        # The ALTER commits on its own; a backfill that died after it left rows at
        # the column default. Keyed on that, not on the column's presence, so a
        # second start finishes the job.
        if self._conn.execute("SELECT 1 FROM messages WHERE version = 0 LIMIT 1").fetchone() is not None:
            self._conn.execute("UPDATE messages SET version = seq WHERE version = 0")
            # The log already knows every row's true version: the highest seq
            # of any event that named it. One pass over the log, in Python —
            # a correlated json_extract per message took 4.5s on the live db.
            latest: dict[str, int] = {}
            for row in self._conn.execute("SELECT seq, payload FROM events WHERE type IN ('message.upsert', 'part.delta', 'part.upsert')"):
                try:
                    message_id = json.loads(row["payload"]).get("message_id")
                except (ValueError, AttributeError):
                    continue
                if isinstance(message_id, str) and row["seq"] > latest.get(message_id, 0):
                    latest[message_id] = int(row["seq"])
            self._conn.executemany(
                "UPDATE messages SET version=? WHERE id=? AND version < ?",
                [(seq, message_id, seq) for message_id, seq in latest.items()],
            )

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # -- threads --------------------------------------------------------------
    def get_thread(self, thread_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM threads WHERE id=?", (thread_id,)).fetchone()
            return dict(row) if row else None

    def get_or_create_thread(
        self, thread_id: str, *, chat_type: str = "dm", kind: str = "chat", title: str | None = None,
        origin_run_id: str | None = None,
    ) -> dict[str, Any]:
        """Lazy creation on the normal adapter path — no pre-seed, no re-bind (VERDICT-V2
        §4.2). `session_key` is computed exactly once, here, and never recomputed."""
        with self._lock:
            existing = self.get_thread(thread_id)
            if existing:
                return existing
            now = _now_iso()
            session_key = f"agent:main:hub:{chat_type}:{thread_id}"
            try:
                self._conn.execute(
                    "INSERT INTO threads (id, session_key, chat_type, kind, title, status, "
                    "pinned, archived, last_seq, origin_run_id, created_at, updated_at) "
                    "VALUES (?,?,?,?,?,?,0,0,0,?,?,?)",
                    (thread_id, session_key, chat_type, kind, title, "idle", origin_run_id, now, now),
                )
                self._append_event(
                    thread_id, 0, "thread.create",
                    {"thread_id": thread_id, "session_key": session_key, "chat_type": chat_type,
                     "kind": kind, "title": title},
                    now,
                )
                self._conn.commit()
            except sqlite3.IntegrityError:
                # Lost a create race to a concurrent caller (defense in depth — `_lock`
                # already serializes this in-process). Fall through to the winner's row.
                self._conn.rollback()
            return self.get_thread(thread_id)  # type: ignore[return-value]

    def set_thread_title(self, thread_id: str, title: str, *, overwrite: bool = False) -> dict[str, Any] | None:
        """Name a thread. Default is fill-only: a thread named by the gateway
        (brief/ops/money/cron) or by its own first message is never clobbered by the
        next `/send` (chat/routes.py's `_auto_title` relies on exactly this). Emits
        `thread.patch` so an open client re-titles the row without a refetch.

        `overwrite=True` is the re-titling path (`POST /api/platform/hub/title`): it
        replaces an existing name, and it stamps `title_seq` EVEN WHEN THE NAME IS
        UNCHANGED. That second half is what keeps the review job from spinning — a
        job that looks at a thread and concludes the title still fits reaffirms it,
        the review cursor moves to now, and the thread drops out of
        `list_title_review_candidates` until another `min_messages` arrive. An
        unchanged name emits no event: nothing client-visible changed."""
        with self._lock:
            row = self.get_thread(thread_id)
            if row is None or ((row["title"] or "").strip() and not overwrite):
                return row
            if title == row["title"]:
                self._conn.execute("UPDATE threads SET title_seq=last_seq WHERE id=?", (thread_id,))
                self._conn.commit()
                return self.get_thread(thread_id)
            now = _now_iso()
            self._conn.execute("UPDATE threads SET title=?, updated_at=? WHERE id=?", (title, now, thread_id))
            seq = self._allocate_seq(thread_id)
            self._conn.execute("UPDATE threads SET title_seq=? WHERE id=?", (seq, thread_id))
            self._append_event(thread_id, seq, "thread.patch", {"title": title}, now)
            self._conn.commit()
            return self.get_thread(thread_id)

    def set_hermes_session_id(self, thread_id: str, hermes_session_id: str) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE threads SET hermes_session_id=?, updated_at=? WHERE id=?",
                (hermes_session_id, _now_iso(), thread_id),
            )
            self._conn.commit()

    def list_threads(self, *, hub_user_id: str = "user") -> list[dict[str, Any]]:
        """Thread summaries for the app's cold-start bootstrap and the Threads-tab list
        (chat/routes.py) — the same query backs both today. `unread` is computed live
        as `last_seq - last_read_seq`, never read from the stored
        `thread_user_state.unread` column, which is reserved for a different,
        not-yet-built purpose (see `mark_read`). Pinned first, then most-recently-active."""
        with self._lock:
            rows = self._conn.execute(
                _THREAD_SUMMARY_SELECT + _CHAT_LIST_FILTER + "ORDER BY t.pinned DESC, t.updated_at DESC",
                (_working_cutoff(), _working_cutoff(), _working_cutoff(), hub_user_id),
            ).fetchall()
            return [_thread_summary_row(r) for r in rows]

    def get_thread_summary(self, thread_id: str, *, hub_user_id: str = "user") -> dict[str, Any] | None:
        """One thread in the SAME shape `list_threads` returns — cursor, unread and
        preview included. The single-thread reads use this rather than `get_thread`
        so a thread never loses its preview on the way back from a detail or patch
        read and then renders bare in the list."""
        with self._lock:
            row = self._conn.execute(
                _THREAD_SUMMARY_SELECT + "WHERE t.id = ?", (_working_cutoff(), _working_cutoff(), _working_cutoff(), hub_user_id, thread_id)
            ).fetchone()
            return _thread_summary_row(row) if row else None

    def patch_thread(
        self,
        thread_id: str,
        *,
        pinned: bool | None = None,
        archived: bool | None = None,
        title: str | None = None,
        done: bool | None = None,
        category: str | None = None,
        hub_user_id: str = "user",
    ) -> dict[str, Any] | None:
        """Pin / archive / rename / mark-done / file from the app's thread menu. A rename here
        OVERWRITES, unlike `set_thread_title`, which only ever fills a NULL title:
        that one is the auto-namer guessing, this one is the user saying. Emits
        `thread.patch` carrying exactly the keys that changed, so another open
        client folds it without a refetch. `None` for an unknown thread — never
        lazily created, same rule as every other non-ingest path.

        `done` behaves like pinned/archived: flipped only when different, no
        hidden auto-clear when a new message lands in a done thread (a patch is
        pure — anything else belongs to an explicit decision, not this store).

        `category` is free-form, supplied by the app. `None` means no change;
        `""` means CLEAR it (empty string is the only way to express that — a
        nullable field can't take a sentinel bool)."""
        with self._lock:
            row = self.get_thread(thread_id)
            if row is None:
                return None
            patch: dict[str, Any] = {}
            if pinned is not None and bool(row["pinned"]) != pinned:
                patch["pinned"] = pinned
            if archived is not None and bool(row["archived"]) != archived:
                patch["archived"] = archived
            if title is not None and (row["title"] or "") != title:
                patch["title"] = title
            if done is not None and bool(row["done"]) != done:
                patch["done"] = done
            if category is not None and (row["category"] or None) != (category or None):
                # "" clears; a non-empty value replaces. Store NULL, not "", so
                # an unfiled thread is unfiled in every reading.
                patch["category"] = category or None
            if not patch:
                return self.get_thread_summary(thread_id, hub_user_id=hub_user_id)
            now = _now_iso()
            assignments = ", ".join(f"{key}=?" for key in patch)
            values = [int(v) if isinstance(v, bool) else v for v in patch.values()]
            self._conn.execute(
                f"UPDATE threads SET {assignments}, updated_at=? WHERE id=?", (*values, now, thread_id)
            )
            seq = self._allocate_seq(thread_id)
            if "title" in patch:
                # the user naming it himself decides the title as much as the review job
                # does — without this stamp the job would see a freshly renamed thread
                # as overdue and rename it back over him.
                self._conn.execute("UPDATE threads SET title_seq=? WHERE id=?", (seq, thread_id))
            self._append_event(thread_id, seq, "thread.patch", patch, now)
            self._conn.commit()
            return self.get_thread_summary(thread_id, hub_user_id=hub_user_id)

    def list_title_review_candidates(
        self, *, min_messages: int = TITLE_REVIEW_MIN_MESSAGES, limit: int = 20
    ) -> list[dict[str, Any]]:
        """Threads whose conversation has moved on since they were named — the one cheap
        read the re-titling cron job makes (`POST /api/platform/hub/title` is the other
        half). Ordered by how far each has drifted, so a capped batch takes the worst.

        `kind='chat'` only: a brief/ops/money/cron thread carries the functional name the
        gateway delivered it under, and renaming those would fight the delivery path and
        break the names the user navigates by. Archived threads are nobody's problem.

        A NULL title counts — `title_seq` 0 means every message is "since", so a thread
        whose opener was too thin to name it (`_auto_title` returns None for "hello") is
        a candidate as soon as it has said enough. Each candidate carries the tail of
        what was said since, so the job needs no second read per thread."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT t.id, t.title, t.kind, t.title_seq, t.last_seq, t.updated_at, "
                "(SELECT COUNT(*) FROM messages m WHERE m.thread_id=t.id AND m.seq>t.title_seq) "
                "AS messages_since_title "
                "FROM threads t WHERE t.kind='chat' AND t.archived=0 AND "
                "(SELECT COUNT(*) FROM messages m WHERE m.thread_id=t.id AND m.seq>t.title_seq) >= ? "
                "ORDER BY messages_since_title DESC, t.updated_at DESC LIMIT ?",
                (min_messages, limit),
            ).fetchall()
            candidates = []
            for row in rows:
                candidate = dict(row)
                candidate["recent"] = self._title_review_excerpt(row["id"], row["title_seq"])
                candidates.append(candidate)
            return candidates

    def _title_review_excerpt(self, thread_id: str, after_seq: int) -> list[dict[str, str]]:
        """CALLER MUST HOLD `_lock`. Text parts only — a tool card, an image or a
        reasoning trace says nothing about what the conversation is now about."""
        rows = self._conn.execute(
            "SELECT m.role, p.data FROM messages m JOIN parts p ON p.message_id=m.id "
            "WHERE m.thread_id=? AND m.seq>? AND p.type='text' "
            "ORDER BY m.seq DESC, p.idx DESC LIMIT ?",
            (thread_id, after_seq, TITLE_REVIEW_EXCERPTS),
        ).fetchall()
        excerpt = []
        for row in reversed(rows):
            text = " ".join(json.loads(row["data"]).get("text", "").split())
            if text:
                excerpt.append({"role": row["role"], "text": text[:TITLE_REVIEW_EXCERPT_CHARS]})
        return excerpt

    def get_thread_user_state(self, thread_id: str, *, hub_user_id: str = "user") -> dict[str, Any]:
        """Read one user's per-thread state, defaulting to the schema's own zero-values
        when no row exists yet (a thread nobody has ever marked read)."""
        with self._lock:
            row = self._conn.execute(
                "SELECT last_read_seq, snoozed_until, muted FROM thread_user_state "
                "WHERE thread_id=? AND hub_user_id=?",
                (thread_id, hub_user_id),
            ).fetchone()
            return dict(row) if row else {"last_read_seq": 0, "snoozed_until": None, "muted": False}

    def mark_read(self, *, thread_id: str, seq: int, hub_user_id: str = "user") -> dict[str, Any]:
        """Advances (never rewinds) `last_read_seq` for one user on one thread, capped
        at the thread's own `last_seq` so a client-supplied seq ahead of anything
        hub-api has ever minted can't produce a negative unread downstream. Raises
        KeyError for an unknown thread — chat/routes.py turns that into an honest 404.

        Leaves `thread_user_state.unread` untouched: that column exists for a
        DIFFERENT, not-yet-built purpose (VERDICT-V2 §4.2 — an optional
        `PATCH {"unread": false}` purely so Desktop's own unread badge, a separate code
        path, doesn't drift). Every read route in this slice computes its own unread
        live as the messages past the cursor (see `_THREAD_SUMMARY_SELECT`)."""
        with self._lock:
            thread = self.get_thread(thread_id)
            if thread is None:
                raise KeyError(thread_id)
            target = max(0, min(seq, thread["last_seq"]))
            existing = self._conn.execute(
                "SELECT last_read_seq FROM thread_user_state WHERE thread_id=? AND hub_user_id=?",
                (thread_id, hub_user_id),
            ).fetchone()
            new_last_read = max(existing["last_read_seq"], target) if existing else target
            if existing:
                self._conn.execute(
                    "UPDATE thread_user_state SET last_read_seq=? WHERE thread_id=? AND hub_user_id=?",
                    (new_last_read, thread_id, hub_user_id),
                )
            else:
                self._conn.execute(
                    "INSERT INTO thread_user_state (thread_id, hub_user_id, last_read_seq) VALUES (?,?,?)",
                    (thread_id, hub_user_id, new_last_read),
                )
            unread = self._conn.execute(
                "SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND seq > ?",
                (thread_id, new_last_read),
            ).fetchone()["n"]
            self._conn.commit()
            return {"thread_id": thread_id, "last_read_seq": new_last_read, "unread": unread}

    # -- seq / events -----------------------------------------------------------
    def _allocate_seq(self, thread_id: str) -> int:
        """CALLER MUST HOLD `_lock`. hub-api is the sole seq allocator (VERDICT.md §3.1);
        this is the one place a seq number is ever minted."""
        self._conn.execute(
            "UPDATE threads SET last_seq = last_seq + 1, updated_at=? WHERE id=?",
            (_now_iso(), thread_id),
        )
        row = self._conn.execute("SELECT last_seq FROM threads WHERE id=?", (thread_id,)).fetchone()
        return int(row["last_seq"])

    def _append_event(self, thread_id: str, seq: int, event_type: str, payload: dict[str, Any], now: str) -> None:
        """CALLER MUST HOLD `_lock` and pass an already-allocated `seq` (or 0, reserved
        for thread creation, which `_allocate_seq` never hands out — it starts at 1)."""
        self._conn.execute(
            "INSERT INTO events (thread_id, seq, type, payload, created_at) VALUES (?,?,?,?,?)",
            (thread_id, seq, event_type, json.dumps(payload), now),
        )

    def _touch_message(self, message_id: str, seq: int, now: str, *, status: str | None = None) -> None:
        """CALLER MUST HOLD `_lock`. Every event that names a message moves the
        row's version to that event's seq — the one fact a client needs to
        decide whether the frame it just received is news."""
        if status is None:
            self._conn.execute("UPDATE messages SET version=?, updated_at=? WHERE id=?", (seq, now, message_id))
        else:
            self._conn.execute(
                "UPDATE messages SET version=?, updated_at=?, status=? WHERE id=?", (seq, now, status, message_id)
            )

    def _upsert_payload(self, message_id: str) -> dict[str, Any]:
        """CALLER MUST HOLD `_lock`. The one shape of a `message.upsert`: the row as
        it is, after the write. Call sites used to assemble these by hand and each
        left something out — the frame carried no timestamps, so a row first seen
        live had no time under it, and no version, so nothing could tell a replay
        from news."""
        row = self._message_row(message_id)
        return {
            "message_id": message_id,
            "version": row["version"],
            # The frame's own `seq` is the event's. The row's place in the
            # thread is this, and only the insert event has the two equal: a
            # client that took the event's seq as the row's moved a finished
            # reply below every tool card that had landed since.
            "message_seq": row["seq"],
            "role": row["role"],
            "author_type": row["author_type"],
            "status": row["status"],
            "run_id": row["run_id"],
            "parts": row["parts"],
            "client_msg_id": row["client_msg_id"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def _text_of(self, message_id: str) -> str:
        """CALLER MUST HOLD `_lock`. A row's prose: its text parts, joined."""
        return "".join(
            p.get("text") or ""
            for p in (
                json.loads(r["data"])
                for r in self._conn.execute("SELECT data FROM parts WHERE message_id=? ORDER BY idx", (message_id,))
            )
            if p.get("type") == "text"
        )

    def begin_run(self, thread_id: str, run_id: str) -> None:
        """This thread has a turn in flight.

        "Working" used to be read off row status, and a row belongs to one LLM
        stream while a turn has one stream per tool round: between them nothing
        was streaming and the ring, the Stop button and the list dot all went
        idle mid-turn — 48 seconds of it on one of the user's turns (2026-09-30,
        "working animation seems to disappear when it goes from tool back to
        thinking"). The turn is the right unit and only the gateway knows its
        edges, so it says so: here, and `end_run` when it delivers the reply.

        Written once per turn, not once per delta — the caller is on the
        per-token path.
        """
        with self._lock:
            row = self._conn.execute("SELECT active_run_id, status FROM threads WHERE id=?", (thread_id,)).fetchone()
            if row is None or (row["active_run_id"] == run_id and row["status"] == "running"):
                return
            now = _now_iso()
            self._conn.execute(
                "UPDATE threads SET status='running', active_run_id=?, updated_at=? WHERE id=?",
                (run_id, now, thread_id),
            )
            seq = self._allocate_seq(thread_id)
            self._append_event(thread_id, seq, "run.status", {"run_id": run_id, "status": "running"}, now)
            self._conn.commit()

    def end_run(self, thread_id: str, *, run_id: str | None = None) -> None:
        """The turn is over — the gateway has delivered its reply. A `run_id`
        that is not the one in flight is a straggler from a turn already
        finished and leaves the live one alone."""
        with self._lock:
            row = self._conn.execute("SELECT active_run_id, status FROM threads WHERE id=?", (thread_id,)).fetchone()
            if row is None or row["status"] != "running":
                return
            if run_id is not None and row["active_run_id"] not in (None, run_id):
                return
            now = _now_iso()
            ended = row["active_run_id"]
            self._conn.execute(
                "UPDATE threads SET status='idle', active_run_id=NULL, updated_at=? WHERE id=?", (now, thread_id)
            )
            seq = self._allocate_seq(thread_id)
            self._append_event(thread_id, seq, "run.status", {"run_id": ended, "status": "idle"}, now)
            self._conn.commit()

    def thread_has_subagent(self, thread_id: str, child_session_id: str) -> bool:
        """Whether this thread ever ran that subagent.

        The gateway will read any session id it is handed, so the Hub decides
        which ones a thread may ask for, and it decides from what it already
        stored: the `delegate_task` part the subagent_start hook delivered
        carries the child's session id.
        """
        row = self._conn.execute(
            "SELECT 1 FROM parts p JOIN messages m ON m.id = p.message_id "
            "WHERE m.thread_id = ? AND p.type = 'tool_call' "
            "AND json_extract(p.data, '$.subagent.child_session_id') = ? LIMIT 1",
            (thread_id, child_session_id),
        ).fetchone()
        return row is not None

    def list_events_after(self, thread_id: str, after_seq: int, limit: int = 500) -> list[dict[str, Any]]:
        """What a reconnecting client replays. Bounded by `limit`; a gap wider than the
        retention window (`prune_events`) means the caller must resync from a snapshot
        instead — this method does not know or care which case it's in."""
        return self.scan_events_after(thread_id, after_seq, limit)[0]

    def scan_events_after(
        self, thread_id: str, after_seq: int, limit: int = 500
    ) -> tuple[list[dict[str, Any]], int]:
        """`list_events_after`, plus how far the scan got: the highest seq examined,
        whether or not its event survived the filter below. A caller draining the
        log in batches continues from THAT — the last surviving event can sit well
        below the last row read whenever the newest rows belong to a swept
        message, and a drain that resumed from it re-read the same dead rows
        each tick and never reached the present (`chat/ws.py`)."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT seq, type, payload, created_at FROM events "
                "WHERE thread_id=? AND seq > ? ORDER BY seq LIMIT ?",
                (thread_id, after_seq, limit),
            ).fetchall()
            scanned_to = int(rows[-1]["seq"]) if rows else after_seq
            events = [
                {"seq": r["seq"], "type": r["type"], "payload": json.loads(r["payload"]), "created_at": r["created_at"]}
                for r in rows
            ]
            # An event for a message that no longer exists would put it back on
            # screen: a duplicate swept out of the table returned the moment the
            # socket replayed its upsert (the user, 2026-09-22 — "the duplicates
            # disappear for a second when i open that chat but then they come
            # back"). The table is what is true; the log only describes it.
            wanted = {
                e["payload"]["message_id"]
                for e in events
                if isinstance(e["payload"], dict) and isinstance(e["payload"].get("message_id"), str)
            }
            if not wanted:
                return events, scanned_to
            alive = {
                r["id"]
                for r in self._conn.execute(
                    f"SELECT id FROM messages WHERE id IN ({','.join('?' * len(wanted))})", tuple(wanted)
                )
            }
            return [
                e
                for e in events
                if not isinstance(e["payload"], dict)
                or not isinstance(e["payload"].get("message_id"), str)
                or e["payload"]["message_id"] in alive
            ], scanned_to

    def earliest_event_seq(self, thread_id: str) -> int | None:
        """Lowest surviving seq in the event log for one thread, or None if none
        survive (nothing has happened yet, or everything in range was pruned).
        `chat/ws.py` uses this to tell "cursor is behind but the log still covers it"
        from "cursor is older than what `prune_events` retains" — the latter must
        answer `subscribe` with `snapshot_required` instead of silently starting the
        replay from whatever happens to survive (VERDICT-V2 §4.1)."""
        with self._lock:
            row = self._conn.execute(
                "SELECT MIN(seq) AS min_seq FROM events WHERE thread_id=?", (thread_id,)
            ).fetchone()
            return int(row["min_seq"]) if row and row["min_seq"] is not None else None

    def prune_events(self, older_than_days: int = 30) -> int:
        """Delete event-log rows older than the retention window. `events` is the delta
        log for reconnect replay, not the durable transcript (`messages`/`parts` are) —
        pruning it bounds chat.db's growth without losing any conversation history.
        Not wired to a cron in this slice (deploying is a separate step); call this from
        a scheduled script when one is added."""
        with self._lock:
            cutoff = (datetime.now(timezone.utc) - timedelta(days=older_than_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
            cur = self._conn.execute("DELETE FROM events WHERE created_at < ?", (cutoff,))
            self._conn.commit()
            return cur.rowcount

    # -- messages / parts ---------------------------------------------------------
    def _message_row(self, message_id: str) -> dict[str, Any]:
        row = self._conn.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
        d = dict(row)
        d["hermes_row_ids"] = json.loads(d["hermes_row_ids"]) if d["hermes_row_ids"] else None
        parts = self._conn.execute(
            "SELECT data FROM parts WHERE message_id=? ORDER BY idx", (message_id,)
        ).fetchall()
        d["parts"] = [json.loads(p["data"]) for p in parts]
        return d

    def list_messages(
        self, thread_id: str, *, after_seq: int = 0, limit: int = 200, before_seq: int | None = None
    ) -> list[dict[str, Any]]:
        """The messages a thread opens on.

        With no cursor this is the NEWEST `limit` rows, in ascending order — a
        thread opens on the present. The first cut returned the OLDEST 200
        (`ORDER BY seq LIMIT ?` from seq 0), so a long thread opened days back
        and reached the present only after the socket had replayed every event
        since (the user, 2026-09-28: "takes a bit for the most recent ones to
        load"). `after_seq` reads forward from a cursor; `before_seq` pages
        older rows for scroll-back.
        """
        with self._lock:
            if after_seq > 0:
                ids = self._conn.execute(
                    "SELECT id FROM messages WHERE thread_id=? AND seq > ? ORDER BY seq LIMIT ?",
                    (thread_id, after_seq, limit),
                ).fetchall()
            elif before_seq is not None:
                ids = self._conn.execute(
                    "SELECT id FROM messages WHERE thread_id=? AND seq < ? ORDER BY seq DESC LIMIT ?",
                    (thread_id, before_seq, limit),
                ).fetchall()[::-1]
            else:
                ids = self._conn.execute(
                    "SELECT id FROM messages WHERE thread_id=? ORDER BY seq DESC LIMIT ?",
                    (thread_id, limit),
                ).fetchall()[::-1]
            return [self._message_row(r["id"]) for r in ids]

    def message_by_cron_run_id(self, thread_id: str, cron_run_id: str) -> dict[str, Any] | None:
        with self._lock:
            return self._get_message_by_dedup(thread_id, "cron_run_id", cron_run_id)

    def _get_message_by_dedup(self, thread_id: str, column: str, value: str) -> dict[str, Any] | None:
        # `column` is always one of the two literal strings below — never request input.
        assert column in ("cron_run_id", "client_msg_id")
        row = self._conn.execute(
            f"SELECT id FROM messages WHERE thread_id=? AND {column}=?", (thread_id, value)
        ).fetchone()
        return self._message_row(row["id"]) if row else None

    def _insert_message_locked(self, **kwargs) -> tuple[dict[str, Any], bool]:
        """`insert_message`'s body, callable from another method that already
        holds `_lock` (RLock makes the re-entry safe either way; this exists so
        the streaming path reads as one transaction rather than two)."""
        return self.insert_message(**kwargs)

    def insert_message(
        self,
        *,
        thread_id: str,
        role: str,
        author_type: str,
        parts: list[dict[str, Any]],
        run_id: str | None = None,
        status: str = "complete",
        hermes_row_ids: list[Any] | None = None,
        client_msg_id: str | None = None,
        cron_run_id: str | None = None,
        job_id: str | None = None,
        job_run_id: str | None = None,
        message_id: str | None = None,
    ) -> tuple[dict[str, Any], bool]:
        """Returns (message, created). `created=False` means this call was a dedup hit —
        the existing message is returned unchanged and nothing new was inserted."""
        with self._lock:
            if cron_run_id:
                existing = self._get_message_by_dedup(thread_id, "cron_run_id", cron_run_id)
                if existing:
                    return existing, False
            if client_msg_id:
                existing = self._get_message_by_dedup(thread_id, "client_msg_id", client_msg_id)
                if existing:
                    return existing, False
            now = _now_iso()
            seq = self._allocate_seq(thread_id)
            # Callers that need a row's id to survive a rebuild (the demo seed,
            # which re-creates the same conversation on every start) can pin it;
            # everything else keeps a fresh random id.
            message_id = message_id or f"msg_{secrets.token_hex(8)}"
            try:
                self._conn.execute(
                    "INSERT INTO messages (id, thread_id, seq, role, author_type, run_id, status, "
                    "hermes_row_ids, client_msg_id, cron_run_id, job_id, job_run_id, version, "
                    "created_at, updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        message_id, thread_id, seq, role, author_type, run_id, status,
                        json.dumps(hermes_row_ids) if hermes_row_ids is not None else None,
                        client_msg_id, cron_run_id, job_id, job_run_id, seq, now, now,
                    ),
                )
            except sqlite3.IntegrityError:
                # The UNIQUE dedup index caught a race the pre-check above missed.
                self._conn.rollback()
                key, value = ("cron_run_id", cron_run_id) if cron_run_id else ("client_msg_id", client_msg_id)
                existing = self._get_message_by_dedup(thread_id, key, value)  # type: ignore[arg-type]
                if existing is not None:
                    return existing, False
                raise
            for idx, part in enumerate(parts):
                self._conn.execute(
                    "INSERT INTO parts (message_id, idx, type, data, created_at) VALUES (?,?,?,?,?)",
                    (message_id, idx, part["type"], json.dumps(part), now),
                )
            self._append_event(thread_id, seq, "message.upsert", self._upsert_payload(message_id), now)
            self._conn.commit()
            return self._message_row(message_id), True

    # -- streaming a reply as it is written -------------------------------------
    def append_stream_delta(
        self, *, thread_id: str, run_id: str, delta: str, kind: str = "text",
        hermes_session_id: str | None = None,
    ) -> dict[str, Any]:
        """Grow the turn's in-flight reply by `delta`, creating it on the first one.

        The gateway streams the assistant's text to the plugin token by token;
        without this the Hub threw every token away and posted the finished
        message, so nothing moved on screen for the length of a turn. Keyed by
        (thread_id, run_id) so the plugin can stay stateless and fire-and-forget:
        it posts deltas, this decides whether that is a new message or a longer
        one. Emits `part.delta` (not a full upsert) so a client appends rather
        than re-rendering the whole transcript on every token."""
        with self._lock:
            self.get_or_create_thread(thread_id)
            if hermes_session_id:
                self._conn.execute(
                    "UPDATE threads SET hermes_session_id=? WHERE id=? AND (hermes_session_id IS NULL OR hermes_session_id='')",
                    (hermes_session_id, thread_id),
                )
            # One streaming row per KIND. Thinking and the reply are different
            # objects on screen and arrive interleaved with tool cards; sharing
            # a row meant the finished text replaced the thinking, and the reply
            # sat above the tools that produced it because the row was created
            # before them (the user, 2026-09-22).
            delta = _collapse_degenerate_runs(delta)
            message_id = self._streaming_message_id(thread_id, run_id, kind)
            if message_id is None:
                message, _ = self._insert_message_locked(
                    thread_id=thread_id, role="assistant", author_type="agent",
                    parts=[{"type": kind, "text": delta}], run_id=run_id, status="streaming",
                )
                return message
            now = _now_iso()
            last = self._conn.execute(
                "SELECT idx, data FROM parts WHERE message_id=? ORDER BY idx DESC LIMIT 1", (message_id,)
            ).fetchone()
            if last is not None and json.loads(last["data"]).get("type") == kind:
                # Same kind as the part still being written: grow it.
                idx = last["idx"]
                data = json.loads(last["data"])
                before = data.get("text") or ""
                grown = _collapse_degenerate_runs(before + delta)
                if _is_degenerate_tail(grown):
                    # A stuck stream. On 2026-09-22 a turn fired 10,231 separate
                    # one-character reasoning deltas, all '!', and the thinking
                    # pane filled with a wall of exclamation marks (the user). The
                    # gateway's own store had two '!' for that whole session, so
                    # the garbage is the stream's, not the model's. Nothing is
                    # lost by refusing to grow a run that is already this long,
                    # and the check is O(1) per delta.
                    return self._message_row(message_id)
                data["text"] = grown
                self._conn.execute("UPDATE parts SET data=? WHERE message_id=? AND idx=?", (json.dumps(data), message_id, idx))
                # The text's length before and after, in the client's units. A
                # part that is not exactly `offset` long is missing something,
                # or already has this — either way appending would be wrong,
                # and the client refetches instead of guessing.
                event_type, payload = "part.delta", {
                    "message_id": message_id, "idx": idx, "delta": delta,
                    "offset": _utf16_len(before), "length": _utf16_len(grown),
                }
            else:
                # The turn moved on — thinking to speech, or back. A new part,
                # so the client appends rather than mixing the two streams.
                idx = (last["idx"] + 1) if last is not None else 0
                data = {"type": kind, "text": delta}
                self._conn.execute(
                    "INSERT INTO parts (message_id, idx, type, data, created_at) VALUES (?,?,?,?,?)",
                    (message_id, idx, kind, json.dumps(data), now),
                )
                event_type, payload = "part.upsert", {"message_id": message_id, "idx": idx, "part": data}
            seq = self._allocate_seq(thread_id)
            self._touch_message(message_id, seq, now)
            self._append_event(thread_id, seq, event_type, payload, now)
            self._conn.commit()
            return self._message_row(message_id)

    def _streaming_message_id(self, thread_id: str, run_id: str, kind: str) -> str | None:
        """The in-flight row of this kind for this run, if there is one. Kind is
        read off the row's FIRST part, which is what it was opened with."""
        for row in self._conn.execute(
            "SELECT id FROM messages WHERE thread_id=? AND run_id=? AND status='streaming' ORDER BY seq",
            (thread_id, run_id),
        ):
            first = self._conn.execute(
                "SELECT type FROM parts WHERE message_id=? ORDER BY idx LIMIT 1", (row["id"],)
            ).fetchone()
            if first is not None and first["type"] == kind:
                return row["id"]
        return None

    def finalize_streaming_message(
        self, *, thread_id: str, run_id: str, parts: list[dict[str, Any]], status: str = "complete"
    ) -> dict[str, Any] | None:
        """Land the finished reply on the message that was streaming it, rather
        than posting a second copy underneath. Returns None when nothing was
        streaming for this run — the caller then inserts as usual."""
        with self._lock:
            now = _now_iso()
            message_id = self._streaming_message_id(thread_id, run_id, "text")
            if message_id is not None:
                streamed = self._text_of(message_id)
                delivered = "".join(p.get("text") or "" for p in parts if p.get("type") == "text")
                if streamed.strip() and (not delivered.strip() or not _same_reply(streamed, delivered)):
                    # Not this row's words — a steer acknowledgement or an
                    # interim note under the same run id. It gets its own row
                    # and the stream keeps its own; nothing here is touched.
                    return None
            # Thinking is finished by this too, but keeps its own text: the
            # reply never overwrites it.
            for other in self._conn.execute(
                "SELECT id FROM messages WHERE thread_id=? AND run_id=? AND status='streaming'",
                (thread_id, run_id),
            ).fetchall():
                first = self._conn.execute(
                    "SELECT type FROM parts WHERE message_id=? ORDER BY idx LIMIT 1", (other["id"],)
                ).fetchone()
                if first is not None and first["type"] == "reasoning":
                    seq = self._allocate_seq(thread_id)
                    self._touch_message(other["id"], seq, now, status="complete")
                    self._append_event(thread_id, seq, "message.upsert", self._upsert_payload(other["id"]), now)
            if message_id is None:
                self._conn.commit()
                return None
            self._conn.execute("DELETE FROM parts WHERE message_id=?", (message_id,))
            for idx, part in enumerate(parts):
                self._conn.execute(
                    "INSERT INTO parts (message_id, idx, type, data, created_at) VALUES (?,?,?,?,?)",
                    (message_id, idx, part["type"], json.dumps(part), now),
                )
            seq = self._allocate_seq(thread_id)
            self._touch_message(message_id, seq, now, status=status)
            self._append_event(thread_id, seq, "message.upsert", self._upsert_payload(message_id), now)
            self._conn.commit()
            return self._message_row(message_id)

    def close_orphan_streams(self, thread_id: str, *, keep_run_id: str | None) -> int:
        """Close rows left `streaming` by a turn that never finished.

        A turn's streamed prose and thinking are closed by the reply that lands
        on them. When that reply arrives under a different run id — or never,
        because the turn was interrupted — the rows stay `streaming` for good
        and the app keeps spinning ("the working animation doesn't seem to be
        clearing at the end of message send from agent", the user 2026-09-22). Any
        finished reply is proof the earlier run is over.

        The text already streamed IS what the agent said, so the rows are
        closed as complete rather than rewritten or discarded.
        """
        with self._lock:
            now = _now_iso()
            rows = self._conn.execute(
                "SELECT id, run_id FROM messages WHERE thread_id=? AND status='streaming' "
                "AND (run_id IS NULL OR run_id != ?)",
                (thread_id, keep_run_id or ""),
            ).fetchall()
            for row in rows:
                seq = self._allocate_seq(thread_id)
                self._touch_message(row["id"], seq, now, status="complete")
                self._append_event(thread_id, seq, "message.upsert", self._upsert_payload(row["id"]), now)
            self._conn.commit()
            return len(rows)

    def replace_run_prose(self, *, thread_id: str, run_id: str, parts: list[dict[str, Any]]) -> dict[str, Any] | None:
        """Land a re-sent reply on the row that already holds it — and ONLY it.

        The 2026-09-22 version of this rule was "one run, one prose row, last
        delivery wins". It was wrong: a turn can legitimately say two different
        things — a long answer and then "Noted your meds" — and the rule
        overwrote the answer with the note. Six replies were lost that way and
        restored from the event log (2026-09-28).

        What the gateway actually re-sends is the SAME text: an interim final
        and the true final, where one is a prefix of the other, or the
        streamed copy has a hole in the middle so the final is a superset. So
        the test is the text, and a different text is a new message.
        """
        text = "".join(p.get("text") or "" for p in parts if isinstance(p, dict) and p.get("type") == "text")
        if not text.strip():
            return None
        with self._lock:
            for row in self._conn.execute(
                "SELECT id FROM messages WHERE thread_id=? AND run_id=? AND role='assistant' ORDER BY seq DESC LIMIT 6",
                (thread_id, run_id),
            ).fetchall():
                existing = [
                    json.loads(r["data"])
                    for r in self._conn.execute(
                        "SELECT data FROM parts WHERE message_id=? ORDER BY idx", (row["id"],)
                    )
                ]
                if not existing or existing[0].get("type") != "text":
                    continue
                had = "".join(p.get("text") or "" for p in existing if p.get("type") == "text")
                if not _same_reply(had, text):
                    continue
                keep = parts if len(text) >= len(had) else existing
                now = _now_iso()
                self._conn.execute("DELETE FROM parts WHERE message_id=?", (row["id"],))
                for idx, part in enumerate(keep):
                    self._conn.execute(
                        "INSERT INTO parts (message_id, idx, type, data, created_at) VALUES (?,?,?,?,?)",
                        (row["id"], idx, part["type"], json.dumps(part), now),
                    )
                seq = self._allocate_seq(thread_id)
                self._touch_message(row["id"], seq, now, status="complete")
                self._append_event(thread_id, seq, "message.upsert", self._upsert_payload(row["id"]), now)
                self._conn.commit()
                return self._message_row(row["id"])
        return None

    def close_run_streams(self, thread_id: str, *, run_id: str) -> int:
        """Close what one run left streaming — the stream that wrote it ended."""
        with self._lock:
            now = _now_iso()
            rows = self._conn.execute(
                "SELECT id FROM messages WHERE thread_id=? AND run_id=? AND status='streaming'",
                (thread_id, run_id),
            ).fetchall()
            for row in rows:
                seq = self._allocate_seq(thread_id)
                self._touch_message(row["id"], seq, now, status="complete")
                self._append_event(thread_id, seq, "message.upsert", self._upsert_payload(row["id"]), now)
            self._conn.commit()
            return len(rows)

    def land_subagent_stop(self, thread_id: str, part: dict[str, Any]) -> dict[str, Any] | None:
        """A subagent's `stop` lands on the row holding its `start`.

        The two share a `tool_call_id` (`subagent:<child_session_id>`), but the
        gateway delivers them minutes apart and each became its own row: the
        start card sat there "working" for ever and the stop was a second card
        far below it (the user, 2026-09-29: "they end up getting hidden up in
        previous messages"). One row, updated in place, the way an approval's
        card is resolved. Returns None when no start is on record."""
        tool_call_id = part.get("tool_call_id")
        if not isinstance(tool_call_id, str) or not tool_call_id:
            return None
        with self._lock:
            row = self._conn.execute(
                "SELECT p.id, p.message_id, p.idx FROM parts p JOIN messages m ON m.id = p.message_id "
                "WHERE m.thread_id=? AND p.type='tool_call' "
                "AND json_extract(p.data, '$.tool_call_id')=? "
                "AND json_extract(p.data, '$.subagent.phase')='start' "
                "ORDER BY m.seq DESC LIMIT 1",
                (thread_id, tool_call_id),
            ).fetchone()
            if row is None:
                return None
            now = _now_iso()
            self._conn.execute("UPDATE parts SET data=? WHERE id=?", (json.dumps(part), row["id"]))
            seq = self._allocate_seq(thread_id)
            self._touch_message(row["message_id"], seq, now)
            self._append_event(
                thread_id, seq, "part.upsert",
                {"message_id": row["message_id"], "idx": row["idx"], "part": part}, now,
            )
            self._conn.commit()
            return self._message_row(row["message_id"])

    def set_checklist_item(
        self, *, thread_id: str, message_id: str, part_index: int, item_index: int, state: str
    ) -> dict[str, Any] | None:
        """Tick a checklist item, in the widget itself.

        the user, 2026-09-22: "make check list widgets interactive too and have them
        update the underlying data on change". The widget part IS the underlying
        data — the transcript is what every client reads — so the tick is
        written there rather than into a side table that the card would then
        have to reconcile against.

        Returns {label, state} for the caller to tell the agent about, or None
        when this is not a checklist item.
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT p.data AS data FROM parts p JOIN messages m ON m.id = p.message_id "
                "WHERE p.message_id=? AND p.idx=? AND m.thread_id=?",
                (message_id, part_index, thread_id),
            ).fetchone()
            if row is None:
                return None
            part = json.loads(row["data"])
            if part.get("type") != "widget" or part.get("kind") != "checklist":
                return None
            props = part.get("props")
            items = props.get("items") if isinstance(props, dict) else None
            if not isinstance(items, list) or not 0 <= item_index < len(items):
                return None
            item = items[item_index]
            if not isinstance(item, dict):
                return None
            item["state"] = state
            now = _now_iso()
            self._conn.execute(
                "UPDATE parts SET data=? WHERE message_id=? AND idx=?",
                (json.dumps(part), message_id, part_index),
            )
            seq = self._allocate_seq(thread_id)
            self._touch_message(message_id, seq, now)
            self._append_event(
                thread_id, seq, "part.upsert",
                {"message_id": message_id, "idx": part_index, "part": part},
                now,
            )
            self._conn.commit()
            return {"label": str(item.get("label") or f"item {item_index + 1}"), "state": state}

    def note_for_agent(self, thread_id: str, note: str) -> None:
        """Park something the agent should know before its next turn.

        A tick is not worth waking Assistant for — that would be a whole turn per
        checkbox. It IS worth him knowing the next time he is spoken to, so it
        waits here and rides along with the next message.
        """
        with self._lock:
            self._conn.execute(
                'INSERT INTO widget_responses (thread_id, message_id, widget_id, "values", created_at) '
                "VALUES (?,?,?,?,?)",
                (thread_id, None, "agent_note", json.dumps({"note": note}), _now_iso()),
            )
            self._conn.commit()

    def drain_agent_notes(self, thread_id: str) -> list[str]:
        """Everything parked since the last message, oldest first, taken once."""
        with self._lock:
            rows = self._conn.execute(
                'SELECT id, "values" AS values_json FROM widget_responses '
                "WHERE thread_id=? AND widget_id='agent_note' ORDER BY id",
                (thread_id,),
            ).fetchall()
            if not rows:
                return []
            self._conn.executemany(
                "DELETE FROM widget_responses WHERE id=?", [(r["id"],) for r in rows]
            )
            self._conn.commit()
            notes = []
            for r in rows:
                try:
                    notes.append(str(json.loads(r["values_json"]).get("note") or ""))
                except ValueError:
                    continue
            return [n for n in notes if n]

    def set_message_forward_status(self, message_id: str, *, status: str, reason: str = "") -> None:
        """Records a human-sent message's forward-to-gateway outcome (chat/routes.py's
        `/send`) — 'pending' (with a short reason) while the hub adapter's inbound leg
        stays Phase 1 observer-only, 'forwarded' the day phase 3's dispatch succeeds.
        Never touches `messages.status` (the durable-transcript rendering state) — this
        is a separate, additive fact about the same row. No new event is appended: the
        `message.upsert` event `insert_message` already emitted is what a connected
        WebSocket client sees the send through; this is a REST-read-only detail."""
        with self._lock:
            self._conn.execute(
                "UPDATE messages SET forward_status=?, forward_reason=? WHERE id=?",
                (status, reason, message_id),
            )
            self._conn.commit()

    # -- attention / approvals -----------------------------------------------------
    def upsert_attention(
        self,
        *,
        thread_id: str,
        kind: str,
        request_id: str | None = None,
        run_id: str | None = None,
        summary: str = "",
        expires_at_derived: str | None = None,
        message_id: str | None = None,
    ) -> dict[str, Any]:
        """One open row per (thread_id, kind, request_id) when `request_id` is given
        (approvals, widgets); otherwise always inserts a fresh row (mentions, stalls —
        nothing to key a re-open against)."""
        with self._lock:
            now = _now_iso()
            existing = None
            if request_id:
                existing = self._conn.execute(
                    "SELECT id FROM attention WHERE thread_id=? AND kind=? AND request_id=? AND state='open'",
                    (thread_id, kind, request_id),
                ).fetchone()
            if existing:
                att_id = existing["id"]
                self._conn.execute(
                    "UPDATE attention SET summary=?, run_id=?, expires_at_derived=?, message_id=? WHERE id=?",
                    (summary, run_id, expires_at_derived, message_id, att_id),
                )
            else:
                att_id = f"att_{secrets.token_hex(8)}"
                self._conn.execute(
                    "INSERT INTO attention (id, thread_id, kind, request_id, run_id, message_id, "
                    "summary, state, expires_at_derived, created_at) VALUES (?,?,?,?,?,?,?,'open',?,?)",
                    (att_id, thread_id, kind, request_id, run_id, message_id, summary, expires_at_derived, now),
                )
            seq = self._allocate_seq(thread_id)
            row = self._conn.execute("SELECT * FROM attention WHERE id=?", (att_id,)).fetchone()
            self._append_event(thread_id, seq, "attention.upsert", _attention_payload(row), now)
            self._conn.commit()
            return dict(row)

    def close_approval_resolved_elsewhere(self, *, thread_id: str, request_id: str) -> bool:
        """Settle a still-open approval card whose tool has since run.

        Only ever called from the ingest path, and deliberately does NOT write
        the `approvals` table: the Hub never learns WHICH choice was made
        elsewhere, and recording a guess there would make the local answered-set
        lie. It closes what it can honestly close — the transcript's card and
        the inbox row — and leaves the decision itself unrecorded.

        Returns False when there was nothing open, which is the normal case."""
        with self._lock:
            row = self._conn.execute(
                "SELECT p.id FROM parts p JOIN messages m ON m.id = p.message_id "
                "WHERE m.thread_id=? AND p.type='tool_call' "
                "AND json_extract(p.data, '$.tool_call_id')=? "
                "AND json_extract(p.data, '$.state')='approval_requested'",
                (thread_id, request_id),
            ).fetchone()
            if row is None:
                return False
            now = _now_iso()
            self._resolve_approval_part(thread_id, request_id, "elsewhere", now)
            self._resolve_attention_locked(thread_id, "approval", request_id, now)
            self._conn.commit()
            return True

    def settle_open_approvals(self, *, thread_id: str, keep: set[str], outcome: str) -> int:
        """Close every open approval card in a thread whose request the gateway
        is no longer waiting on. `outcome` is what ended it, as the gateway said:
        a typed answer ("once", "deny", …), "timeout", or "cancelled" when a stop
        withdrew it. An answer given in the Hub closed its card already, so this
        finds nothing for it."""
        label = {"cancelled": "withdrawn", "notify_failed": "withdrawn"}.get(outcome, outcome) or "elsewhere"
        with self._lock:
            rows = self._conn.execute(
                "SELECT request_id FROM attention WHERE thread_id=? AND kind='approval' AND state='open' "
                "AND request_id IS NOT NULL",
                (thread_id,),
            ).fetchall()
            now = _now_iso()
            closed = 0
            for row in rows:
                if row["request_id"] in keep:
                    continue
                self._resolve_approval_part(thread_id, row["request_id"], label, now)
                closed += int(self._resolve_attention_locked(thread_id, "approval", row["request_id"], now))
            self._conn.commit()
            return closed

    def resolve_attention(self, *, thread_id: str, kind: str, request_id: str) -> bool:
        """Close the open row for one answered question or decision.

        Without this the row stays `open` in the database forever: the client's
        own reducer marks it answered locally, so the tab badge drops until the
        app is reopened and refetches it as open again. Returns False when there
        was nothing open to close, which is the normal case for a decision
        resolved twice."""
        with self._lock:
            resolved = self._resolve_attention_locked(thread_id, kind, request_id, _now_iso())
            self._conn.commit()
            return resolved

    def _resolve_attention_locked(self, thread_id: str, kind: str, request_id: str, now: str) -> bool:
        """CALLER MUST HOLD `_lock` and commit."""
        row = self._conn.execute(
            "SELECT id FROM attention WHERE thread_id=? AND kind=? AND request_id=? AND state='open'",
            (thread_id, kind, request_id),
        ).fetchone()
        if row is None:
            return False
        self._conn.execute(
            "UPDATE attention SET state='answered', dismissed_at=? WHERE id=?", (now, row["id"])
        )
        updated = self._conn.execute("SELECT * FROM attention WHERE id=?", (row["id"],)).fetchone()
        seq = self._allocate_seq(thread_id)
        self._append_event(thread_id, seq, "attention.upsert", _attention_payload(updated), now)
        return True

    def thread_open_attention(self, thread_id: str) -> list[dict[str, Any]]:
        """One thread's open rows, in the shape an `attention.upsert` frame
        carries. A thread snapshot has to bring these: the socket resumes from
        the snapshot's cursor, so an approval raised before the thread was
        opened is never replayed, and its card never drew (the user, 2026-09-30)."""
        with self._lock:
            self._expire_stale_imessage_drafts_locked(_now_iso())
            self._conn.commit()
            rows = self._conn.execute(
                "SELECT * FROM attention WHERE thread_id=? AND state='open' ORDER BY created_at, rowid",
                (thread_id,),
            ).fetchall()
            return [_attention_payload(r) for r in rows]

    def _expire_stale_imessage_drafts_locked(self, now: str) -> None:
        """CALLER MUST HOLD `_lock` and commit after. A Mac draft expires by
        itself ~15 minutes after creation and NOTHING times it out for the Hub
        — a gateway approval is settled by the gateway's ingest, an imessage
        draft has no such caller, so its needs-you row stayed `open` forever
        and the inbox kept saying something was waiting on the user long after
        the draft was gone (the user, 2026-10-04). The read that answers "what
        is waiting on me" settles them: an open row of this kind past its own
        expiry is marked `expired` — not `answered`; no decision was made, the
        approvals CAS is untouched — and stops being listed."""
        rows = self._conn.execute(
            "SELECT a.id, a.thread_id, a.expires_at_derived FROM attention a "
            "WHERE a.kind=? AND a.state='open' AND a.expires_at_derived IS NOT NULL",
            (ATTENTION_KIND_IMESSAGE_DRAFT,),
        ).fetchall()
        for row in rows:
            if not _expiry_passed(row["expires_at_derived"], now):
                continue
            self._conn.execute(
                "UPDATE attention SET state='expired', dismissed_at=? WHERE id=? AND state='open'",
                (now, row["id"]),
            )
            updated = self._conn.execute("SELECT * FROM attention WHERE id=?", (row["id"],)).fetchone()
            seq = self._allocate_seq(row["thread_id"])
            self._append_event(row["thread_id"], seq, "attention.upsert", _attention_payload(updated), now)

    def list_open_attention(self, *, limit: int = 100) -> list[dict[str, Any]]:
        """Every open needs-you row, across every thread, newest first — the one
        read that answers "what is waiting on me" without opening each thread in
        turn. Each row carries its thread's title and kind so it can name where
        it came from and be navigated to from a single read.

        `created_at` is second-resolution (`_now_iso`), so `rowid` breaks
        same-second ties back into insert order rather than leaving two rows
        from the same tick to sort arbitrarily.

        Archived threads are not filtered out: archiving a thread hides it from
        the list, it does not answer the approval still sitting in it."""
        with self._lock:
            self._expire_stale_imessage_drafts_locked(_now_iso())
            self._conn.commit()
            rows = self._conn.execute(
                "SELECT a.id, a.thread_id, a.kind, a.request_id, a.message_id, a.summary, a.created_at, a.expires_at_derived, "
                "t.title AS thread_title, t.kind AS thread_kind "
                "FROM attention a JOIN threads t ON t.id = a.thread_id "
                "WHERE a.state = 'open' "
                "ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [dict(r) for r in rows]

    def upsert_approval(self, *, run_id: str, request_id: str, thread_id: str, frame: dict[str, Any], queue_pos: int = 0) -> dict[str, Any]:
        """Keyed (run_id, request_id) per v1 §3.4. Called only from the ingest path
        (`/api/platform/hub/deliver`) — this method only ever writes the frame as it
        arrives from a delivery. Resolving it (`choice`, `answered`) is `answer_approval`
        below's job, called from `/api/chat/approval/apply`, per T3 in VERDICT-V2 §7:
        the server must re-derive `choice` against the stored frame, never trust it
        as supplied."""
        with self._lock:
            now = _now_iso()
            existing = self._conn.execute(
                "SELECT 1 FROM approvals WHERE run_id=? AND request_id=?", (run_id, request_id)
            ).fetchone()
            if existing:
                self._conn.execute(
                    "UPDATE approvals SET queue_pos=?, frame=? WHERE run_id=? AND request_id=?",
                    (queue_pos, json.dumps(frame), run_id, request_id),
                )
            else:
                self._conn.execute(
                    "INSERT INTO approvals (request_id, run_id, thread_id, queue_pos, frame, answered, created_at) "
                    "VALUES (?,?,?,?,?,0,?)",
                    (request_id, run_id, thread_id, queue_pos, json.dumps(frame), now),
                )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM approvals WHERE run_id=? AND request_id=?", (run_id, request_id)
            ).fetchone()
            d = dict(row)
            d["frame"] = json.loads(d["frame"])
            return d

    def get_approval(self, *, run_id: str, request_id: str) -> dict[str, Any] | None:
        """Read one stored approval record — `chat/approval.py` calls this to re-derive
        the choices a decision was actually offered (T3, VERDICT-V2 §7) against the
        `frame` a `/api/platform/hub/deliver` call already persisted, never against
        anything the client supplies."""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM approvals WHERE run_id=? AND request_id=?", (run_id, request_id)
            ).fetchone()
            if row is None:
                return None
            d = dict(row)
            d["frame"] = json.loads(d["frame"])
            return d

    def answer_approval(self, *, run_id: str, request_id: str, choice: str) -> tuple[dict[str, Any], bool]:
        """Atomically flip one approval open -> answered: `WHERE answered=0` is the CAS
        that makes this the local answered-set T3's §(d) requires. Returns
        (row, applied) — applied=False means the row was already answered (a retry or
        double-tap) and this call left it untouched, returning the choice that was
        ACTUALLY recorded the first time, never silently re-applying a second one.

        Raises KeyError if the approval doesn't exist — callers must have already
        confirmed it does (chat/approval.py's `_validate_approval_decisions` runs
        before this, same as every other gated route's pre-challenge validation).

        `forward_status` is left at its schema default ('pending') on every path
        through this method — phase 3, not this slice, is what forwards an answered
        decision to the gateway and advances it."""
        with self._lock:
            now = _now_iso()
            cur = self._conn.execute(
                "UPDATE approvals SET choice=?, answered=1, answered_at=? "
                "WHERE run_id=? AND request_id=? AND answered=0",
                (choice, now, run_id, request_id),
            )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM approvals WHERE run_id=? AND request_id=?", (run_id, request_id)
            ).fetchone()
            if row is None:
                raise KeyError((run_id, request_id))
            d = dict(row)
            d["frame"] = json.loads(d["frame"])
            if cur.rowcount == 1:
                self._resolve_approval_part(d["thread_id"], request_id, choice, now)
                self._resolve_attention_locked(d["thread_id"], "approval", request_id, now)
                # An iMessage draft's needs-you row carries kind 'imessage_draft'
                # rather than 'approval' (chat/store.py's `upsert_imessage_draft`),
                # but it is the SAME stored approval and must close with it.
                self._resolve_attention_locked(
                    d["thread_id"], ATTENTION_KIND_IMESSAGE_DRAFT, request_id, now
                )
            self._conn.commit()
            return d, cur.rowcount == 1

    def _resolve_approval_part(self, thread_id: str, request_id: str, choice: str, now: str) -> None:
        """Close the transcript's own copy of an approval.

        The approvals table and the transcript are two records of the same event.
        Answering only wrote the former, so the `tool_call` part kept
        `state: 'approval_requested'` forever and the card in the thread still read
        "Waiting for your approval" minutes after the user had approved it (2026-09-22).
        The part carries the `request_id` as its `tool_call_id`, which is the join.

        Caller holds the lock and commits; this only stages the writes."""
        rows = self._conn.execute(
            "SELECT p.id, p.message_id, p.idx, p.data FROM parts p "
            "JOIN messages m ON m.id = p.message_id "
            "WHERE m.thread_id=? AND p.type='tool_call' "
            "AND json_extract(p.data, '$.tool_call_id')=? "
            # Only the card itself. The tool's own completion row carries the
            # same id and is not an approval, so stamping it would print
            # "Answered somewhere else" under a plain result.
            "AND json_extract(p.data, '$.state')='approval_requested'",
            (thread_id, request_id),
        ).fetchall()
        for row in rows:
            data = json.loads(row["data"])
            data["state"] = "answered"
            data["resolved_choice"] = choice
            # It was left 'running' while the decision was outstanding; a denial is
            # not a tool error, so both outcomes settle the call rather than fail it.
            data["status"] = "complete"
            self._conn.execute("UPDATE parts SET data=? WHERE id=?", (json.dumps(data), row["id"]))
            seq = self._allocate_seq(thread_id)
            self._touch_message(row["message_id"], seq, now)
            self._append_event(
                thread_id, seq, "part.upsert",
                {"message_id": row["message_id"], "idx": row["idx"], "part": data}, now,
            )

    def set_approval_forward_status(self, *, run_id: str, request_id: str, status: str, reason: str = "") -> None:
        """Phase 3: the answered decision's forward-to-gateway outcome — 'forwarded' on a
        2xx from POST /api/platforms/hub/events, 'pending' + a short reason otherwise —
        plus the `approval.answered` event every subscribed client needs to close the
        card (the phone that answered already knows; the other one does not)."""
        with self._lock:
            row = self._conn.execute(
                "SELECT thread_id, choice FROM approvals WHERE run_id=? AND request_id=?", (run_id, request_id)
            ).fetchone()
            if row is None:
                raise KeyError((run_id, request_id))
            self._conn.execute(
                "UPDATE approvals SET forward_status=?, forward_reason=? WHERE run_id=? AND request_id=?",
                (status, reason, run_id, request_id),
            )
            now = _now_iso()
            seq = self._allocate_seq(row["thread_id"])
            self._append_event(
                row["thread_id"], seq, "approval.answered",
                {"run_id": run_id, "request_id": request_id, "choice": row["choice"], "forward_status": status},
                now,
            )
            self._conn.commit()

    # -- iMessage drafts (the shared first-answer-wins record) --------------------
    def upsert_imessage_draft(
        self,
        *,
        draft_id: int,
        thread_id: str,
        contact: str,
        text: str,
        expires_at_derived: str | None = None,
        summary: str = "",
        thread_title: str | None = "iMessage drafts",
    ) -> dict[str, Any]:
        """Mirror a draft the Mac has created into the Hub: the thread card whose
        `tool_call` part the approval card reads, its centralized needs-you row,
        and the `approvals` row that (run_id, request_id) names. Idempotent on
        `draft_id` — the thread, message, draft row and approval are created once;
        a retried registration refreshes the text only.

        This is the write that makes a draft answerable from every surface at all:
        `answer_approval`'s CAS over the row stored here is what each of them shares."""
        with self._lock:
            self.get_or_create_thread(thread_id, kind="chat", title=thread_title)
            now = _now_iso()
            rid = _imessage_draft_request_id(draft_id)
            base = {"draft_id": draft_id, "run_id": rid, "request_id": rid,
                    "contact": contact, "text": text, "choice": None, "outcome": None, "detail": ""}
            existing = self._conn.execute(
                "SELECT * FROM imessage_drafts WHERE draft_id=?", (draft_id,)
            ).fetchone()
            if existing is None:
                message, _ = self._insert_message_locked(
                    thread_id=thread_id, role="assistant", author_type="agent",
                    parts=_imessage_draft_parts(base), status="complete",
                )
                self._conn.execute(
                    "INSERT INTO imessage_drafts (draft_id, thread_id, message_id, run_id, request_id, "
                    "contact, text, created_at) VALUES (?,?,?,?,?,?,?,?)",
                    (draft_id, thread_id, message["id"], rid, rid, contact, text, now),
                )
                self._conn.commit()
            else:
                # A re-registration only refreshes the words; the card keeps its
                # message and a decision already made is never reopened.
                self._conn.execute(
                    "UPDATE imessage_drafts SET thread_id=?, contact=?, text=? WHERE draft_id=?",
                    (thread_id, contact, text, draft_id),
                )
                self._conn.commit()
                if existing["choice"] is None:
                    row_now = self._conn.execute(
                        "SELECT * FROM imessage_drafts WHERE draft_id=?", (draft_id,)
                    ).fetchone()
                    self._stamp_imessage_draft_card(row_now, now)
                    self._conn.commit()
            # The stored approval is what /api/chat/approval/{challenge,apply}
            # validates against: its frame's `draft_imessage` part supplies the
            # offered choices (once = send, deny = discard). Fetch the row first so
            # the attention row carries the linked `message_id` the client reads
            # the card's tool_call out of.
            row_now = self._conn.execute(
                "SELECT * FROM imessage_drafts WHERE draft_id=?", (draft_id,)
            ).fetchone()
            self.upsert_attention(
                thread_id=thread_id,
                kind=ATTENTION_KIND_IMESSAGE_DRAFT,
                request_id=rid,
                run_id=rid,
                summary=summary or (
                    f"Approve iMessage to {contact}" + (f": “{text[:120]}”" if text else "")
                ),
                expires_at_derived=expires_at_derived,
                message_id=row_now["message_id"],
            )
            self.upsert_approval(
                run_id=rid, request_id=rid, thread_id=thread_id,
                frame={
                    "thread_id": thread_id, "run_id": rid, "role": "assistant",
                    "author_type": "agent", "status": "complete",
                    "parts": _imessage_draft_parts(row_now),
                    "attention": {"kind": ATTENTION_KIND_IMESSAGE_DRAFT, "request_id": rid, "run_id": rid},
                },
                queue_pos=0,
            )
            row = self._conn.execute("SELECT * FROM imessage_drafts WHERE draft_id=?", (draft_id,)).fetchone()
            return dict(row)

    def register_imessage_draft_automation(
        self,
        *,
        draft_id: int,
        contact: str,
        text: str,
        expires_at_derived: str | None = None,
    ) -> dict[str, Any]:
        """Record an AUTOMATION's draft (no chat thread asked for it): a cardless
        `imessage_drafts` row plus the `approvals` CAS row — the same
        first-answer-wins store every surface answers through — but NO thread
        message and NO attention row. The draft's Hub surface is its Decision-Inbox
        card on the home page (server/app.py's `_write_draft_decision`), not a
        chat thread; the anchor thread exists only because the schema wants one.
        Idempotent on `draft_id`."""
        with self._lock:
            self.get_or_create_thread(ATTENTION_THREAD_ANCHOR, kind="chat", title="iMessage drafts (automation)")
            self._conn.execute("UPDATE threads SET archived=1 WHERE id=? AND archived=0", (ATTENTION_THREAD_ANCHOR,))
            now = _now_iso()
            rid = _imessage_draft_request_id(draft_id)
            existing = self._conn.execute(
                "SELECT * FROM imessage_drafts WHERE draft_id=?", (draft_id,)
            ).fetchone()
            if existing is None:
                self._conn.execute(
                    "INSERT INTO imessage_drafts (draft_id, thread_id, message_id, run_id, request_id, "
                    "contact, text, created_at) VALUES (?,?,?,?,?,?,?,?)",
                    (draft_id, ATTENTION_THREAD_ANCHOR, None, rid, rid, contact, text, now),
                )
                self._conn.commit()
            row_now = self._conn.execute(
                "SELECT * FROM imessage_drafts WHERE draft_id=?", (draft_id,)
            ).fetchone()
            self.upsert_approval(
                run_id=rid, request_id=rid, thread_id=ATTENTION_THREAD_ANCHOR,
                frame={
                    "thread_id": ATTENTION_THREAD_ANCHOR, "run_id": rid, "role": "assistant",
                    "author_type": "agent", "status": "complete",
                    "parts": _imessage_draft_parts(row_now),
                    "attention": {"kind": ATTENTION_KIND_IMESSAGE_DRAFT, "request_id": rid, "run_id": rid},
                },
                queue_pos=0,
            )
            row = self._conn.execute("SELECT * FROM imessage_drafts WHERE draft_id=?", (draft_id,)).fetchone()
            return dict(row)

    def get_imessage_draft(self, draft_id: int) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM imessage_drafts WHERE draft_id=?", (draft_id,)).fetchone()
            return dict(row) if row else None

    def get_imessage_draft_by_request(self, request_id: str) -> dict[str, Any] | None:
        """The draft a stored approval names, or None for an ordinary tool
        approval — this is how `chat/approval.py` tells the two apart."""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM imessage_drafts WHERE request_id=?", (request_id,)
            ).fetchone()
            return dict(row) if row else None

    def mark_imessage_draft_outcome(
        self, *, draft_id: int, choice: str, outcome: str, detail: str = ""
    ) -> dict[str, Any] | None:
        """Record the decision (`choice` = once|deny, the approvals CAS's own
        value) and what the Mac then did with a send, then rewrite the thread card
        to state it. Called only AFTER `answer_approval` has returned applied=True
        (or on a deliberate retry of an unsent approve); it does not itself decide
        anything, so it can never race the CAS."""
        with self._lock:
            row = self._conn.execute("SELECT * FROM imessage_drafts WHERE draft_id=?", (draft_id,)).fetchone()
            if row is None:
                return None
            now = _now_iso()
            self._conn.execute(
                "UPDATE imessage_drafts SET choice=?, outcome=?, detail=?, answered_at=? WHERE draft_id=?",
                (choice, outcome, str(detail)[:400], now, draft_id),
            )
            self._conn.commit()
            row = self._conn.execute("SELECT * FROM imessage_drafts WHERE draft_id=?", (draft_id,)).fetchone()
            self._stamp_imessage_draft_card(row, now)
            self._conn.commit()
            return dict(row)

    def _stamp_imessage_draft_card(self, row: Any, now: str) -> None:
        """CALLER MUST HOLD `_lock` and commit. The draft's own message is rewritten
        in place — the same one-row-updated rule an answered approval card follows.
        The rebuilt `tool_call` part keeps `state='answered'` once a choice exists,
        so restamping never un-answers the card."""
        message_id = row["message_id"]
        if not message_id:
            return
        if self._conn.execute("SELECT 1 FROM messages WHERE id=?", (message_id,)).fetchone() is None:
            return
        parts = _imessage_draft_parts(row)
        self._conn.execute("DELETE FROM parts WHERE message_id=?", (message_id,))
        for idx, part in enumerate(parts):
            self._conn.execute(
                "INSERT INTO parts (message_id, idx, type, data, created_at) VALUES (?,?,?,?,?)",
                (message_id, idx, part["type"], json.dumps(part), now),
            )
        seq = self._allocate_seq(row["thread_id"])
        self._touch_message(message_id, seq, now)
        self._append_event(row["thread_id"], seq, "message.upsert", self._upsert_payload(message_id), now)

    # -- media ------------------------------------------------------------------
    def chat_media_total_bytes(self) -> int:
        """Accounted from the DB, not a filesystem walk — accurate as long as nothing
        deletes media files out-of-band, and O(1) instead of O(files) per upload."""
        with self._lock:
            row = self._conn.execute("SELECT COALESCE(SUM(size_bytes), 0) AS total FROM media").fetchone()
            return int(row["total"])

    def insert_media(
        self, *, thread_id: str, mime: str, raw: bytes, origin: str, width: int | None = None, height: int | None = None
    ) -> dict[str, Any]:
        with self._lock:
            self.get_or_create_thread(thread_id)
            now = _now_iso()
            media_id = f"med_{secrets.token_hex(8)}"
            ext = _EXT_BY_MIME.get(mime, "bin")
            thread_dir = self.media_dir / thread_id
            thread_dir.mkdir(parents=True, exist_ok=True)
            # Defense in depth alongside the file's own 0640 below: if HUB_CHAT_MEDIA_DIR
            # is ever pointed outside db_path.parent (which __init__ already locks to
            # 0700), this is what stops the directory listing itself leaking thread ids.
            thread_dir.chmod(0o700)
            path = thread_dir / f"{media_id}.{ext}"
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_bytes(raw)
            tmp.chmod(0o640)
            tmp.replace(path)
            self._conn.execute(
                "INSERT INTO media (id, thread_id, mime, size_bytes, width, height, origin, storage_path, created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (media_id, thread_id, mime, len(raw), width, height, origin, str(path), now),
            )
            self._conn.commit()
            row = self._conn.execute("SELECT * FROM media WHERE id=?", (media_id,)).fetchone()
            return dict(row)

    def get_media(self, media_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM media WHERE id=?", (media_id,)).fetchone()
            return dict(row) if row else None
