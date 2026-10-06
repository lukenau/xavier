"""Hub chat cookie-gated reads — VERDICT-V2 §9's "bootstrap (threads + per-thread
cursors), thread list, thread detail, mark-read" — plus `/send`, the one write a
human-typed message needs, and `/commands`, the `/`-picker's catalog read
(VERDICT-V2 §4.6.2/§4.6.3). All of it is gated by the `hub_chat_session` cookie from
chat/session.py, never by WebAuthn/device-key — re-prompting Face ID to open the
Threads tab, scroll a transcript, or send a plain message would make the app
unusable. The FRESH-SIGNATURE write gate is reserved for the high-consequence case
only — `/api/chat/approval/*` (T3, VERDICT-V2 §7) — never for a send, which
VERDICT-V2 §3 is explicit rides the hourly cookie like everything else here.

`GET /commands` serves whatever `POST /api/platform/hub/commands` (chat/platform.py)
last persisted to `COMMAND_CATALOG_FILE`, tagged `source: "live"`. The gateway's Hub
adapter (hermes-plugin/) pushes its live catalog when it registers; until the first
push lands on a fresh install, this route falls back to the repo-shipped
`command_catalog_bootstrap.json`, tagged `source: "bootstrap"`, so the app's `/` picker
is never empty on day one. That file is a small, hand-authored, generic sample of the
wire format — it carries no deployment's real commands. The live push always wins
permanently once it exists; see the route's own docstring for the exact fail-open rule.

The approval routes (`/api/chat/approval/{challenge,apply}`) live in chat/approval.py.
The WebSocket (`/api/chat/ws`) is chat/ws.py, a separate file for the reason its own
docstring gives (auth-in-handler, since `@app.middleware("http")` never runs on a
WebSocket scope).

`/send` records the message durably first, then forwards it to the gateway's
platform-events callback (`POST {HERMES_API_BASE}/api/platforms/hub/events`, signed
with the platform key), which the Hub adapter's `verify_http_event_request` /
`dispatch_http_event` turn into a normal agent turn. Forwarding is best-effort and
layered on top: with no gateway configured, no platform key, or the gateway down, the
message is still accepted and its forward is recorded as "pending" — never a
precondition for accepting what the user typed.
"""
from __future__ import annotations

import base64
import binascii
import json
import os
import re
import secrets
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

from chat import notify as chat_notify
from chat.platform import (
    COMMAND_CATALOG_FILE,
    MAX_TITLE_LEN,
    MAX_MEDIA_DECODED_BYTES,
    MAX_MEDIA_TOTAL_BYTES,
    _ALLOWED_MEDIA_MIMES,
    _hub_platform_key,
    get_store,
)
from chat.session import chat_session_valid, locked_gate_detail


# The bootstrap placeholder shipped in the repo next to this file — a small,
# hand-authored sample of the catalogue wire format, not generated from any live
# deployment. Never env-overridable (unlike COMMAND_CATALOG_FILE, this one isn't
# per-deployment state); the first live push permanently supersedes it.
COMMAND_CATALOG_BOOTSTRAP_FILE = Path(__file__).with_name("command_catalog_bootstrap.json")

# The gateway forward target for `/send` — same env-var names as app.py's own
# HERMES_API_BASE/HERMES_API_KEY (`_hermes_get`), read directly here rather than
# imported from `app`: app.py imports this module's router (line ~59) before those
# names exist as attributes of `app` (line ~79) — the same import-time-ordering
# reason chat/session.py's module docstring gives for duplicating its own gate glue
# instead of importing it back from `app`.
HERMES_API_BASE = os.environ.get("HERMES_API_BASE", "")
HERMES_API_KEY = os.environ.get("HERMES_API_KEY", "")
HUB_CHAT_SEND_FORWARD_TIMEOUT_S = float(os.environ.get("HUB_CHAT_SEND_FORWARD_TIMEOUT_S", "3"))

