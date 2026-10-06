# SPDX-License-Identifier: MIT
"""Pure wire helpers for the Hub platform plugin.

Everything hub-shaped that the adapter and the hooks produce or consume lives
here, with NO gateway imports, so it runs (and is tested) with any Python 3 —
the same split as ``skill_expand.py``. ``adapter.py`` and ``hooks.py`` are the
thin gateway-importing glue around these builders.

The dict each ``*_message`` builder returns is one ``POST /api/platform/hub/
deliver`` body (``server/chat/platform.py`` ``DeliverRequest`` in this repo):
``thread_id``, ``kind``, ``role``, ``status``, ``parts`` and optionally
``run_id``, ``hermes_session_id``, ``cron_run_id``, ``attention``. Part shapes
match ``app/src/chat/types.ts`` (``TextPart``, ``ReasoningPart``,
``ImagePart``, ``FilePart``, ``ToolCallPart``, ``WidgetPart``).
"""

from __future__ import annotations

import json
import mimetypes
import re
from typing import Any, Callable, Dict, List, Optional

SESSION_KEY_PREFIX = "agent:main:hub:dm:"
THREAD_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# The hub's DeliverRequest.kind only matters when a thread is first created; the
# fixed threads are named after their kind, anything else is a chat.
FIXED_THREAD_KINDS = {"chat": "chat", "brief": "brief", "ops": "ops", "money": "money", "cron": "cron"}

APPROVAL_CHOICES = ("once", "session", "always", "deny")
IMAGE_MIMES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}
_EXT_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}

MAX_ARGS_CHARS = 2000
MAX_RESULT_CHARS = 4000
MAX_REASONING_CHARS = 16000
MAX_TEXT_CHARS = 60000
MAX_SUMMARY_CHARS = 200
MAX_MEDIA_DECODED_BYTES = 7_000_000  # hub-api's own cap, mirrored so we never send what it will 413
# A file's type, as hub-api's `_FILE_MIME_RE` accepts it. Mirrored so the plugin refuses what
# the server would, instead of finding out from a 422.
_FILE_MIME_RE = re.compile(r"^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,95}$")


def clean_name(name: Any) -> str:
    """The name a file is cached and offered under: no directory part, nothing
    unprintable, never empty. hub-api cleans it too; this is the gateway's own
    guard, because the gateway writes it to disk."""
    base = (name if isinstance(name, str) else "").replace("\\", "/").rsplit("/", 1)[-1]
    base = "".join(ch for ch in base if ch.isprintable() and ch not in '"<>:|?*')
    return " ".join(base.split()).strip(". ")[:120] or "file"


def guess_mime(name: str) -> str:
    """A file's type from its name, or the one that claims nothing."""
    mime = (mimetypes.guess_type(name)[0] or "").lower()
    return mime if _FILE_MIME_RE.match(mime) else "application/octet-stream"


def session_key_for_thread(thread_id: str) -> str:
    return SESSION_KEY_PREFIX + thread_id


def thread_id_from_session_key(session_key: Optional[str]) -> Optional[str]:
    """The exact inverse of ``session_key_for_thread`` — one segment, nothing
    else. Any other Hub-looking key (a group, a profile namespace, a nested
    thread) is None: those are not threads hub-api knows."""
    if not session_key or not session_key.startswith(SESSION_KEY_PREFIX):
        return None
    rest = session_key[len(SESSION_KEY_PREFIX):]
    return rest if THREAD_ID_RE.match(rest) else None


def thread_kind(thread_id: str) -> str:
    return FIXED_THREAD_KINDS.get(thread_id, "chat")


def mime_ext(mime: str) -> Optional[str]:
    return IMAGE_MIMES.get(mime)


def ext_mime(path: str) -> Optional[str]:
    dot = path.rfind(".")
    return _EXT_MIME.get(path[dot:].lower()) if dot >= 0 else None


def bounded(value: Any, limit: int, redact: Optional[Callable[[str], str]] = None) -> str:
    """Stringify, redact, truncate — in that order, so the marker can never be
    cut off and a secret can never survive on the far side of the cut."""
    if isinstance(value, str):
        text = value
    else:
        try:
            text = json.dumps(value, default=str, ensure_ascii=False)
        except Exception:
            text = str(value)
    if redact is not None:
        try:
            text = redact(text)
        except Exception:
            text = "[redaction failed — content withheld]"
    if len(text) > limit:
        text = text[:limit] + f"… [truncated {len(text) - limit} chars]"
    return text


