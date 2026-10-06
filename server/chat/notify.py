"""The one notification a reply earns, and only when the user is not looking at it.

Two rules: notify only while the app is in the background and a reply is still
arriving, and only for the agent's finished message — never while it is thinking
or making tool calls.

So: a turn's reasoning, its tool calls, its widgets-in-progress and its stream
deltas are all silent. What notifies is the finished prose of a turn — one
notification per turn, composed here because the server is what knows the turn
ended.

Presence is explicit rather than inferred. The app posts `active` when it comes
to the foreground and `background` when it leaves, and a report goes stale after
PRESENCE_TTL so an app that was killed outright (no background event) stops
counting as present rather than silencing the phone forever.

Delivery goes through Expo's push service: no APNs key lives on this server; Expo
holds it and resolves the token to the device.
"""
from __future__ import annotations

import json
import logging
import os
import time
import urllib.request
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

PUSH_TOKENS_FILE = Path(os.environ.get("HUB_PUSH_TOKENS", "/data/hub/data/push_tokens.json"))
EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
# Short on purpose: this runs off the delivery path, but a push that has not
# gone through in five seconds is not worth holding a thread for either.
TIMEOUT = 5
# How long an `active` report counts for. Longer than any plausible gap between
# the app's own foreground reports, short enough that a killed app goes quiet.
PRESENCE_TTL = 180.0
# iOS shows about this much of a body before it truncates.
BODY_CHARS = 140
TITLE_CHARS = 48

_presence: dict[str, Any] = {"state": "background", "at": 0.0}


def set_presence(state: str) -> dict[str, Any]:
    _presence["state"] = "active" if state == "active" else "background"
    _presence["at"] = time.monotonic()
    return presence()


def presence() -> dict[str, Any]:
    fresh = (time.monotonic() - _presence["at"]) < PRESENCE_TTL
    return {"state": _presence["state"], "fresh": fresh, "in_app": _presence["state"] == "active" and fresh}


def _clip(text: str, limit: int) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def notifiable_text(parts: list[dict[str, Any]]) -> str | None:
    """The prose of a finished reply, or None when this is not one.

    Reasoning, tool calls and approval cards are the turn working, not the turn
    answering. A widget-only reply still answered him, so it earns a line.
    """
    text = " ".join(
        str(p.get("text") or "") for p in parts if isinstance(p, dict) and p.get("type") == "text"
    ).strip()
    if text:
        return text
    kinds = {p.get("kind") for p in parts if isinstance(p, dict) and p.get("type") == "widget"}
    if kinds:
        return f"Drew a {sorted(k for k in kinds if isinstance(k, str))[0]}"
    return None


def compose(thread_title: str | None, text: str) -> dict[str, Any]:
    return {
        "title": _clip(thread_title or "Assistant", TITLE_CHARS),
        "body": _clip(text, BODY_CHARS),
        "sound": "default",
    }


def _tokens() -> list[str]:
    try:
        data = json.loads(PUSH_TOKENS_FILE.read_text())
    except (OSError, ValueError):
        return []
    rows = data.get("tokens") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        return []
    return [t["token"] for t in rows if isinstance(t, dict) and isinstance(t.get("token"), str)]


def _send(messages: list[dict[str, Any]], open_fn=None) -> list[dict[str, Any]]:
    req = urllib.request.Request(
        EXPO_PUSH_URL,
        method="POST",
        data=json.dumps(messages).encode(),
        headers={"content-type": "application/json", "accept": "application/json"},
    )
    opener = open_fn or (lambda r, t: urllib.request.urlopen(r, timeout=t))
    with opener(req, TIMEOUT) as r:
        body = json.loads(r.read().decode())
    data = body.get("data")
    return data if isinstance(data, list) else []


def notify_automation(*, job_name: str, run_id: str, text: str, open_fn=None) -> dict[str, Any]:
    """One push for what a scheduled job reported. Whether the job may push at
    all — its notify setting, a snooze, a run that only repeats the last one —
    is decided before this is called (`AutomationStore.should_push`)."""
    if presence()["in_app"]:
        return {"sent": 0, "reason": "in_app"}
    tokens = _tokens()
    if not tokens:
        return {"sent": 0, "reason": "no_devices"}
    message = compose(job_name, text)
    messages = [
        {**message, "to": token, "data": {"url": f"/automations/run?runId={run_id}", "run_id": run_id}}
        for token in tokens
    ]
    try:
        tickets = _send(messages, open_fn)
    except Exception as exc:  # noqa: BLE001 — a push must never fail a delivery
        logger.warning("automation push failed: %s", exc)
        return {"sent": 0, "reason": "send_failed"}
    return {"sent": len(tickets), "reason": "ok"}


def notify_reply(
    *, thread_id: str, thread_title: str | None, parts: list[dict[str, Any]], open_fn=None, url: str | None = None
) -> dict[str, Any]:
    """Called on a finished assistant message. Says what it did, for the tests
    and the log; never raises into the delivery path."""
    if presence()["in_app"]:
        return {"sent": 0, "reason": "in_app"}
    text = notifiable_text(parts)
    if text is None:
        return {"sent": 0, "reason": "not_a_reply"}
    tokens = _tokens()
    if not tokens:
        return {"sent": 0, "reason": "no_devices"}
    message = compose(thread_title, text)
    messages = [
        # The app's own route for a thread — a tap lands in the conversation it
        # is about, not on whatever tab the app was left on (the user, 2026-09-22).
        {**message, "to": token,
         "data": {"url": url or f"/chat/thread?threadId={thread_id}", "thread_id": thread_id}}
        for token in tokens
    ]
    try:
        tickets = _send(messages, open_fn)
    except Exception as exc:  # noqa: BLE001 — a push must never fail a delivery
        logger.warning("chat push failed: %s", exc)
        return {"sent": 0, "reason": "send_failed"}
    return {"sent": len(tickets), "reason": "ok"}