MAX_SEND_TEXT_LEN = 8000
MAX_SEND_MEDIA = 4
MAX_AUTO_TITLE_LEN = 48
_CLIENT_MSG_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_MEDIA_ID_RE = re.compile(r"^med_[0-9a-f]{16}$")


def _require_chat_session(hub_chat_session: str | None) -> None:
    if chat_session_valid(hub_chat_session):
        return
    # Two states used to share one message ("chat locked — unlock with Face ID"),
    # which on a fresh install named a credential the user did not have. The helper
    # tells the two apart: no credential yet -> 412 no_passkey (enrol); a lapsed
    # session with a credential on file -> 401 chat_locked (re-authenticate).
    status, detail = locked_gate_detail("chat")
    raise HTTPException(status_code=status, detail=detail)


def _chat_session_dep(hub_chat_session: str | None = Cookie(default=None)) -> None:
    _require_chat_session(hub_chat_session)


# Router-level for the same reason as chat/platform.py's key dependency: the cookie
# check has to run before body validation, or a locked client gets a 422 schema
# lecture instead of the 401 that tells it to unlock.
router = APIRouter(prefix="/api/chat", tags=["hub-chat"], dependencies=[Depends(_chat_session_dep)])


def _auto_title(text: str) -> str | None:
    """A thread's name, taken from the first thing said in it that is worth
    naming it after — every new thread read "Chat" otherwise (the user,
    2026-09-22). First line, collapsed whitespace, cut on a word boundary.

    `None` for an opener too thin to name a conversation: two threads both came
    out as "hello". The thread stays unnamed and the next real message names it,
    which is why this is checked on EVERY send rather than only the first.
    Deliberately not an LLM call — naming must not cost a turn."""
    first = " ".join(text.strip().splitlines()[0].split())
    if len(first) < 16 and len(first.split()) < 3:
        return None
    if len(first) <= MAX_AUTO_TITLE_LEN:
        return first
    cut = first[:MAX_AUTO_TITLE_LEN].rsplit(" ", 1)[0]
    return f"{cut or first[:MAX_AUTO_TITLE_LEN]}…"


def _thread_payload(t: dict[str, Any], last_read_seq: int, unread: int) -> dict[str, Any]:
    """`preview`/`preview_role` are present only on rows read through the store's
    thread-summary query (`list_threads` / `get_thread_summary`); a row straight
    from `get_or_create_thread` has nothing said in it yet, so None is the truth
    either way."""
    return {
        "id": t["id"],
        "kind": t["kind"],
        "title": t["title"],
        "status": t["status"],
        "pinned": bool(t["pinned"]),
        "archived": bool(t["archived"]),
        "last_seq": t["last_seq"],
        "created_at": t["created_at"],
        "updated_at": t["updated_at"],
        "last_read_seq": last_read_seq,
        "unread": unread,
        "preview": t.get("preview"),
        "preview_role": t.get("preview_role"),
        "hermes_session_id": t["hermes_session_id"],
        "origin_thread_id": t["origin_thread_id"],
        "origin_message_id": t["origin_message_id"],
        "origin_run_id": t.get("origin_run_id"),
        "working": bool(t.get("working")),
    }


@router.get("/bootstrap")
def chat_bootstrap() -> dict[str, Any]:
    """Cold-start / reconnect payload: every thread's summary + cursor (`last_seq`) and
    read state, so the client knows what to render and where to open each thread's WS
    subscription from — `after_seq=last_seq` catches it up to nothing-missed, a lower
    stored `last_read_seq` resumes from there — without a per-thread round trip first."""
    threads = get_store().list_threads()
    return {"threads": [_thread_payload(t, t["last_read_seq"], t["unread"]) for t in threads]}