def approval_choices(*, allow_session: bool, allow_permanent: bool) -> List[str]:
    choices = ["once"]
    if allow_session:
        choices.append("session")
    if allow_permanent:
        choices.append("always")
    choices.append("deny")
    return choices


def _envelope(thread_id: str, parts: List[Dict[str, Any]], *, run_id=None, session_id=None,
              status="complete", cron_run_id=None, role="assistant") -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "thread_id": thread_id,
        "kind": thread_kind(thread_id),
        "role": role,
        "status": status,
        "parts": parts,
    }
    if run_id:
        body["run_id"] = str(run_id)
    if session_id:
        body["hermes_session_id"] = str(session_id)
    if cron_run_id:
        body["cron_run_id"] = str(cron_run_id)
    return body


def with_job(body: Dict[str, Any], job_id: Optional[str], run_id: Optional[str]) -> Dict[str, Any]:
    """Marks a delivery as a scheduled job's. hub-api files it under the job
    rather than in ``thread_id``, and it belongs to no chat turn — so whatever
    run or session the target thread happens to have open is taken off it."""
    if not job_id:
        return body
    body.pop("run_id", None)
    body.pop("hermes_session_id", None)
    body.pop("cron_run_id", None)
    body["job_id"] = job_id
    if run_id:
        body["job_run_id"] = run_id
    return body


def _with_reasoning(parts: List[Dict[str, Any]], reasoning: Optional[str]) -> List[Dict[str, Any]]:
    if reasoning and reasoning.strip():
        return [{"type": "reasoning", "text": bounded(reasoning, MAX_REASONING_CHARS)}] + parts
    return parts


def text_message(thread_id: str, text: str, *, run_id=None, session_id=None, reasoning=None,
                 status="complete", cron_run_id=None, role="assistant",
                 redact: Optional[Callable[[str], str]] = None) -> Dict[str, Any]:
    parts = _with_reasoning([{"type": "text", "text": bounded(text, MAX_TEXT_CHARS, redact)}], reasoning)
    return _envelope(thread_id, parts, run_id=run_id, session_id=session_id, status=status,
                     cron_run_id=cron_run_id, role=role)


def image_message(thread_id: str, *, media_id=None, url=None, mime=None, caption=None,
                  width=None, height=None, run_id=None, session_id=None, cron_run_id=None) -> Dict[str, Any]:
    if not media_id and not url:
        raise ValueError("image_message needs media_id or url")
    part: Dict[str, Any] = {"type": "image"}
    if media_id:
        part["media_id"] = media_id
    if url:
        part["url"] = url
    if mime:
        part["mime"] = mime
    if width is not None:
        part["width"] = width
    if height is not None:
        part["height"] = height
    parts: List[Dict[str, Any]] = [part]
    if caption and caption.strip():
        parts.append({"type": "text", "text": bounded(caption, MAX_TEXT_CHARS)})
    return _envelope(thread_id, parts, run_id=run_id, session_id=session_id, cron_run_id=cron_run_id)


def file_message(thread_id: str, *, name: str, path: str, mime=None, caption=None,
                 media_id=None, size_bytes=None,
                 run_id=None, session_id=None, cron_run_id=None) -> Dict[str, Any]:
    """A file for the thread. With a ``media_id`` the bytes are in hub-api and the app
    can open them, so the part says so and the caption is all the text there is. Without
    one (too big for the media route, unreadable, hub-api refused) it is the stand-in:
    a chip plus where the bytes live on the gateway, so nothing is silently dropped."""
    part: Dict[str, Any] = {"type": "file", "name": name}
    if mime:
        part["mime"] = mime
    if media_id:
        part["media_id"] = media_id
        if size_bytes is not None:
            part["size_bytes"] = size_bytes
        said = [{"type": "text", "text": bounded(caption.strip(), MAX_TEXT_CHARS)}] if caption and caption.strip() else []
        return _envelope(thread_id, [part, *said], run_id=run_id, session_id=session_id, cron_run_id=cron_run_id)
    parts: List[Dict[str, Any]] = [part, {"type": "text", "text": bounded(
        (caption.strip() + "\n\n" if caption and caption.strip() else "") + f"Saved on the gateway at {path}",
        MAX_TEXT_CHARS)}]
    return _envelope(thread_id, parts, run_id=run_id, session_id=session_id, cron_run_id=cron_run_id)


