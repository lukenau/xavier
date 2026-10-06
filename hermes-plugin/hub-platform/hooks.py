# SPDX-License-Identifier: MIT
"""Hub platform lifecycle hooks for Hermes Agent (observer + forwarder).

Registers ``post_tool_call``, ``on_stream_delta``, ``on_stream_end``,
``subagent_start``, ``subagent_stop`` and ``post_approval_response`` (wired
via ``register_hooks(ctx)``, called from ``__init__.py``). Hooks are
independent registrations on the same ``PluginContext``, so none of this
depends on the ``hub`` adapter in ``adapter.py`` being connected.

THE OBSERVER: every callback appends one bounded JSON line to a local file,
``$HERMES_HOME/hub-platform/observer.jsonl``, for every session on every
platform: did each hook fire, for which session, with which fields present,
and how long the callback itself took. It is deliberately not a debugging
log: no raw tool arguments, no raw tool results, no raw assistant/reasoning
text, ever — only which fields were present and cheap scalars.

THE FORWARDER: for sessions that belong to a Hub thread — and only those,
decided by one cached ``session_id`` lookup
(``runtime.hub_thread_for_session``) — each hook also hands a bounded record
to ``runtime.queue``: a tool card, a subagent card, a stream delta, the end of
a stream, or an approval settlement. ``enqueue`` is O(1), never blocks and
never raises; a single daemon thread does the HTTP. What goes to the hub is the
chat transcript itself, within hard length caps (``hub_wire.bounded``). Tool
cards and the final reply also pass through the gateway's own
``redact_sensitive_text(force=True)``; stream deltas and reasoning do not.

EVERY CALLBACK IS PLAIN ``def``: they run inline, on the hot path of every
tool call on every platform. Older gateways called hooks with a bare
``callback(**kwargs)`` and silently never ran an ``async def`` one; v0.21
awaits them, and a synchronous callback is correct on both.

EVERY CALLBACK IS WRAPPED IN A BLANKET ``try/except Exception: pass``
(``_guarded`` below), on top of ``invoke_hook``'s own per-callback
isolation. `invoke_hook` already logs-and-continues on a raise, but a local
disk write is exactly the kind of thing that can fail in a new way (disk
full, permission drift, the data directory briefly unmounted), and this
file must never become a new source of log noise or of turn-blocking
latency on a platform that is not even the Hub's.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Any, Dict

from . import curator
from . import hub_wire as wire
from . import paths
from . import runtime
from .hub_client import CLOSE_PATH, DELIVER_PATH, SETTLE_PATH, STREAM_PATH

logger = logging.getLogger(__name__)

_OBSERVER_DIR = os.environ.get("HUB_PLATFORM_OBSERVER_DIR") or paths.under_home("hub-platform")
_OBSERVER_FILE = "observer.jsonl"
_OBSERVER_PATH = os.path.join(_OBSERVER_DIR, _OBSERVER_FILE)
_BACKUP_PATH = _OBSERVER_PATH + ".1"

# post_tool_call fires on every tool call, on every platform, not just Hub's —
# an unrotated file is an unbounded-growth risk regardless of how small each
# line is. Cap: one active file up to _MAX_BYTES, one rotated backup of the
# same size — ~2x this constant is the hard ceiling this plugin can ever
# consume, checked on every write rather than on a timer so a rotation can
# never lag behind a burst.
_MAX_BYTES = int(os.environ.get("HUB_PLATFORM_OBSERVER_MAX_BYTES", 5 * 1024 * 1024))

# How much assistant text to gather before sending it on. Small enough that the
# reply visibly grows, large enough that a 600-character answer costs ~15 posts
# rather than 300.
STREAM_FLUSH_CHARS = int(os.environ.get("HUB_PLATFORM_STREAM_FLUSH_CHARS", "48"))

_write_lock = threading.Lock()
_warned_unwritable = False
_dir_ready = False


def _ensure_dir() -> None:
    global _dir_ready
    if _dir_ready:
        return
    try:
        os.makedirs(_OBSERVER_DIR, exist_ok=True)
        _dir_ready = True
    except Exception:
        pass  # retried on the next write; the write itself will also fail


def _rotate_if_needed() -> None:
    """Move the active file to a single backup slot once it's oversized.

    Called with `_write_lock` already held. `os.replace` is an atomic
    rename on the same filesystem — no partial-file window, no read lock
    needed on the file being replaced. Deliberately no fsync: this is a
    best-effort observability aid, not a durability guarantee, and an
    fsync-per-line/rotation would violate the "must never block" rule this
    plugin exists to prove doesn't happen.
    """
    try:
        if os.path.getsize(_OBSERVER_PATH) >= _MAX_BYTES:
            os.replace(_OBSERVER_PATH, _BACKUP_PATH)
    except FileNotFoundError:
        pass  # nothing to rotate yet


def _present_fields(kwargs: Dict[str, Any]) -> list:
    """Which kwargs the emit site actually populated — the schema-drift
    signal (a field that stops appearing is as informative as one that
    starts). Values themselves are never included here."""
    return sorted(k for k, v in kwargs.items() if v not in (None, "", [], {}))


def _append_jsonl(hook: str, payload: Dict[str, Any]) -> None:
    """Append one observer record. Fails open, warns once, never raises.

    One open/append/close per call, no batching, no background thread: the
    record is tiny, and measured on real traffic the write costs well under a
    millisecond on the hot path.
    """
    global _warned_unwritable
    record = {"ts": time.time(), "hook": hook, **payload}
    try:
        line = json.dumps(record, default=str)
    except Exception as exc:
        logger.debug("hub-platform observer: could not serialize %s payload: %s", hook, exc)
        return
    try:
        _ensure_dir()
        with _write_lock:
            _rotate_if_needed()
            with open(_OBSERVER_PATH, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except Exception as exc:
        if not _warned_unwritable:
            _warned_unwritable = True
            logger.warning(
                "hub-platform observer: cannot write %s (%s) — further failures logged at debug only",
                _OBSERVER_PATH,
                exc,
            )
        else:
            logger.debug("hub-platform observer: write failed: %s", exc)


def _guarded(hook_name: str):
    """Wrap a record-builder so it can never raise into the calling turn.

    Belt-and-suspenders on top of invoke_hook's own per-callback
    try/except — see the module docstring for why this file doesn't rely on
    that alone. Also times the callback's own work (build + serialize +
    write) and stamps it onto the record as ``callback_ms``: wall time for
    this callback only, not the tool call's own duration_ms (a separate,
    already-present field on post_tool_call).
    """

    def decorator(build_record):
        def wrapper(**kwargs: Any) -> None:
            start = time.perf_counter()
            try:
                record = build_record(**kwargs)
                record["callback_ms"] = round((time.perf_counter() - start) * 1000, 3)
                _append_jsonl(hook_name, record)
            except Exception:
                pass  # never propagate into the turn that triggered this hook

        wrapper.__name__ = getattr(build_record, "__name__", hook_name)
        return wrapper

    return decorator


# --------------------------------------------------------------------------
# Hook record builders. Every builder takes **kwargs (never a narrow
# explicit signature) so an additive field from a future gateway version —
# or the generic `telemetry_schema_version` most hook payloads get — can
# never raise a TypeError here.
# --------------------------------------------------------------------------


def _forward_tool_call(kwargs: Dict[str, Any]) -> bool:
    session_id = kwargs.get("session_id") or ""
    thread_id = runtime.hub_thread_for_session(session_id)
    if not thread_id:
        return False
    turn_id = kwargs.get("turn_id") or ""
    if curator.is_review_turn(turn_id):
        return False
    runtime.turns.note_turn(session_id, turn_id or None)
    body = wire.tool_call_message(
        thread_id,
        tool_call_id=kwargs.get("tool_call_id") or "",
        tool_name=kwargs.get("tool_name") or "",
        args=kwargs.get("args"),
        result=kwargs.get("result"),
        duration_ms=kwargs.get("duration_ms"),
        status=kwargs.get("status"),
        error_type=kwargs.get("error_type"),
        error_message=kwargs.get("error_message"),
        run_id=turn_id or None,
        session_id=session_id,
        reasoning=runtime.turns.take_reasoning(session_id),
        redact=runtime.redact,
    )
    return runtime.queue.enqueue(DELIVER_PATH, body)


def _forward_subagent(phase: str, kwargs: Dict[str, Any]) -> bool:
    parent = kwargs.get("parent_session_id") or ""
    thread_id = runtime.hub_thread_for_session(parent)
    if not thread_id:
        return False
    turn_id = kwargs.get("parent_turn_id") or ""
    runtime.turns.note_turn(parent, turn_id or None)
    body = wire.subagent_message(
        thread_id,
        phase=phase,
        child_session_id=str(kwargs.get("child_session_id") or ""),
        child_role=str(kwargs.get("child_role") or ""),
        child_goal=kwargs.get("child_goal"),
        child_status=kwargs.get("child_status"),
        child_summary=kwargs.get("child_summary"),
        duration_ms=kwargs.get("duration_ms"),
        tool_call_count=len(kwargs.get("tool_call_history") or []) if phase == "stop" else None,
        run_id=turn_id or None,
        session_id=parent,
        redact=runtime.redact,
    )
    return runtime.queue.enqueue(DELIVER_PATH, body)


@_guarded("post_tool_call")
def _on_post_tool_call(**kwargs: Any) -> Dict[str, Any]:
    return {
        "session_id": kwargs.get("session_id") or "",
        "turn_id": kwargs.get("turn_id") or "",
        "tool_name": kwargs.get("tool_name") or "",
        "status": kwargs.get("status") or "",
        "duration_ms": kwargs.get("duration_ms"),
        "fields_present": _present_fields(kwargs),
        "forwarded": _forward_tool_call(kwargs),
    }


@_guarded("on_stream_delta")
def _on_stream_delta(**kwargs: Any) -> Dict[str, Any]:
    # Runs on plugin_stream_hooks's own dedicated worker thread, not the
    # main turn's thread — still kept cheap and bounded so a slow disk
    # doesn't back up that thread's queue. `surface` is the turn's platform
    # name, so the Hub check is a string compare — no store lookup per token.
    # Text and reasoning deltas are batched per kind and streamed; the final
    # reply still arrives whole through send().
    buffered = False
    streamed = False
    if kwargs.get("surface") == "hub" and not curator.is_review_turn(kwargs.get("turn_id")):
        session_id = kwargs.get("session_id") or ""
        turn_id = kwargs.get("turn_id") or None
        delta = kwargs.get("delta") or ""
        kind = kwargs.get("kind")
        if kind in ("text", "reasoning"):
            # The reply, as it is written. Without this the Hub threw every
            # token away and posted the finished message, so nothing moved on
            # screen for the length of a turn. Thinking streams the same way
            # speech does. On a reasoning-heavy
            # model that is most of the turn — 281 of 300 deltas on the turn
            # this was measured on — so buffering it to the end meant watching
            # nothing happen for most of the wait.
            chunk = runtime.turns.add_stream_text(session_id, turn_id, delta, flush_at=STREAM_FLUSH_CHARS, kind=kind)
            if chunk and turn_id:
                thread_id = runtime.hub_thread_for_session(session_id)
                if thread_id:
                    streamed = runtime.queue.enqueue(STREAM_PATH, {
                        "thread_id": thread_id,
                        "run_id": turn_id,
                        "delta": chunk,
                        "kind": kind,
                        "hermes_session_id": session_id,
                    })
            buffered = kind == "reasoning"
    return {
        "session_id": kwargs.get("session_id") or "",
        "turn_id": kwargs.get("turn_id") or "",
        "surface": kwargs.get("surface") or "",
        "kind": kwargs.get("kind") or "",
        "delta_len": len(kwargs.get("delta") or ""),
        "fields_present": _present_fields(kwargs),
        "buffered": buffered,
        "streamed": streamed,
    }


@_guarded("subagent_start")
def _on_subagent_start(**kwargs: Any) -> Dict[str, Any]:
    return {
        "parent_session_id": kwargs.get("parent_session_id") or "",
        "child_session_id": kwargs.get("child_session_id") or "",
        "child_role": kwargs.get("child_role") or "",
        "fields_present": _present_fields(kwargs),
        "forwarded": _forward_subagent("start", kwargs),
    }


@_guarded("subagent_stop")
def _on_subagent_stop(**kwargs: Any) -> Dict[str, Any]:
    return {
        "parent_session_id": kwargs.get("parent_session_id") or "",
        "child_session_id": kwargs.get("child_session_id") or "",
        "child_role": kwargs.get("child_role") or "",
        "child_status": kwargs.get("child_status") or "",
        "duration_ms": kwargs.get("duration_ms"),
        "tool_call_count": len(kwargs.get("tool_call_history") or []),
        "fields_present": _present_fields(kwargs),
        "forwarded": _forward_subagent("stop", kwargs),
    }


@_guarded("on_stream_end")
def _on_stream_end(**kwargs: Any) -> Dict[str, Any]:
    """Settle the rows a stream wrote, the moment the stream ends.

    A turn that never calls `send()` — the end-of-session memory review is the
    common example — left its rows `streaming`, so the Hub said "Working…"
    until something else happened to the thread. Closing rows on
    `on_session_end` is too early: it fires BEFORE the gateway runs that
    review, so the review's own rows were never closed.

    The stream is the right seam: `on_stream_end` carries `final_text`, the
    whole text of the stream that just ended, so it is delivered as the row's
    final content (whole, not the coalesced deltas with their holes) and the
    run's remaining streaming rows are closed. A later `send()` of the same
    text lands on the same row by text match; a different text is a new row.
    """
    if kwargs.get("surface") != "hub":
        return {"surface": kwargs.get("surface") or "", "forwarded": False}
    session_id = kwargs.get("session_id") or ""
    turn_id = kwargs.get("turn_id") or ""
    if curator.is_review_turn(turn_id):
        final = kwargs.get("final_text") or ""
        if isinstance(final, str):
            curator.hold(session_id, final)
        return {"session_id": session_id, "turn_id": turn_id, "forwarded": False, "curator": True}
    thread_id = runtime.hub_thread_for_session(session_id)
    if not thread_id or not turn_id:
        return {"session_id": session_id, "turn_id": turn_id, "forwarded": False}

    # Whatever the delta buffers still hold belongs to this stream.
    flushed = 0
    for kind in ("reasoning", "text"):
        tail = runtime.turns.take_stream_text(session_id, kind=kind)
        if tail:
            flushed += 1
            runtime.queue.enqueue(STREAM_PATH, {
                "thread_id": thread_id, "run_id": turn_id, "delta": tail, "kind": kind,
                "hermes_session_id": session_id,
            })

    final_text = kwargs.get("final_text") or ""
    delivered = False
    if isinstance(final_text, str) and final_text.strip():
        delivered = runtime.queue.enqueue(DELIVER_PATH, wire.text_message(
            thread_id, final_text, run_id=turn_id, session_id=session_id, redact=runtime.redact,
        ))
    closed = runtime.queue.enqueue(CLOSE_PATH, {"thread_id": thread_id, "run_id": turn_id})
    return {
        "session_id": session_id, "turn_id": turn_id, "thread_id": thread_id,
        "finished": bool(kwargs.get("finished")), "error": bool(kwargs.get("error")),
        "flushed": flushed, "delivered": delivered, "forwarded": closed,
    }


@_guarded("post_approval_response")
def _on_post_approval_response(**kwargs: Any) -> Dict[str, Any]:
    """An approval wait ended — answered, timed out, or withdrawn by /stop.

    Without this the card in the Hub only closed when it was answered in the
    Hub; a /stop withdrew the approval and the card sat in "Needs you" for
    good. The hook carries no request id, so the gateway's own queue is the
    truth: every card in this thread whose request is no longer pending there
    is over, and hub-api closes it with how it ended."""
    session_key = kwargs.get("session_key") or ""
    thread_id = wire.thread_id_from_session_key(session_key)
    if not thread_id:
        return {"forwarded": False}
    from tools.approval import list_gateway_approvals

    pending = [str(e.get("request_id")) for e in list_gateway_approvals(session_key) if e.get("request_id")]
    sent = runtime.queue.enqueue(SETTLE_PATH, {
        "thread_id": thread_id,
        "pending_request_ids": pending,
        "outcome": str(kwargs.get("choice") or ""),
    })
    return {"thread_id": thread_id, "pending": len(pending), "forwarded": sent}


def register_hooks(ctx) -> None:
    ctx.register_hook("post_tool_call", _on_post_tool_call)
    ctx.register_hook("on_stream_delta", _on_stream_delta)
    ctx.register_hook("subagent_start", _on_subagent_start)
    ctx.register_hook("subagent_stop", _on_subagent_stop)
    ctx.register_hook("on_stream_end", _on_stream_end)
    ctx.register_hook("post_approval_response", _on_post_approval_response)