@router.get("/threads")
def chat_threads() -> dict[str, Any]:
    """The Threads-tab list. Same underlying query as bootstrap (`ChatStore.list_threads`)
    — this slice has no reason yet for the two to diverge. Kept as a separate route
    because the client's cold-start call site and its pull-to-refresh call site are
    different, and bootstrap is the one a later slice (WS reconnect) may need to grow
    independently — e.g. folding in attention rows bootstrap-only."""
    threads = get_store().list_threads()
    return {"threads": [_thread_payload(t, t["last_read_seq"], t["unread"]) for t in threads]}


class CreateThreadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = None

    @model_validator(mode="after")
    def _bounds(self) -> "CreateThreadRequest":
        if self.title is not None and len(self.title) > MAX_TITLE_LEN:
            raise ValueError(f"title over {MAX_TITLE_LEN} chars")
        return self


@router.post("/threads")
def chat_thread_create(req: CreateThreadRequest) -> dict[str, Any]:
    """the user starting a conversation himself — the one thread-creating path that is
    not a gateway delivery. VERDICT-V2 §4.2's "created lazily on the normal adapter
    path" is about the GATEWAY never pre-seeding sessions; it left the human with no
    way to open a thread at all, which is what the prototype's `New` button in the
    thread-list header always implied. Ids are minted here, server-side, in the same
    `thr_<hex>` shape the platform route accepts, so a client can never choose one
    and collide with (or hijack) a delivery target like `ops`."""
    store = get_store()
    thread = store.get_or_create_thread(
        f"thr_{secrets.token_hex(8)}", kind="chat", title=(req.title or None)
    )
    return {"thread": _thread_payload(thread, 0, 0)}


@router.get("/threads/{thread_id}")
def chat_thread_detail(
    thread_id: str,
    after_seq: int = 0,
    limit: int = 200,
    before_seq: int | None = None,
) -> dict[str, Any]:
    """One thread's metadata + message history. Never lazily creates the thread — that
    is the platform ingest path's job (`get_or_create_thread`, chat/platform.py); a
    read for an unknown thread_id is an honest 404."""
    store = get_store()
    thread = store.get_thread_summary(thread_id)
    if thread is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "detail": f"no thread {thread_id!r}"})
    messages = store.list_messages(
        thread_id, after_seq=after_seq, limit=min(max(limit, 1), 500), before_seq=before_seq
    )
    return {
        "thread": _thread_payload(thread, thread["last_read_seq"], thread["unread"]),
        "messages": messages,
        "attention": store.thread_open_attention(thread_id),
    }


class ThreadPatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pinned: bool | None = None
    archived: bool | None = None
    title: str | None = None

    @model_validator(mode="after")
    def _bounds(self) -> "ThreadPatchRequest":
        if self.pinned is None and self.archived is None and self.title is None:
            raise ValueError("nothing to patch")
        if self.title is not None:
            self.title = self.title.strip()
            if not self.title:
                raise ValueError("title must be non-empty")
            if len(self.title) > MAX_TITLE_LEN:
                raise ValueError(f"title over {MAX_TITLE_LEN} chars")
        return self


@router.post("/threads/{thread_id}/patch")
def chat_thread_patch(thread_id: str, req: ThreadPatchRequest) -> dict[str, Any]:
    """Pin / rename / archive — the thread menu's three actions. Hub-owned, cheap
    and reversible, so cookie-gated like mark-read and never WebAuthn (module
    docstring: the FRESH-SIGNATURE gate is for estate-wide consequence only).
    Never lazily creates the thread, same rule as every other read/write here.

    POST, not PATCH, because app.py's `reject_non_get_outside_auth` middleware
    405s every method but GET and POST before a route ever sees it. Named for the
    `thread.patch` frame it emits."""
    thread = get_store().patch_thread(
        thread_id, pinned=req.pinned, archived=req.archived, title=req.title
    )
    if thread is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "detail": f"no thread {thread_id!r}"})
    return {"thread": _thread_payload(thread, thread["last_read_seq"], thread["unread"])}