def tool_call_message(thread_id: str, *, tool_call_id: str, tool_name: str, args: Any, result: Any,
                      duration_ms=None, status: Optional[str] = None, error_type=None, error_message=None,
                      run_id=None, session_id=None, reasoning=None,
                      redact: Optional[Callable[[str], str]] = None) -> Dict[str, Any]:
    """One finished tool call (``post_tool_call`` fires after the fact, so the
    card is born complete — no back-fill). Args and result are redacted and
    bounded here, never forwarded raw."""
    ok = (status or "").lower() in ("", "ok", "success", "completed", "complete")
    part: Dict[str, Any] = {
        "type": "tool_call",
        "tool_call_id": tool_call_id or "",
        "tool_name": tool_name or "",
        "args": bounded(args, MAX_ARGS_CHARS, redact) if args not in (None, "", {}) else None,
        "result": bounded(result, MAX_RESULT_CHARS, redact) if result not in (None, "") else None,
        "duration_ms": duration_ms,
        "status": "complete" if ok else "error",
    }
    if not ok:
        detail = " ".join(str(x) for x in (error_type, error_message) if x) or (status or "error")
        part["error"] = bounded(detail, 500, redact)
    return _envelope(thread_id, _with_reasoning([part], reasoning), run_id=run_id, session_id=session_id)


def approval_message(thread_id: str, *, request_id: str, run_id: str, command: str, description: str,
                     choices: List[str], session_id=None, smart_denied: bool = False,
                     redact: Optional[Callable[[str], str]] = None) -> Dict[str, Any]:
    """The approval card: a tool_call part in ``approval_requested`` state plus
    the attention row hub-api keys the approval on. ``choices`` is the server-
    side contract for what the phone may answer — hub-api re-derives the
    allowed set from THIS frame, never from the client."""
    bad = [c for c in choices if c not in APPROVAL_CHOICES]
    if bad or not choices:
        raise ValueError(f"invalid approval choices {choices!r}")
    cmd = bounded(command, MAX_ARGS_CHARS, redact)
    desc = bounded(description or "dangerous command", 1000, redact)
    part: Dict[str, Any] = {
        "type": "tool_call",
        "tool_call_id": request_id,
        "tool_name": "terminal",
        "args": cmd,
        "status": "running",
        "state": "approval_requested",
        "choices": list(choices),
        "description": desc,
    }
    if smart_denied:
        part["smart_denied"] = True
    body = _envelope(thread_id, [part], run_id=run_id, session_id=session_id)
    body["attention"] = {
        "kind": "approval",
        "request_id": request_id,
        "run_id": run_id,
        "summary": bounded(f"terminal: {command}", MAX_SUMMARY_CHARS, redact),
    }
    return body


def clarify_message(thread_id: str, *, clarify_id: str, question: str, choices: Optional[List[str]],
                    multi_select: bool = False, run_id=None, session_id=None) -> Dict[str, Any]:
    """A clarify prompt as a widget the app can render as buttons/poll; the
    typed-text fallback still works because the adapter also calls
    ``mark_awaiting_text`` (base.py's own default does the same)."""
    part: Dict[str, Any] = {
        "type": "widget",
        "kind": "clarify",
        "widget_id": clarify_id,
        "question": bounded(question, 2000),
        "choices": [bounded(c, 200) for c in (choices or [])],
        "multi_select": bool(multi_select and choices),
    }
    body = _envelope(thread_id, [part], run_id=run_id, session_id=session_id)
    body["attention"] = {
        "kind": "question",
        "request_id": clarify_id,
        "run_id": run_id,
        "summary": bounded(question, MAX_SUMMARY_CHARS),
    }
    return body


