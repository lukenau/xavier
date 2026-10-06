"""The two-way platform boundary between hub-api and the assistant gateway's Hub
adapter (the plugin in hermes-plugin/).

Every route here is under `/api/platform/hub/` (added to `POST_ALLOWLIST_PREFIXES` in
app.py), all authenticated by the SAME shared secret `HUB_PLATFORM_KEY` compared with
`hmac.compare_digest`. There is deliberately **no env-var fallback for the secret
itself**: `docker exec hub-api env` is visible to more than this key's threat model
assumes, so the key is read from its file ONLY. Only the file's *path* is
env-overridable (for tests), never the key value.

This is NOT WebAuthn and NOT a device-key proof — those gate the user's own writes from a
human holding a passkey or an enrolled phone. A background gateway process cannot
present Face ID, so it gets a different class of credential: a bearer secret provisioned
on the host, compared in constant time, scoped to these routes (and the few app.py
routes that reuse `_platform_key_dep` / `platform_key_valid` by name) and nothing under
`/api/action/*`, `/api/passkey/*`, or `/api/decisions/*`.

Routes:
  POST /api/platform/hub/deliver  — one adapter send()/edit_message() call = one message
                                     (with parts), optionally opening/updating an
                                     attention row (approval, clarify, etc).
  POST /api/platform/hub/media    — bytes for a locally-produced image the agent wants
                                     to relay (JSON + base64; hub-api has neither
                                     python-multipart nor Pillow — no shape validation
                                     beyond size and a mime allowlist, a named limitation).
  POST /api/platform/hub/commands — the live slash-command catalog push (VERDICT-V2
                                     §4.6.2), cached to a small JSON file and versioned
                                     so a stale re-push never clobbers a newer catalog.
                                     Serving it to the app is a later slice.
  POST /api/platform/hub/title    — rename a thread, overwriting the name it already
                                     has (L50). Lives here and not in chat/routes.py
                                     because the caller is the re-titling cron job, a
                                     background agent with no Face ID to present —
                                     exactly the credential class this file exists for.
                                     A title is thread metadata the platform key can
                                     already set at creation (`DeliverRequest.title`),
                                     not a "user" row, which stays unmintable here.
  GET  /api/platform/hub/title-review — the one cheap read that job makes: threads whose
                                     conversation has moved on since they were named,
                                     with the tail of what was said since.
"""
from __future__ import annotations

import base64
import binascii
import hmac
import asyncio
import json
import logging
import os
import re
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, ConfigDict, model_validator

from chat import notify as chat_notify
from chat.automation_store import AutomationStore, delivery_thread_id, job_of, valid_job_id, valid_run_id
from chat.store import PART_TYPES, TITLE_REVIEW_MIN_MESSAGES, ChatStore

logger = logging.getLogger(__name__)


# --- secret ------------------------------------------------------------------
# Container path /data/hub-platform/HUB_PLATFORM_KEY: keep it 0640 and readable by the
# container's uid. Only the path is env-overridable; the key value is never read from
# an env var.
HUB_PLATFORM_KEY_FILE = Path(os.environ.get("HUB_PLATFORM_KEY_FILE", "/data/hub-platform/HUB_PLATFORM_KEY"))


def _hub_platform_key() -> str:
    try:
        return HUB_PLATFORM_KEY_FILE.read_text().strip()
    except OSError:
        return ""


def _require_hub_platform_key(authorization: str | None) -> None:
    expected = _hub_platform_key()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail={"code": "hub_platform_key_unprovisioned", "detail": "HUB_PLATFORM_KEY not provisioned"},
        )
    presented = authorization[7:].strip() if authorization and authorization.startswith("Bearer ") else ""
    if not presented or not hmac.compare_digest(presented, expected):
        raise HTTPException(status_code=401, detail={"code": "hub_platform_key_invalid", "detail": "bad platform key"})


def _platform_key_dep(authorization: str | None = Header(default=None)) -> None:
    _require_hub_platform_key(authorization)


def platform_key_valid(authorization: str | None) -> bool:
    """The same check as `_require_hub_platform_key`, as a yes/no for a route that also
    accepts another credential. An unprovisioned key is simply "no"."""
    expected = _hub_platform_key()
    presented = authorization[7:].strip() if authorization and authorization.startswith("Bearer ") else ""
    return bool(expected and presented) and hmac.compare_digest(presented, expected)