@router.post("/threads/{thread_id}/stop")
def chat_thread_stop(thread_id: str) -> dict[str, Any]:
    """Stop the turn in flight in this thread.

    Cookie-gated, not WebAuthn: stopping is cheap, reversible and the user's own
    (the FRESH-SIGNATURE gate is for estate-wide consequence). The gateway does
    the work — its `/stop` command carries `busy_policy:
    interrupt_then_dispatch`, so a running turn is interrupted and then the
    command runs — and the adapter reports whether there was a turn at all, so
    the button can say "nothing to stop" rather than claim it stopped
    something.

    A thread that has never been delivered to has no session to stop, which is
    a 404, not a silent success."""
    store = get_store()
    if store.get_thread(thread_id) is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "detail": f"no thread {thread_id!r}"})
    status, reason = forward_gateway_event({"kind": "stop", "thread_id": thread_id})
    if status != "forwarded":
        raise HTTPException(
            status_code=502,
            detail={"code": "gateway_unreachable", "detail": reason or "the gateway did not answer"},
        )
    return {"status": "ok", "thread_id": thread_id}


class ClarifyAnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    thread_id: str
    response: str = Field(min_length=1, max_length=4000)


@router.post("/clarify/{clarify_id}")
def chat_clarify_answer(clarify_id: str, req: ClarifyAnswerRequest) -> dict[str, Any]:
    """Answer the question the agent is parked on.

    This is NOT a chat message and must never become one. The gateway's clarify
    call is blocked on an event waiting for exactly this id, and
    `resolve_gateway_clarify` hands the answer straight back as the tool's
    result — the mechanism Discord's buttons have used in production. Routing it
    through `/send` instead would start a second turn and leave the first one
    parked until it timed out.

    Cookie-gated like `/send`: answering a question is the user's own conversation,
    not an estate-wide write. The thread must exist, because an answer for a
    thread this Hub has never seen is a malformed client, not a new thread."""
    if get_store().get_thread(req.thread_id) is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "detail": f"no thread {req.thread_id!r}"})
    status, reason = forward_gateway_event({
        "kind": "clarify_response",
        "thread_id": req.thread_id,
        "clarify_id": clarify_id,
        "response": req.response,
    })
    if status != "forwarded":
        raise HTTPException(
            status_code=502,
            detail={"code": "gateway_unreachable", "detail": reason or "the gateway did not answer"},
        )
    get_store().resolve_attention(thread_id=req.thread_id, kind="question", request_id=clarify_id)
    return {"status": "ok", "clarify_id": clarify_id}


class MarkReadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    seq: int


@router.post("/threads/{thread_id}/read")
def chat_thread_read(
    thread_id: str,
    req: MarkReadRequest,
) -> dict[str, Any]:
    """Advance the thread's read cursor. Cheap, reversible, Hub-owned state — cookie-
    gated like every route in this file, never WebAuthn (VERDICT-V2 §4.2: the gateway's
    own unread watermark is write-only over HTTP and is never read back)."""
    try:
        return get_store().mark_read(thread_id=thread_id, seq=req.seq)
    except KeyError:
        raise HTTPException(status_code=404, detail={"code": "not_found", "detail": f"no thread {thread_id!r}"})


MAX_ATTENTION_LIMIT = 200


@router.get("/attention")
def chat_attention(limit: int = 100) -> dict[str, Any]:
    """Everything waiting on the user, across every thread, newest first (A13).

    The only cross-thread attention read there is: `/bootstrap` and
    `/threads/{id}` each carry a thread's own rows, so "what is waiting on me"
    was otherwise a question you could only answer by opening every thread in
    turn (the app's chat hooks say exactly that). Cookie-gated at the
    router like every other read here — an attention row names what the agent is
    blocked on, which is not public.

    Rows carry the thread's title and kind alongside the row's own fields so the
    inbox can name each one and navigate to it from this single read. Nothing is
    derived here that the row does not already hold: there is no cost, no
    priority and no snooze state on the table, so none is served."""
    rows = get_store().list_open_attention(limit=min(max(limit, 1), MAX_ATTENTION_LIMIT))
    return {"attention": rows}