def subagent_message(thread_id: str, *, phase: str, child_session_id: str, child_role: str,
                     child_goal=None, child_status=None, child_summary=None, duration_ms=None,
                     tool_call_count=None, run_id=None, session_id=None,
                     redact: Optional[Callable[[str], str]] = None) -> Dict[str, Any]:
    if phase not in ("start", "stop"):
        raise ValueError(f"phase must be start|stop, got {phase!r}")
    running = phase == "start"
    failed = (not running) and str(child_status or "").lower() not in ("", "ok", "success", "completed", "complete", "done")
    part: Dict[str, Any] = {
        "type": "tool_call",
        "tool_call_id": f"subagent:{child_session_id}",
        "tool_name": "delegate_task",
        "args": bounded({"role": child_role, "goal": child_goal} if child_goal else {"role": child_role}, MAX_ARGS_CHARS, redact),
        "status": "running" if running else ("error" if failed else "complete"),
        "duration_ms": duration_ms,
        "subagent": {
            "child_session_id": child_session_id,
            "child_role": child_role,
            "phase": phase,
            "tool_call_count": tool_call_count,
        },
    }
    if not running and child_summary:
        part["result"] = bounded(child_summary, MAX_RESULT_CHARS, redact)
    if failed:
        part["error"] = bounded(child_status, 200)
    return _envelope(thread_id, [part], run_id=run_id, session_id=session_id)


# --- inbound: hub-api -> gateway -----------------------------------------------

INBOUND_KINDS = ("message", "approval_decision", "clarify_response", "catalog_request", "ping", "stop",
                 "subagent_transcript")

# What the composer's three chips mean to the gateway. `_busy_text_mode` on the
# platform base class is one of interrupt|queue|steer and decides what happens
# to a message that arrives while a turn is already running: queue it, inject it
# at the next tool boundary, or cut into the turn. The chips were decorative
# because nothing carried the choice; this is the field that does. An
# unrecognised value is None, which leaves the gateway's own setting alone.
BUSY_MODE_ALIASES = {
    "queue": "queue",
    "steer": "steer",
    "redirect": "interrupt",
    "interrupt": "interrupt",
}