# Router-level, not in-handler: FastAPI resolves dependencies before it parses the
# body, so an unauthenticated `{}` is a 401 here rather than a 422 spelling out the
# request schema to whoever can reach 8090 through the tailnet /api proxy.
router = APIRouter(
    prefix="/api/platform/hub",
    tags=["hub-platform"],
    dependencies=[Depends(_platform_key_dep)],
)


# --- store singleton -----------------------------------------------------------
# CHAT_DB / CHAT_MEDIA_DIR mirror the other hub-api modules' env-var-with-container-
# default convention (e.g. HUB_DECISIONS_DIR in app.py). Lazy + double-checked-locked
# construction: the file/schema shouldn't be touched at import time (mirrors every other
# module here reading a Path from env without creating it), and uvicorn's threadpool can
# hand the first request to any thread.
CHAT_DB_PATH = Path(os.environ.get("HUB_CHAT_DB", "/data/hub/chat/chat.db"))
CHAT_MEDIA_DIR = Path(os.environ.get("HUB_CHAT_MEDIA_DIR", str(CHAT_DB_PATH.parent / "media")))
# ~7 MB decoded cap (v2 §4.4 / VERDICT.md §3.6): base64 inflates 4/3 and the gateway's
# own MAX_REQUEST_BYTES is 10 MB, so this cap is what actually bounds a single upload.
MAX_MEDIA_DECODED_BYTES = 7_000_000
# Bounds chat.db's media growth. 2 GiB is a starting budget,
# not a measured one — tune via env once real usage is observed.
MAX_MEDIA_TOTAL_BYTES = int(os.environ.get("HUB_CHAT_MEDIA_MAX_BYTES", str(2 * 1024**3)))
_ALLOWED_MEDIA_MIMES = frozenset({"image/png", "image/jpeg", "image/webp", "image/gif"})

_store: ChatStore | None = None
_store_lock = threading.Lock()


def get_store() -> ChatStore:
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                _store = ChatStore(CHAT_DB_PATH, CHAT_MEDIA_DIR)
    return _store


# --- request models ------------------------------------------------------------
# Unconstrained strs, bounds enforced downstream — same reasoning as devicekeys.py's
# DeviceKeyAssertion: a pydantic Field(max_length=...) makes a lone surrogate a 500
# (Starlette can't encode the echoed input in the 422 body), so length/charset checks
# live in model_validator instead, on the fail-closed 400 path.
_THREAD_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_THREAD_ID_LEN = 64
MAX_SUMMARY_LEN = 2000
MAX_TITLE_LEN = 200
# One flush from the plugin's delta buffer, with room to spare.
MAX_STREAM_DELTA_LEN = 16_000


