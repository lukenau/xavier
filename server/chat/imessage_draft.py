"""First-answer-wins resolution for iMessage drafts.

The ONE place that turns a human decision (send / discard) into at most one
`send_draft` call, shared by every surface that can offer one:

  * the Hub chat card — `POST /api/chat/approval/apply` (chat/approval.py), the
    WebAuthn-gated route the app's `DraftApprovalCard` already signs against,
  * the Discord #approvals button — app.py's `_approval_press`,
  * the web approval link — app.py's `POST /api/imessage/send/{id}`.

A draft is stored as an ordinary `approvals` row keyed (run_id, request_id)
(chat/store.py's `upsert_imessage_draft`), so `ChatStore.answer_approval`'s
`WHERE answered=0` CAS IS the shared first-answer-wins store: whichever surface
answers FIRST flips it and only that caller proceeds; every other one gets
`applied=False`. This module adds only the step after the CAS — actually sending
an approved draft through the sender app.py injects (`set_sender`). The MCP
plumbing (`_imessage_tool_call`, `MacUnreachable`, `ImessageMcpError`) stays in
app.py and is never imported here, so the import-time circularity every other
chat module dodges is dodged here too.

`retry_unsent=True` lets the web link re-attempt the SEND for a decision that is
already `once` when the previous attempt never reached the Mac (unreachable,
refused, or still pending there) — that is not a second ANSWER, and it is the
only retry any surface gets. A draft whose decision is `deny`, or whose send
already landed ("sent"), is a dead end everywhere.
"""
from __future__ import annotations

from typing import Any, Callable

from chat.platform import get_store

# (outcome, detail): "sent" | "pending" | "unreachable" | "error" | "unconfirmed".
# Never raises. Injected by app.py, which owns the Mac MCP call.
Sender = Callable[[int], "tuple[str, str]"]

_sender: Sender | None = None
_decider: "Callable[[int, str], None] | None" = None

# Outcomes a retry may re-attempt the send for: the Mac never ACCEPTED the draft,
# so a re-send cannot be a duplicate. Anything else is terminal.
_RETRYABLE = frozenset({"unreachable", "error", "pending"})
# Outcomes that mean the draft is done: never send it again.
_TERMINAL = frozenset({"sent", "unconfirmed", "denied"})


def set_sender(fn: Sender | None) -> None:
    """Register the normalized Mac send. app.py calls this once at import."""
    global _sender
    _sender = fn


def set_decider(fn: "Callable[[int, str], None] | None") -> None:
    """Register the Mac decision callback (`decide_draft`): applies the user's
    approve/deny to the Mac's own draft gate so a Hub answer is sufficient on its
    own. Optional — when unset, the draft simply keeps its Discord/tapback path."""
    global _decider
    _decider = fn


def _mac_decide(draft_id: int, decision: str) -> None:
    """Best-effort: never raises, never blocks a Hub-side answer."""
    if _decider is None:
        return
    try:
        _decider(draft_id, decision)
    except Exception:  # noqa: BLE001
        pass


def _result(draft: dict[str, Any], *, status: str, decided: bool) -> dict[str, Any]:
    return {
        "status": status,
        "decided": decided,
        "draft_id": draft["draft_id"],
        "thread_id": draft["thread_id"],
        "contact": draft["contact"],
        "text": draft["text"],
        "decision": "deny" if draft["choice"] == "deny" else ("approve" if draft["choice"] else None),
        "choice": draft["choice"],
        "outcome": draft["outcome"],
        "detail": draft["detail"],
    }


def resolve_imessage_draft(
    draft_id: int, decision: str, *, retry_unsent: bool = False
) -> dict[str, Any] | None:
    """Answer one draft, at most once.

    `decision` is "approve" (send) or "deny" (discard). Returns the resolved draft
    row (with a `status`) or `None` when no such draft is on record — the caller
    then decides whether an un-mirrored draft may still be sent the legacy way.
    `status` is one of:

      * "denied"            — this call recorded a discard
      * "approved"          — this call recorded a send (or re-sent one)
      * "already_answered"  — another surface answered first; nothing was sent
    """
    store = get_store()
    draft = store.get_imessage_draft(draft_id)
    if draft is None:
        return None
    choice = "deny" if decision == "deny" else "once"
    try:
        _row, applied = store.answer_approval(
            run_id=draft["run_id"], request_id=draft["request_id"], choice=choice
        )
    except KeyError:
        # The draft row exists but its stored approval is gone (should not happen
        # — they are written together). There is no CAS left to win, so proceed;
        # `_complete`'s terminal-outcome guard keeps it from re-sending.
        _row, applied = None, True
    if not applied:
        # The first answer already happened. Re-attempting the SEND of an
        # already-approved draft is not a second answer; anything else is a dead
        # end and must not reach the Mac.
        if (
            retry_unsent
            and choice == "once"
            and draft["choice"] != "deny"
            and draft["outcome"] in _RETRYABLE
        ):
            return _result(_complete(store, draft["draft_id"], "once"), status="approved", decided=False)
        return _result(store.get_imessage_draft(draft_id) or draft, status="already_answered", decided=False)
    done = _complete(store, draft["draft_id"], choice)
    return _result(done, status=("denied" if choice == "deny" else "approved"), decided=True)


def complete_draft_decision(run_id: str, request_id: str, choice: str) -> dict[str, Any] | None:
    """The step AFTER `answer_approval`'s CAS, for the Hub apply route: act on a
    draft decision exactly once. A no-op (returns None) for an ordinary tool
    approval, which is what lets chat/approval.py call it unconditionally."""
    store = get_store()
    draft = store.get_imessage_draft_by_request(request_id)
    if draft is None:
        return None
    return _complete(store, draft["draft_id"], choice)


def _complete(store, draft_id: int, choice: str) -> dict[str, Any]:
    """Send (or record the discard) once, then record the Mac's outcome on the
    draft row. Idempotent against a terminal outcome — a resend only ever happens
    for a draft whose previous attempt never reached the Mac."""
    draft = store.get_imessage_draft(draft_id)
    if draft is None:  # pragma: no cover — callers resolved it a moment ago
        return {"draft_id": draft_id, "thread_id": "", "contact": "", "text": "",
                "choice": choice, "outcome": None, "detail": ""}
    if choice == "deny":
        _mac_decide(draft_id, "deny")
        return store.mark_imessage_draft_outcome(
            draft_id=draft_id, choice="deny", outcome="denied"
        ) or draft
    if draft["outcome"] in _TERMINAL:
        return draft
    outcome, detail = _send(draft_id)
    return store.mark_imessage_draft_outcome(
        draft_id=draft_id, choice="once", outcome=outcome, detail=detail
    ) or draft


def _send(draft_id: int) -> tuple[str, str]:
    if _sender is None:
        return "error", "send path not configured"
    try:
        return _sender(draft_id)
    except Exception as exc:  # noqa: BLE001 — a sender must never take the route down
        return "error", str(exc)[:200]