def parse_inbound_event(payload: Any) -> Dict[str, Any]:
    """Normalize one ``POST /api/platforms/hub/events`` body. Raises ValueError
    with a short, secret-free message on any shape problem — the adapter turns
    that into the response body, so nothing here may echo the payload back."""
    if not isinstance(payload, dict):
        raise ValueError("event must be an object")
    kind = payload.get("kind") or "message"
    if kind not in INBOUND_KINDS:
        raise ValueError("unknown event kind")
    if kind in ("catalog_request", "ping"):
        return {"kind": kind}

    thread_id = payload.get("thread_id")
    if kind != "clarify_response":
        if not isinstance(thread_id, str) or not THREAD_ID_RE.match(thread_id):
            raise ValueError("thread_id missing or malformed")

    if kind == "subagent_transcript":
        # Read-only: what one child session did, for the card the phone
        # expands. The session id is whatever hub-api validated against its own
        # record of this thread's subagent parts — the gateway does not hold
        # that mapping, so it does not re-derive it here.
        child = payload.get("child_session_id")
        if not isinstance(child, str) or not (1 <= len(child) <= 128):
            raise ValueError("child_session_id missing or malformed")
        return {"kind": "subagent_transcript", "thread_id": thread_id, "child_session_id": child}

    if kind == "stop":
        # Stop needs nothing but the thread: the adapter resolves that to the
        # session whose turn is in flight. A run_id from the client is not
        # trusted to choose what to interrupt.
        return {"kind": "stop", "thread_id": thread_id}

    if kind == "message":
        text = payload.get("text")
        if text is None:
            text = ""
        if not isinstance(text, str):
            raise ValueError("text must be a string")
        media_in = payload.get("media") or []
        if not isinstance(media_in, list):
            raise ValueError("media must be a list")
        media = []
        for item in media_in:
            if not isinstance(item, dict):
                raise ValueError("media item must be an object")
            mime = item.get("mime")
            data = item.get("data_b64")
            if not isinstance(mime, str) or not isinstance(data, str) or not data:
                raise ValueError("media item needs a mime and data_b64")
            entry = {"media_id": str(item.get("media_id") or ""), "mime": mime, "data_b64": data}
            if mime not in IMAGE_MIMES:
                # A file, not a picture. It is kept under a name, and the gateway needs
                # that name to cache it as a document.
                name = item.get("name")
                if not _FILE_MIME_RE.match(mime) or not isinstance(name, str) or not name.strip():
                    raise ValueError("a file media item needs a type/subtype mime and a name")
                entry["name"] = clean_name(name)
            media.append(entry)
        if not text.strip() and not media:
            raise ValueError("message has neither text nor media")
        seq = payload.get("seq")
        # Something that happened in the thread since the agent last heard from
        # the user — a checklist item ticked, say. It is appended to what the
        # agent reads and never shown in the Hub, where the user's bubble says
        # what they typed.
        note = payload.get("context_note")
        if note is not None and (not isinstance(note, str) or len(note) > 2000):
            raise ValueError("context_note must be a short string")
        return {
            "kind": "message",
            "context_note": note or "",
            "mode": BUSY_MODE_ALIASES.get(str(payload.get("mode") or "").strip().lower()),
            "thread_id": thread_id,
            "text": text,
            "message_id": str(payload.get("message_id") or "") or None,
            "client_msg_id": str(payload.get("client_msg_id") or "") or None,
            "seq": int(seq) if isinstance(seq, int) else None,
            "media": media,
        }

    if kind == "approval_decision":
        request_id = payload.get("request_id")
        choice = payload.get("choice")
        if not isinstance(request_id, str) or not request_id.strip():
            raise ValueError("request_id missing")
        if choice not in APPROVAL_CHOICES:
            raise ValueError("choice must be one of once|session|always|deny")
        reason = payload.get("reason")
        return {
            "kind": "approval_decision",
            "thread_id": thread_id,
            "request_id": request_id.strip(),
            "choice": choice,
            "run_id": str(payload.get("run_id") or "") or None,
            "reason": bounded(reason, 500) if isinstance(reason, str) and reason.strip() else None,
        }

    # clarify_response
    clarify_id = payload.get("clarify_id")
    response = payload.get("response")
    if not isinstance(clarify_id, str) or not clarify_id.strip():
        raise ValueError("clarify_id missing")
    if not isinstance(response, str):
        raise ValueError("response must be a string")
    return {"kind": "clarify_response", "clarify_id": clarify_id.strip(), "response": response,
            "thread_id": thread_id if isinstance(thread_id, str) else None}


# --- command catalog --------------------------------------------------------------

def build_catalog(*, builtins: List[Dict[str, Any]], skills: List[Dict[str, Any]],
                  aliases: List[Dict[str, Any]], plugins: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Merge the four registries into CommandCatalogEntry rows, applying the one
    live dispatch rule that changes what the picker should show: a plugin command
    whose name is also a ``quick_commands`` alias is permanently shadowed by that
    alias (the gateway rewrites aliases before it looks plugin commands up), so
    only the alias row is emitted."""
    out: List[Dict[str, Any]] = []
    seen: set = set()

    def add(name: str, category: str, description: str = "", arg_hint=None, busy_policy="dispatch", aliases_=None):
        if not name.startswith("/"):
            name = "/" + name
        if name in seen:
            return
        seen.add(name)
        out.append({
            "name": name,
            "aliases": [a if a.startswith("/") else "/" + a for a in (aliases_ or [])],
            "category": category,
            "description": (description or "")[:500],
            "arg_hint": (arg_hint or "").strip() or None,
            "busy_policy": busy_policy,
        })

    for b in builtins:
        add(b["name"], "builtin", b.get("description", ""), b.get("arg_hint"),
            b.get("busy_policy") or "reject", b.get("aliases") or [])
    for s in skills:
        add(s["name"], "skill", s.get("description", ""), None, "dispatch")
    alias_names = set()
    for a in aliases:
        name = a["name"] if a["name"].startswith("/") else "/" + a["name"]
        alias_names.add(name)
        target = a.get("target") or ""
        add(name, "alias", f"Alias for {target}" if target else "", None, "dispatch")
    for p in plugins:
        name = p["name"] if p["name"].startswith("/") else "/" + p["name"]
        if name in alias_names:
            continue
        add(name, "plugin", p.get("description", ""), p.get("arg_hint"), "reject")
    return out