class AttentionSpec(BaseModel):
    """Opens or updates one needs-you row alongside the delivered message. `request_id`
    + `run_id` are required for `kind="approval"` — the approvals table is keyed
    (run_id, request_id), and there is nothing to key an approval frame on without them."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["approval", "question", "widget", "run_failed", "cron_alert", "mention", "stalled", "lease_timeout", "imessage_draft"]
    request_id: str | None = None
    run_id: str | None = None
    summary: str = ""
    expires_at_derived: str | None = None
    queue_pos: int = 0

    @model_validator(mode="after")
    def _bounds(self) -> "AttentionSpec":
        if len(self.summary) > MAX_SUMMARY_LEN:
            raise ValueError(f"summary over {MAX_SUMMARY_LEN} chars")
        if self.kind == "approval" and (not self.request_id or not self.run_id):
            raise ValueError("approval attention requires request_id and run_id")
        return self


class DeliverRequest(BaseModel):
    """One adapter send()/edit_message() call. `chat_type` is deliberately NOT a field
    here — it is always "dm" (VERDICT-V2 §4.2: chat_type and thread_id are hardcoded,
    never derived from caller input, or every key silently forks a session). `role` is
    restricted to assistant/system: this route is gateway-to-hub-api only, and a "user"
    row must never be mintable by the platform key — only a WebAuthn/device-key-gated
    human write (not built in this slice) can originate one."""

    model_config = ConfigDict(extra="forbid")

    thread_id: str
    kind: Literal["chat", "brief", "ops", "money", "cron"] = "chat"
    title: str | None = None
    hermes_session_id: str | None = None
    run_id: str | None = None
    cron_run_id: str | None = None
    role: Literal["assistant", "system"] = "assistant"
    status: Literal["complete", "streaming", "error"] = "complete"
    parts: list[dict[str, Any]]
    attention: AttentionSpec | None = None
    delivery_id: str | None = None
    # The gateway's own reply for this turn — the one place the turn's end is
    # known (the adapter calls `end_turn` right after). Everything else it
    # sends mid-turn is a tool card, a widget or one stream's final text.
    final: bool = False
    # Set on a scheduled job's delivery. The row is then filed under that job
    # (chat/automation_store.py) and `thread_id` — the catch-all channel or the
    # chat the job was created from — is where it would have gone, not where it goes.
    job_id: str | None = None
    job_run_id: str | None = None

    @model_validator(mode="after")
    def _bounds(self) -> "DeliverRequest":
        if not _THREAD_ID_RE.match(self.thread_id):
            raise ValueError(f"thread_id must match {_THREAD_ID_RE.pattern}")
        if self.job_id is not None and not valid_job_id(self.job_id):
            raise ValueError("malformed job_id")
        if self.job_id is not None and self.attention is not None:
            raise ValueError("a job's delivery carries no attention row")
        if self.job_run_id is not None and (
            self.job_id is None or not valid_run_id(self.job_run_id) or job_of(self.job_run_id) != self.job_id
        ):
            raise ValueError("job_run_id must be '<job_id>:<stem>'")
        if self.title is not None and len(self.title) > MAX_TITLE_LEN:
            raise ValueError(f"title over {MAX_TITLE_LEN} chars")
        if not self.parts:
            raise ValueError("parts must be non-empty")
        for part in self.parts:
            if not isinstance(part, dict) or part.get("type") not in PART_TYPES:
                raise ValueError(f"each part needs 'type' in {sorted(PART_TYPES)}")
        return self


class MediaUploadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    thread_id: str
    mime: Literal["image/png", "image/jpeg", "image/webp", "image/gif"]
    data_b64: str
    origin: Literal["agent"] = "agent"
    width: int | None = None
    height: int | None = None

    @model_validator(mode="after")
    def _bounds(self) -> "MediaUploadRequest":
        if not _THREAD_ID_RE.match(self.thread_id):
            raise ValueError(f"thread_id must match {_THREAD_ID_RE.pattern}")
        return self


class CommandCatalogEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    aliases: list[str] = []
    category: Literal["builtin", "skill", "plugin", "alias"]
    description: str = ""
    arg_hint: str | None = None
    busy_policy: Literal["reject", "dispatch", "interrupt_then_dispatch"] = "reject"


class CommandCatalogPush(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int
    commands: list[CommandCatalogEntry]


class SetTitleRequest(BaseModel):
    """A decided thread name. Whitespace is collapsed to one line the same way
    `_auto_title` does it (chat/routes.py) — a title is a list row, and a job that
    hands back a proposal with a newline in it must not be able to break that row."""

    model_config = ConfigDict(extra="forbid")

    thread_id: str
    title: str

    @model_validator(mode="after")
    def _bounds(self) -> "SetTitleRequest":
        if not _THREAD_ID_RE.match(self.thread_id):
            raise ValueError(f"thread_id must match {_THREAD_ID_RE.pattern}")
        if len(self.title) > MAX_TITLE_LEN:
            raise ValueError(f"title over {MAX_TITLE_LEN} chars")
        self.title = " ".join(self.title.split())
        if not self.title:
            raise ValueError("title must be non-empty")
        return self


# --- routes ---------------------------------------------------------------------
# Fire-and-forget tasks need a reference or the loop may collect them mid-flight.
_push_tasks: set[asyncio.Task] = set()

# A retried request must not act twice. The plugin's `HubApiClient.post` sends
# again on a fresh connection when a kept-alive socket fails on use, and that
# failure can come AFTER this process applied the request — a `/stream` delta
# appended twice is doubled text in the stored row, a `/deliver` twice is a
# second bubble. Every queued request carries a `delivery_id`; the first answer
# is kept and repeated. In-process is enough: one worker, and a retry never
# crosses a restart.
SEEN_DELIVERIES_MAX = 5000
_seen_deliveries: "OrderedDict[str, dict[str, Any]]" = OrderedDict()


def _replayed(delivery_id: str | None) -> dict[str, Any] | None:
    if not delivery_id:
        return None
    hit = _seen_deliveries.get(delivery_id)
    if hit is not None:
        _seen_deliveries.move_to_end(delivery_id)
    return hit


def _remember(delivery_id: str | None, response: dict[str, Any]) -> dict[str, Any]:
    if delivery_id:
        _seen_deliveries[delivery_id] = response
        while len(_seen_deliveries) > SEEN_DELIVERIES_MAX:
            _seen_deliveries.popitem(last=False)
    return response


def _notify_reply(store: ChatStore, req: DeliverRequest) -> None:
    """One push for the finished prose of a turn, when the user is not in the app.

    Off the delivery path entirely: the send is an HTTP call to Expo, and doing
    it inline held this single-worker process for as long as Expo took, which
    is long enough for the gateway's own POST to time out and the reply to go
    missing from the thread (the user, 2026-09-22 — "the final message not show up
    properly"). A notification is never worth a message.
    """
    try:
        thread = store.get_thread(req.thread_id) or {}
        # A reply under a run opens the run, with the reply below it.
        url = f"/automations/run?runId={thread['origin_run_id']}" if thread.get("origin_run_id") else None
        task = asyncio.create_task(
            asyncio.to_thread(
                chat_notify.notify_reply,
                thread_id=req.thread_id,
                thread_title=thread.get("title"),
                parts=req.parts,
                url=url,
            )
        )
        _push_tasks.add(task)
        task.add_done_callback(_push_tasks.discard)
    except Exception:  # noqa: BLE001
        logger.warning("chat push skipped for %s", req.thread_id, exc_info=True)


class CloseThreadRequest(BaseModel):
    """Settle what a stream left streaming.

    With `run_id`, only that run's rows — sent by the plugin when the LLM
    stream that wrote them ends, so a turn that never calls send() closes
    itself and a live turn in the same thread is left alone. Without it,
    everything the thread has open (the session-end backstop)."""

    model_config = ConfigDict(extra="forbid")

    thread_id: str
    run_id: str | None = None
    delivery_id: str | None = None

    @model_validator(mode="after")
    def _bounds(self) -> "CloseThreadRequest":
        if not _THREAD_ID_RE.match(self.thread_id):
            raise ValueError(f"thread_id must match {_THREAD_ID_RE.pattern}")
        return self


class SettleApprovalsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    thread_id: str
    pending_request_ids: list[str] = []
    outcome: str = ""
    delivery_id: str | None = None

    @model_validator(mode="after")
    def _bounds(self) -> "SettleApprovalsRequest":
        if not _THREAD_ID_RE.match(self.thread_id):
            raise ValueError(f"thread_id must match {_THREAD_ID_RE.pattern}")
        if len(self.pending_request_ids) > 50 or len(self.outcome) > 32:
            raise ValueError("too many pending ids or an overlong outcome")
        return self


@router.post("/approvals/settle")
def hub_platform_settle_approvals(req: SettleApprovalsRequest) -> dict[str, Any]:
    """The gateway finished waiting on an approval. Cards it is no longer
    waiting on close, however that wait ended."""
    replayed = _replayed(req.delivery_id)
    if replayed is not None:
        return replayed
    closed = get_store().settle_open_approvals(
        thread_id=req.thread_id, keep=set(req.pending_request_ids), outcome=req.outcome
    )
    return _remember(req.delivery_id, {"status": "ok", "closed": closed})


@router.post("/close")
def hub_platform_close(req: CloseThreadRequest) -> dict[str, Any]:
    """Settle a thread whose session has ended.

    A turn that streams and then never delivers — the end-of-session reflect
    turn does exactly this — left its rows `streaming` for ever: a reply cut
    mid-sentence with the ring still spinning under it (the user, 2026-09-22). The
    text it streamed is kept; only the state is corrected.
    """
    replayed = _replayed(req.delivery_id)
    if replayed is not None:
        return replayed
    store = get_store()
    closed = (
        store.close_run_streams(req.thread_id, run_id=req.run_id)
        if req.run_id
        else store.close_orphan_streams(req.thread_id, keep_run_id=None)
    )
    return _remember(req.delivery_id, {"status": "ok", "closed": closed})


@router.post("/deliver")
async def hub_platform_deliver(req: DeliverRequest) -> dict[str, Any]:
    replayed = _replayed(req.delivery_id)
    if replayed is not None:
        return replayed
    return _remember(req.delivery_id, _deliver(req))


def _notify_automation(job_name: str, run_id: str, text: str) -> None:
    try:
        task = asyncio.create_task(
            asyncio.to_thread(chat_notify.notify_automation, job_name=job_name, run_id=run_id, text=text)
        )
        _push_tasks.add(task)
        task.add_done_callback(_push_tasks.discard)
    except Exception:  # noqa: BLE001
        logger.warning("automation push skipped for %s", run_id, exc_info=True)


# How long after a run's text was stored a second delivery under the same file
# is still that run being sent again, rather than a new run without a file.
RUN_FILE_GRACE_S = 300


def _iso_ago(*, seconds: int) -> str:
    from datetime import datetime, timedelta, timezone

    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _deliver_job(req: DeliverRequest) -> dict[str, Any]:
    """A scheduled job's delivery: filed under the job, never in a chat."""
    store = get_store()
    autos = AutomationStore(store)
    job_id = req.job_id or ""
    run_id = req.job_run_id or f"{job_id}:d{int(time.time())}"
    # An attachment rides alongside its run: a file part brings a text line
    # of its own and an image may carry a caption, and neither is the run's
    # report. Only a text-only delivery is the run's text and its dedup key.
    media = any(p.get("type") not in ("text", "reasoning") for p in req.parts)
    text = "" if media else "\n\n".join(
        str(p.get("text") or "") for p in req.parts if p.get("type") == "text" and p.get("text")
    ).strip()
    known = autos.get_job(job_id)
    thread_id = delivery_thread_id(job_id)
    store.get_or_create_thread(thread_id, kind="automation", title=(known or {}).get("name"))
    if text and req.job_run_id:
        # The run id names the newest file in the job's directory. When that
        # file's text was stored a while ago, this delivery is a run whose file
        # is not there: file it as its own run rather than as a repeat.
        earlier = store.message_by_cron_run_id(thread_id, run_id)
        if earlier is not None and earlier["created_at"] < _iso_ago(seconds=RUN_FILE_GRACE_S):
            run_id = f"{job_id}:d{int(time.time())}"
    message, created = store.insert_message(
        thread_id=thread_id,
        role=req.role,
        author_type="agent",
        parts=req.parts,
        status=req.status,
        # One text row per run: a delivery the scheduler sends twice dedups here.
        cron_run_id=run_id if text else None,
        job_id=job_id,
        job_run_id=run_id,
    )
    if created and text:
        run = autos.record_delivery(job_id=job_id, run_id=run_id, text=text)
        if autos.should_push(run):
            job = autos.get_job(job_id) or {}
            _notify_automation(str(job.get("name") or job_id), run_id, text)
    return {
        "status": "ok",
        "message_id": message["id"],
        "seq": message["seq"],
        "deduped": not created,
        "attention_id": None,
        "run_id": run_id,
    }


def _deliver(req: DeliverRequest) -> dict[str, Any]:
    if req.job_id:
        return _deliver_job(req)
    store = get_store()
    store.get_or_create_thread(req.thread_id, kind=req.kind, title=req.title)
    if req.final:
        store.end_run(req.thread_id, run_id=req.run_id)
    elif req.run_id:
        store.begin_run(req.thread_id, req.run_id)
    if req.hermes_session_id:
        store.set_hermes_session_id(req.thread_id, req.hermes_session_id)
    resent = None
    # The finished text of a turn that was streaming lands ON the row that was
    # streaming it. Only prose: a tool card shares the run_id and is its own
    # message, and an error keeps the streaming row for the client to show.
    if req.run_id and req.status == "complete" and all(p.get("type") in ("text", "reasoning") for p in req.parts):
        finalized = store.finalize_streaming_message(
            thread_id=req.thread_id, run_id=req.run_id, parts=req.parts, status=req.status
        )
        if finalized is not None:
            store.close_orphan_streams(req.thread_id, keep_run_id=req.run_id)
            _notify_reply(store, req)
            return {"status": "ok", "message_id": finalized["id"], "seq": finalized["seq"],
                    "deduped": False, "attention_id": None, "streamed": True}
        # Nothing was streaming: either this is new prose, or it is the same
        # reply arriving a second time after the first closed the row. What
        # rides with a resend still lands below — returning from here dropped
        # the attention row of a re-sent approval.
        resent = store.replace_run_prose(thread_id=req.thread_id, run_id=req.run_id, parts=req.parts)
    landed = None
    if len(req.parts) == 1 and req.parts[0].get("type") == "tool_call":
        subagent = req.parts[0].get("subagent")
        if isinstance(subagent, dict) and subagent.get("phase") == "stop":
            landed = store.land_subagent_stop(req.thread_id, req.parts[0])
    if landed is not None:
        message, created = landed, False
    elif resent is not None:
        message, created = resent, False
    else:
        message, created = store.insert_message(
            thread_id=req.thread_id,
            role=req.role,
            author_type="agent",
            parts=req.parts,
            run_id=req.run_id,
            status=req.status,
            cron_run_id=req.cron_run_id,
        )
    # An approval resolved somewhere other than the Hub — a Discord button, a
    # typed /approve, the agent's own timeout — sends no event this Hub would
    # recognise. What it does send, eventually, is the tool call itself running
    # (or failing), carrying the same `tool_call_id`. That is the signal, and
    # without acting on it the card in the thread stayed "Waiting for your
    # approval" forever (gap A26).
    for part in req.parts:
        if part.get("type") == "tool_call" and part.get("state") != "approval_requested":
            tool_call_id = part.get("tool_call_id")
            if isinstance(tool_call_id, str) and tool_call_id:
                store.close_approval_resolved_elsewhere(thread_id=req.thread_id, request_id=tool_call_id)

    attention_row = None
    if req.attention is not None:
        attention_row = store.upsert_attention(
            thread_id=req.thread_id,
            kind=req.attention.kind,
            request_id=req.attention.request_id,
            run_id=req.attention.run_id,
            summary=req.attention.summary,
            expires_at_derived=req.attention.expires_at_derived,
            message_id=message["id"],
        )
        if req.attention.kind == "approval":
            store.upsert_approval(
                run_id=req.attention.run_id,  # type: ignore[arg-type]  # non-None, enforced by AttentionSpec
                request_id=req.attention.request_id,  # type: ignore[arg-type]
                thread_id=req.thread_id,
                frame=req.model_dump(mode="json"),
                queue_pos=req.attention.queue_pos,
            )
    if created and req.role == "assistant" and req.status == "complete":
        # A finished reply is proof any EARLIER run in this thread is over —
        # but only when it names its run: a widget or a status notice arrives
        # with no run id, and closing "every other run" from one of those
        # closed the live turn mid-stream (audit, 2026-09-28).
        if req.run_id:
            store.close_orphan_streams(req.thread_id, keep_run_id=req.run_id)
        if chat_notify.notifiable_text(req.parts) is not None:
            _notify_reply(store, req)
    response: dict[str, Any] = {
        "status": "ok",
        "message_id": message["id"],
        "seq": message["seq"],
        "deduped": not created,
        "attention_id": attention_row["id"] if attention_row else None,
    }
    if resent is not None:
        response["streamed"] = True
    if landed is not None:
        response["landed"] = True
    return response


class StreamDeltaRequest(BaseModel):
    """One slice of a reply as it is being written. The plugin posts these from
    the gateway's own `on_stream_delta` hook; hub-api owns the lifecycle, keyed
    by (thread_id, run_id), so the plugin stays stateless and fire-and-forget."""
    model_config = ConfigDict(extra="forbid")

    thread_id: str
    run_id: str
    delta: str
    kind: Literal["text", "reasoning"] = "text"
    hermes_session_id: str | None = None
    delivery_id: str | None = None

    @model_validator(mode="after")
    def _bounds(self) -> "StreamDeltaRequest":
        if not _THREAD_ID_RE.match(self.thread_id):
            raise ValueError(f"thread_id must match {_THREAD_ID_RE.pattern}")
        if not self.run_id.strip():
            raise ValueError("run_id required")
        if len(self.delta) > MAX_STREAM_DELTA_LEN:
            raise ValueError(f"delta over {MAX_STREAM_DELTA_LEN} chars")
        return self


@router.post("/stream")
async def hub_platform_stream(req: StreamDeltaRequest) -> dict[str, Any]:
    """Grow this turn's in-flight reply. Creates the streaming message on the
    first delta and appends after that; `/deliver` lands the finished text on
    the same row rather than posting a second copy."""
    if not req.delta:
        return {"status": "ok", "message_id": None}
    replayed = _replayed(req.delivery_id)
    if replayed is not None:
        return replayed
    message = get_store().append_stream_delta(
        thread_id=req.thread_id, run_id=req.run_id, delta=req.delta, kind=req.kind,
        hermes_session_id=req.hermes_session_id,
    )
    # After the delta, not before: this is where the thread is created, and
    # `begin_run` has nothing to mark until it exists.
    get_store().begin_run(req.thread_id, req.run_id)
    return _remember(req.delivery_id, {"status": "ok", "message_id": message["id"], "seq": message["seq"]})


@router.post("/media")
async def hub_platform_media(req: MediaUploadRequest) -> dict[str, Any]:
    try:
        raw = base64.b64decode(req.data_b64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail={"code": "bad_request", "detail": "data_b64 is not valid base64"})
    if not raw:
        raise HTTPException(status_code=400, detail={"code": "bad_request", "detail": "data_b64 decoded to zero bytes"})
    if len(raw) > MAX_MEDIA_DECODED_BYTES:
        raise HTTPException(
            status_code=413,
            detail={"code": "media_too_large", "detail": f"decoded payload over {MAX_MEDIA_DECODED_BYTES} bytes"},
        )
    store = get_store()
    if store.chat_media_total_bytes() + len(raw) > MAX_MEDIA_TOTAL_BYTES:
        raise HTTPException(
            status_code=507,
            detail={"code": "media_store_full", "detail": "chat media storage cap reached"},
        )
    media = store.insert_media(
        thread_id=req.thread_id, mime=req.mime, raw=raw, origin=req.origin, width=req.width, height=req.height
    )
    return {"status": "ok", "media_id": media["id"], "size_bytes": media["size_bytes"]}


# One small file, same tmp+rename idiom as app.py's `_write_bridge_status` /
# devicekeys.py's `_save_devicekeys` — this is a cache of the gateway's own live
# registries, not chat data, so it doesn't belong in chat.db's schema.
COMMAND_CATALOG_FILE = Path(os.environ.get("HUB_CHAT_COMMAND_CATALOG", str(CHAT_DB_PATH.parent / "commands-catalog.json")))
_catalog_lock = threading.Lock()


@router.post("/commands")
async def hub_platform_commands(req: CommandCatalogPush) -> dict[str, Any]:
    with _catalog_lock:
        current_version = -1
        try:
            current_version = int(json.loads(COMMAND_CATALOG_FILE.read_text()).get("version", -1))
        except (OSError, ValueError, json.JSONDecodeError, AttributeError):
            pass
        if req.version <= current_version:
            return {"status": "stale_ignored", "version": current_version}
        COMMAND_CATALOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = COMMAND_CATALOG_FILE.with_name(COMMAND_CATALOG_FILE.name + ".tmp")
        tmp.write_text(json.dumps(req.model_dump(), indent=2))
        tmp.replace(COMMAND_CATALOG_FILE)
    return {"status": "ok", "version": req.version, "count": len(req.commands)}


# One page of candidates is one batch of the job's inference calls — the cap is what
# bounds a run's cost, not just its response size.
MAX_TITLE_REVIEW_LIMIT = 50


@router.get("/title-review")
async def hub_platform_title_review(
    min_messages: int = TITLE_REVIEW_MIN_MESSAGES,
    limit: int = 20,
) -> dict[str, Any]:
    """Threads that have talked past their own name. One read per job run: each
    candidate carries its current title, how many messages have landed since that
    title was decided, and the tail of them — enough to re-title on without ever
    reading a transcript."""
    candidates = get_store().list_title_review_candidates(
        min_messages=max(min_messages, 1),
        limit=min(max(limit, 1), MAX_TITLE_REVIEW_LIMIT),
    )
    return {"min_messages": max(min_messages, 1), "candidates": candidates}


@router.post("/title")
async def hub_platform_title(req: SetTitleRequest) -> dict[str, Any]:
    """Rename a thread, overwriting whatever it is called now, and emit the same
    `thread.patch` the first-message namer emits so an open client re-titles the row
    live. Never lazily creates the thread — a rename of something that does not exist
    is an honest 404, not a new empty thread.

    Posting back the name it already has is the job's "still fits" answer: it moves
    the review cursor without touching the name or waking a client (`set_thread_title`,
    chat/store.py)."""
    thread = get_store().set_thread_title(req.thread_id, req.title, overwrite=True)
    if thread is None:
        raise HTTPException(
            status_code=404, detail={"code": "not_found", "detail": f"no thread {req.thread_id!r}"}
        )
    return {
        "status": "ok",
        "thread_id": thread["id"],
        "title": thread["title"],
        "title_seq": thread["title_seq"],
    }