def _load_bootstrap_catalog() -> dict[str, Any]:
    """Read-only load of the shipped placeholder. Not cached module-globally on purpose —
    this file changes only via a manual edit-and-redeploy, so re-reading it per request
    (same cost class as the live-catalog read just above) keeps this route free of any
    process-lifetime staleness to reason about, at a cost that's a single small local
    JSON parse, not an I/O concern worth optimizing away."""
    raw = json.loads(COMMAND_CATALOG_BOOTSTRAP_FILE.read_text())
    return {"version": raw["version"], "commands": raw["commands"]}


@router.get("/commands")
def chat_commands() -> dict[str, Any]:
    """The live slash-command catalog (VERDICT-V2 §4.6.2/§4.6.3) — cookie-gated like
    every other read in this file. Serves whatever `POST /api/platform/hub/commands`
    (chat/platform.py) last wrote, tagged `source: "live"`. Before the gateway's Hub
    adapter has ever pushed (COMMAND_CATALOG_FILE missing, unreadable, or corrupt —
    the same fail-open posture platform.py's own version check already uses), falls
    back to the repo-shipped bootstrap placeholder (command_catalog_bootstrap.json,
    a hand-authored generic sample of the wire format), tagged `source: "bootstrap"`,
    so the app never sees an empty picker on a freshly deployed hub-api. The instant a
    live push lands, this route reads that file instead — permanently, since platform.py
    never deletes it — so the bootstrap fallback only ever fires pre-first-push."""
    try:
        raw = json.loads(COMMAND_CATALOG_FILE.read_text())
        return {"version": int(raw["version"]), "commands": raw["commands"], "source": "live"}
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        bootstrap = _load_bootstrap_catalog()
        return {"version": bootstrap["version"], "commands": bootstrap["commands"], "source": "bootstrap"}


class SendMessageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = ""
    client_msg_id: str
    # The composer's Queue / Steer / Redirect chip. The gateway decides what to do
    # with a message that lands mid-turn from its own `_busy_text_mode`, and the
    # adapter sets that from this field (hub_wire.BUSY_MODE_ALIASES). Absent means
    # "leave the gateway's own setting alone", which is what every client that
    # predates the chip sends.
    mode: Literal["queue", "steer", "redirect"] | None = None
    # Images the user attached, uploaded first through POST /threads/{id}/media — ids
    # only; the bytes are already in the store and ride to the gateway from there.
    media_ids: list[str] = []

    @model_validator(mode="after")
    def _bounds(self) -> "SendMessageRequest":
        if len(self.media_ids) > MAX_SEND_MEDIA:
            raise ValueError(f"at most {MAX_SEND_MEDIA} media per message")
        if any(not _MEDIA_ID_RE.match(m) for m in self.media_ids):
            raise ValueError("malformed media id")
        if not self.text.strip() and not self.media_ids:
            raise ValueError("text must be non-empty")
        if len(self.text) > MAX_SEND_TEXT_LEN:
            raise ValueError(f"text over {MAX_SEND_TEXT_LEN} chars")
        if not _CLIENT_MSG_ID_RE.match(self.client_msg_id):
            raise ValueError(f"client_msg_id must match {_CLIENT_MSG_ID_RE.pattern}")
        return self


def forward_gateway_event(payload: dict[str, Any]) -> tuple[str, str]:
    """POST one event to the gateway's platform-events callback
    (`POST /api/platforms/hub/events`), signed with the SAME HUB_PLATFORM_KEY the
    /api/platform/hub/* routes check — the hub adapter's `verify_http_event_request`
    is the other half. Never raises. Returns (status, reason): "forwarded" on a 2xx,
    otherwise "pending" with a fixed short reason — never the exception text or the
    URL, since callers store this where a client later reads it back."""
    if not HERMES_API_BASE:
        return "pending", "gateway not configured"
    platform_key = _hub_platform_key()
    if not platform_key:
        return "pending", "platform key unprovisioned"
    req = urllib.request.Request(
        f"{HERMES_API_BASE}/api/platforms/hub/events",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {platform_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=HUB_CHAT_SEND_FORWARD_TIMEOUT_S) as resp:
            if 200 <= resp.status < 300:
                return "forwarded", ""
            return "pending", f"gateway responded {resp.status}"
    except urllib.error.HTTPError as exc:
        # `exc.code` alone is safe to record; the body is deliberately never read into
        # a field a client reads back.
        return "pending", f"gateway returned {exc.code}"
    except (urllib.error.URLError, OSError, TimeoutError, ValueError):
        return "pending", "gateway unreachable"


def ask_gateway(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Like `forward_gateway_event`, but for the one event whose ANSWER is the
    point (the subagent transcript). None when the gateway could not answer —
    the card then says so rather than showing an empty child."""
    if not HERMES_API_BASE:
        return None
    platform_key = _hub_platform_key()
    if not platform_key:
        return None
    req = urllib.request.Request(
        f"{HERMES_API_BASE}/api/platforms/hub/events",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {platform_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=HUB_CHAT_SEND_FORWARD_TIMEOUT_S) as resp:
            if not 200 <= resp.status < 300:
                return None
            body = json.loads(resp.read().decode())
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, TimeoutError, ValueError):
        return None
    return body if isinstance(body, dict) else None


def _forward_send_to_gateway(
    *, thread_id: str, message_id: str, client_msg_id: str, seq: int, text: str, media: list[dict[str, Any]],
    mode: str | None = None,
    notes: list[str] | None = None,
) -> tuple[str, str]:
    """The human message, with any attached images as base64 (VERDICT-V2 §4.4: the
    bytes ride the JSON body into the gateway process, which caches them itself)."""
    payload: dict[str, Any] = {
        "kind": "message",
        "platform": "hub",
        "chat_type": "dm",
        "thread_id": thread_id,
        "message_id": message_id,
        "client_msg_id": client_msg_id,
        "seq": seq,
        "text": text,
    }
    if mode:
        payload["mode"] = mode
    # Things that happened in the thread while Assistant was not being spoken to —
    # a checklist item ticked, say. They ride with the next message instead of
    # each waking a turn of its own, and they are never shown in the Hub: the user's
    # bubble says what he typed.
    if notes:
        payload["context_note"] = "\n".join(notes)
    if media:
        payload["media"] = media
    return forward_gateway_event(payload)


@router.post("/threads/{thread_id}/send")
def chat_thread_send(
    thread_id: str,
    req: SendMessageRequest,
) -> dict[str, Any]:
    """The one missing leg for a human-typed message. Records it durably and
    immediately via the existing `insert_message` (it is the user's own words — it must
    never be lost, forward leg or no), ATTEMPTS the forward, then records the truthful
    outcome. Cookie-gated like every route in this file, never WebAuthn — a plain send
    is not the estate-wide-consequence write `/api/chat/approval/*` guards (module
    docstring).

    Idempotent on `client_msg_id` via `insert_message`'s own partial UNIQUE index: a
    retried send from a flaky phone connection returns the SAME message, not a second
    row — and the forward is attempted only on the genuine first insert, never
    re-attempted on a dedup hit, so a client-side retry can never cause a second
    dispatch into a live turn once phase 3 makes that dispatch real.

    Never lazily creates the thread — same rule as `chat_thread_detail`; the app only
    ever sends into a thread it already has from a bootstrap/detail read."""
    store = get_store()
    if store.get_thread(thread_id) is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "detail": f"no thread {thread_id!r}"})
    parts: list[dict[str, Any]] = []
    if req.text.strip():
        parts.append({"type": "text", "text": req.text})
    media_payload: list[dict[str, Any]] = []
    for media_id in req.media_ids:
        row = store.get_media(media_id)
        # A media row from another thread, or one the gateway uploaded, is not the user's
        # attachment — 404 rather than silently forwarding someone else's bytes.
        if row is None or row["thread_id"] != thread_id or row["origin"] != "user":
            raise HTTPException(status_code=404, detail={"code": "media_not_found", "detail": "unknown media id"})
        parts.append({"type": "image", "media_id": media_id, "mime": row["mime"],
                      "width": row["width"], "height": row["height"]})
        try:
            raw = Path(row["storage_path"]).read_bytes()
        except OSError:
            raise HTTPException(status_code=404, detail={"code": "media_not_found", "detail": "unknown media id"})
        media_payload.append({"media_id": media_id, "mime": row["mime"], "data_b64": base64.b64encode(raw).decode("ascii")})
    message, created = store.insert_message(
        thread_id=thread_id,
        role="user",
        author_type="human",
        parts=parts,
        client_msg_id=req.client_msg_id,
    )
    if created:
        title = _auto_title(req.text) if req.text.strip() else None
        if title:
            store.set_thread_title(thread_id, title)
        notes = store.drain_agent_notes(thread_id)
        status, reason = _forward_send_to_gateway(
            thread_id=thread_id,
            message_id=message["id"],
            client_msg_id=req.client_msg_id,
            seq=message["seq"],
            text=req.text,
            media=media_payload,
            mode=req.mode,
            notes=notes,
        )
        store.set_message_forward_status(message["id"], status=status, reason=reason)
        message["forward_status"] = status
        message["forward_reason"] = reason
        if status != "forwarded":
            # The notes were drained for a message the gateway never took;
            # they belong to the next one that gets through.
            for note in notes:
                store.note_for_agent(thread_id, note)
    return {"message": message, "deduped": not created}


class MediaUploadRequest(BaseModel):
    """the user's own image attachment. Same JSON+base64 contract and caps as the
    gateway-side upload (chat/platform.py MediaUploadRequest), origin fixed to
    "user" here — the platform route can only ever mint "agent" rows."""
    model_config = ConfigDict(extra="forbid")

    mime: Literal["image/png", "image/jpeg", "image/webp", "image/gif"]
    data_b64: str
    width: int | None = None
    height: int | None = None


@router.post("/threads/{thread_id}/media")
def chat_thread_media_upload(thread_id: str, req: MediaUploadRequest) -> dict[str, Any]:
    store = get_store()
    if store.get_thread(thread_id) is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "detail": f"no thread {thread_id!r}"})
    try:
        raw = base64.b64decode(req.data_b64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail={"code": "bad_base64", "detail": "data_b64 is not valid base64"})
    if not raw:
        raise HTTPException(status_code=400, detail={"code": "empty_media", "detail": "no image bytes"})
    if len(raw) > MAX_MEDIA_DECODED_BYTES:
        raise HTTPException(status_code=413, detail={"code": "media_too_large", "detail": f"over {MAX_MEDIA_DECODED_BYTES} bytes"})
    if store.chat_media_total_bytes() + len(raw) > MAX_MEDIA_TOTAL_BYTES:
        raise HTTPException(status_code=507, detail={"code": "media_storage_full", "detail": "chat media storage cap reached"})
    row = store.insert_media(thread_id=thread_id, mime=req.mime, raw=raw, origin="user", width=req.width, height=req.height)
    return {"status": "ok", "media_id": row["id"], "size_bytes": row["size_bytes"]}


@router.get("/media/{media_id}")
def chat_media_get(media_id: str) -> Response:
    """The bytes behind an image part, either direction. Cookie-gated like every
    read here; ids are unguessable (64 random bits) but the gate is what keeps a
    transcript image from being a public URL."""
    if not _MEDIA_ID_RE.match(media_id):
        raise HTTPException(status_code=404, detail={"code": "media_not_found", "detail": "unknown media id"})
    row = get_store().get_media(media_id)
    if row is None or row["mime"] not in _ALLOWED_MEDIA_MIMES:
        raise HTTPException(status_code=404, detail={"code": "media_not_found", "detail": "unknown media id"})
    try:
        raw = Path(row["storage_path"]).read_bytes()
    except OSError:
        raise HTTPException(status_code=404, detail={"code": "media_not_found", "detail": "unknown media id"})
    return Response(
        content=raw,
        media_type=row["mime"],
        headers={"Cache-Control": "private, max-age=31536000, immutable", "Content-Length": str(len(raw))},
    )


# --- presence ----------------------------------------------------------------
#
# "it should only do it when i leave the app but messages are still sending in
# the background" (the user, 2026-09-22). The app is the only thing that knows, so
# it says so: `active` when it comes to the foreground, `background` when it
# leaves. Inferring it from the WebSocket would be guessing — iOS holds a
# suspended socket open for a while after the app goes away, which is exactly
# the window in which a reply lands and the notification matters.
class PresenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    state: Literal["active", "background"]


@router.post("/presence")
def set_presence(req: PresenceRequest) -> dict[str, Any]:
    return chat_notify.set_presence(req.state)


# --- subagent transcript (L71) -----------------------------------------------
#
# "like in claude code terminal you can click on a subagent and see their chat
# window to see text and tool calls" (the user, 2026-09-22). The child's messages
# are not in this database — nothing about a subagent's own turn reaches the
# Hub beyond its start and stop — so this asks the gateway, which reads them
# out of its own state.db.
#
# A thread may only ask for a subagent it actually ran: the id is checked
# against the `delegate_task` part this thread already stored, not taken on
# trust from the client.
@router.get("/threads/{thread_id}/subagent/{child_session_id}")
def subagent_transcript(thread_id: str, child_session_id: str) -> dict[str, Any]:
    store = get_store()
    if store.get_thread(thread_id) is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "detail": "no such thread"})
    if not store.thread_has_subagent(thread_id, child_session_id):
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "detail": "this thread did not run that subagent"},
        )
    answer = ask_gateway({
        "kind": "subagent_transcript",
        "platform": "hub",
        "thread_id": thread_id,
        "child_session_id": child_session_id,
    })
    if answer is None or not answer.get("ok"):
        raise HTTPException(
            status_code=503,
            detail={"code": "unavailable", "detail": "the gateway could not read that subagent"},
        )
    return {
        "child_session_id": child_session_id,
        "parts": answer.get("parts") or [],
        "truncated": bool(answer.get("truncated")),
    }


# --- interactive checklists (2026-09-22) --------------------------------------
#
# "make check list widgets interactive too and have them update the underlying
# data on change or something" (the user). The tick is written into the widget
# part, so it is what every client reads back, and a note is parked for Assistant
# rather than waking him for a checkbox.
class ChecklistTickRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message_id: str
    part_index: int = Field(ge=0, le=64)
    item_index: int = Field(ge=0, le=256)
    state: Literal["todo", "doing", "done", "blocked"]


@router.post("/threads/{thread_id}/checklist")
def tick_checklist(thread_id: str, req: ChecklistTickRequest) -> dict[str, Any]:
    store = get_store()
    if store.get_thread(thread_id) is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "detail": "no such thread"})
    ticked = store.set_checklist_item(
        thread_id=thread_id,
        message_id=req.message_id,
        part_index=req.part_index,
        item_index=req.item_index,
        state=req.state,
    )
    if ticked is None:
        raise HTTPException(
            status_code=404, detail={"code": "not_found", "detail": "no checklist item there"}
        )
    store.note_for_agent(thread_id, f"the user marked \"{ticked['label']}\" as {ticked['state']} on your checklist.")
    return {"status": "ok", **ticked}
