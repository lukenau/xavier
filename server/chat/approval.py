"""Hub chat approval gate — VERDICT-V2 §4.3, §7 T3.

Two routes under `/api/chat/approval/`, mirroring `/api/action/{challenge,apply}` and
`/api/decisions/{id}/{challenge,answer}` byte-for-byte (same file's patterns, new
purpose string): hash+validate before a challenge is issued, re-validate+re-derive
before the proof is verified, verify BEFORE any write lands. Never the hourly
`hub_chat_session` cookie (chat/session.py) — VERDICT-V2 §3 is explicit that `always`
resolves to `approve_permanent()`, a bare process-global set with no session or
platform filter that durably deletes a safety gate estate-wide by rewriting the
coordinator-owned config.yaml. That is a bigger write than anything else currently
behind Face ID, so every approval decision gets a FRESH signed `WriteRequest`,
`purpose="approval"`, batched as one signature over exactly the N decisions rendered
on one card (v2-decision-approvals-auth.md §"Batching rule").

THE CONTRACT (T3, verified against live source and, until this file, not fixed
anywhere in code — the task brief that produced this module states it as (a)-(e);
kept verbatim as the section markers below):

  (a) `choice` is a server-side Literal["once","session","always","deny"]
      (`ApprovalDecision.choice` below) — a signature proves WHO signed, never that
      the signed value was ever a legitimate offered value.
  (b) the allowed choices for ONE decision are re-derived from THAT decision's own
      stored approval record — the `frame` an already-committed
      `/api/platform/hub/deliver` call persisted into `chat/store.py`'s `approvals`
      table — via `_offered_choices` below, and checked in `_validate_approval_decisions`
      BEFORE `_verify_proof` ever runs. This copies the precedent
      `/api/decisions/{id}/answer` already sets for `option_key`: re-derive against the
      card's own server-stored options, never trust the client's say-so.
  (c) the context hash binds the EXACT decision list shown: sha256 over canonical JSON
      of `{request_id, run_id, choice}` sorted by `request_id` (`_approval_ctx_hash`) —
      identical recipe to `_canonical_write_hash` / `_decision_answer_hash` in app.py,
      no new crypto. A signature minted for "approve req_4c, deny req_9a" cannot be
      replayed against "approve req_4c, approve req_9a" or against a third
      `request_id` that was never on the card.
  (d) `chat/store.py`'s `answer_approval` is the local answered-set: its
      `WHERE answered=0` update is an atomic CAS, so a retry or a double-tap on an
      already-answered decision is a no-op that returns what was actually recorded
      the first time — it never reaches a second write, and (once phase 3 adds
      forwarding) it can never reach a second forward call. The gateway's own REST
      endpoint pops the FIFO head with no `request_id` targeting
      (v2-decision-approvals-auth.md point 4) — a retry racing a second queued
      approval on that path answers the WRONG command; hub-api's per-decision CAS,
      keyed on the actual `(run_id, request_id)` pair, cannot make that mistake.
  (e) there is no "answer everything pending" shortcut — no `all` field exists on
      either request model, and both use `extra="forbid"`, so a caller that sends one
      gets a 422 at the schema boundary before any handler code runs. The signed
      payload is always the explicit list the user actually picked on one card, matching
      the batching rule verbatim: "never more (no `all:true`, ever), never fewer if
      he answered several on one card." This is deliberate and permanent, not an
      oversight to "fix" later by adding a bulk-apply convenience — the gateway's own
      `all:true` (`approval.py:2658-2661`, a blind FIFO sweep) is the exact footgun
      this refusal exists to keep unreachable from the Hub.

This slice does NOT forward an answered decision to the gateway — that is phase 3,
once the plugin's `pre_approval_request` hook + thread-local `request_id` stash
exists (v2-decision-approvals-auth.md, point 1). `answer_approval` records the
decision durably and leaves `forward_status='pending'`; nothing in this file ever
reads or advances that column.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, model_validator

import devicekeys as dk
import webauthn_gate as wa
from chat import imessage_draft as chat_imessage_draft
from chat.platform import get_store
from chat.routes import forward_gateway_event

router = APIRouter(prefix="/api/chat/approval", tags=["hub-chat-approval"])

# A rendered card is the user's own visible screen real estate, not an unbounded batch —
# this is a sanity bound on the request body, not a product decision about how many
# approvals can ever be open at once.
MAX_DECISIONS_PER_CARD = 20

_ALL_CHOICES = frozenset({"once", "session", "always", "deny"})
# T3 §(b)'s fail-closed floor. The real Hub adapter is contracted (VERDICT-V2 §9,
# map-gateway-run-api.md's live-verified `approval.request` shape) to stamp an
# explicit `choices` list onto the delivered part — `["once","deny"]` when
# smart_denied, `["once","session","always","deny"]` when allow_permanent, else
# `["once","session","deny"]` — but that adapter is phase-2 build, not yet shipped,
# so every approval frame stored today carries no such list. Absent one, only the two
# choices with no durable, estate-wide consequence are ever assumed offered: "session"
# and, above all, "always" are NEVER assumed just because a client asked for them.
_DEFAULT_OFFERED_CHOICES = frozenset({"once", "deny"})


# --- gate glue (duplicated from chat/session.py, which duplicates it from app.py —
# see chat/session.py's module docstring for why: app.py imports this package's
# routers before any of `app`'s own names exist as attributes, so importing them back
# would be a genuine import-time circular reference. webauthn_gate/devicekeys have no
# such dependency, so every gated-cookie/gated-write surface in this package talks to
# them directly. chat/session.py's docstring already flags a third copy as the
# expected shape if a third surface showed up; this is that third surface.) ----------
class AssertionPayload(BaseModel):
    id: str
    raw_id: str
    client_data_json: str
    authenticator_data: str
    signature: str
    user_handle: str | None = None


class DeviceKeyAssertion(BaseModel):
    key_id: str
    challenge_b64: str
    signature_b64: str


class GatedRequest(BaseModel):
    """EXACTLY ONE proof — the PWA's WebAuthn assertion or the native app's device-key
    signature. Neither (or both) is a 422."""

    assertion: AssertionPayload | None = None
    devicekey_assertion: DeviceKeyAssertion | None = None

    @model_validator(mode="after")
    def _exactly_one_proof(self) -> "GatedRequest":
        if (self.assertion is None) == (self.devicekey_assertion is None):
            raise ValueError("exactly one of assertion / devicekey_assertion is required")
        return self


def _require_enrolled(devicekey_assertion: DeviceKeyAssertion | None) -> None:
    if devicekey_assertion is not None:
        if not dk.has_devicekey():
            raise HTTPException(
                status_code=412,
                detail={"code": "no_devicekey", "detail": "No device key paired."},
            )
        return
    if not wa.has_passkey():
        raise HTTPException(
            status_code=412,
            detail={"code": "no_passkey", "detail": "No passkey registered."},
        )


def _verify_proof(req: GatedRequest, purpose: str, ctx_hash: str | None) -> str:
    if req.devicekey_assertion is not None:
        key_id = wa.verify_devicekey(req.devicekey_assertion.model_dump(), purpose, ctx_hash)
        if key_id is None:
            raise HTTPException(
                status_code=403,
                detail={"code": "assertion_invalid", "detail": "Device key verification failed."},
            )
        return f"devicekey:{key_id}"
    cred_id = wa.verify_assertion(req.assertion.model_dump(), purpose, ctx_hash)  # type: ignore[union-attr]
    if cred_id is None:
        raise HTTPException(
            status_code=403,
            detail={"code": "assertion_invalid", "detail": "Passkey verification failed."},
        )
    return f"passkey:{cred_id}"


# --- request models --------------------------------------------------------------
# Each decision names its stored approval by the store's own primary key (run_id,
# request_id) — NOT `session_key` as an earlier draft of this design
# (v2-decision-approvals-auth.md) sketched before chat/store.py's schema landed.
# session_key is never needed here: it lives on the thread row
# (`threads.session_key`, set once at creation) and phase 3's forward step reads it
# from there via `thread_id`, not from anything the client supplies.
class ApprovalDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    run_id: str
    request_id: str
    choice: Literal["once", "session", "always", "deny"]  # (a)


class ApprovalChallengeRequest(BaseModel):
    """No `all` field, ever — see module docstring §(e). `extra="forbid"` means a
    caller that sends one gets a 422 before any handler code runs."""

    model_config = ConfigDict(extra="forbid")

    decisions: list[ApprovalDecision]

    @model_validator(mode="after")
    def _bounds(self) -> "ApprovalChallengeRequest":
        if not self.decisions:
            raise ValueError("decisions must be non-empty")
        if len(self.decisions) > MAX_DECISIONS_PER_CARD:
            raise ValueError(f"decisions over {MAX_DECISIONS_PER_CARD} per card")
        seen: set[tuple[str, str]] = set()
        for d in self.decisions:
            key = (d.run_id, d.request_id)
            if key in seen:
                raise ValueError(f"duplicate decision {key!r} in one card")
            seen.add(key)
        return self


class ApprovalApplyRequest(ApprovalChallengeRequest, GatedRequest):
    pass


# --- validation / hashing ---------------------------------------------------------
def _offered_choices(frame: dict[str, Any]) -> frozenset[str]:
    """T3 §(b): the choices a decision may resolve to are whatever its OWN stored
    delivery frame says the gateway actually offered — never trusted from the client,
    and never assumed to be the full Literal universe just because it type-checks.

    Looks for an explicit `choices` list on any part of the delivered frame (the shape
    the Hub adapter is contracted to stamp on the approval's `tool_call` part — see
    module docstring). Intersected with `_ALL_CHOICES` as defence in depth: `parts` are
    untyped `dict[str, Any]` at the `/api/platform/hub/deliver` boundary
    (chat/platform.py), so a malformed or poisoned `choices` value in a part can never
    smuggle in a string outside the fixed universe (a) already constrains `choice` to.

    Falls back to `_DEFAULT_OFFERED_CHOICES` when no part carries one — true of every
    approval this slice can currently produce, since the adapter that populates it is
    not yet shipped (VERDICT-V2 §9)."""
    for part in frame.get("parts") or []:
        if isinstance(part, dict) and isinstance(part.get("choices"), list):
            offered = {c for c in part["choices"] if isinstance(c, str)}
            return frozenset(offered) & _ALL_CHOICES
    return _DEFAULT_OFFERED_CHOICES


def _validate_approval_decisions(decisions: list[ApprovalDecision]) -> None:
    """Shape-validate BEFORE a challenge is issued or a proof is verified — same
    posture as `_validate_decision_answer` in app.py. Every decision in the batch must
    name a stored, still-open approval, and its choice must be in THAT row's own
    offered set (b) — never a bare Literal check alone (a) is not sufficient on its
    own, which is exactly what T3 found missing everywhere else this pattern exists."""
    store = get_store()
    for d in decisions:
        approval = store.get_approval(run_id=d.run_id, request_id=d.request_id)
        if approval is None:
            raise HTTPException(
                status_code=404,
                detail={"code": "not_found",
                        "detail": f"no approval {d.request_id!r} for run {d.run_id!r}"},
            )
        if approval["answered"]:
            # (d): an already-answered decision is a dead end here, not a second write.
            raise HTTPException(
                status_code=409,
                detail={"code": "already_answered",
                        "detail": f"{d.request_id!r} was already answered",
                        "request_id": d.request_id, "choice": approval["choice"]},
            )
        offered = _offered_choices(approval["frame"])
        if d.choice not in offered:
            raise HTTPException(
                status_code=400,
                detail={"code": "bad_request",
                        "detail": f"choice {d.choice!r} was not offered for {d.request_id!r} "
                                  f"(offered: {sorted(offered)})"},
            )


def _approval_ctx_hash(decisions: list[ApprovalDecision]) -> str:
    """(c): same recipe as `_canonical_write_hash` / `_decision_answer_hash` in
    app.py — sorted, separator-tight, sort_keys JSON — computed server-side at BOTH
    challenge and apply time from the SAME decisions the client sent, never supplied
    directly. Sorted by `request_id` so the order the client listed them in can never
    change the hash (v2-decision-approvals-auth.md's own recipe, restated)."""
    sorted_decisions = sorted(
        ({"request_id": d.request_id, "run_id": d.run_id, "choice": d.choice} for d in decisions),
        key=lambda d: d["request_id"],
    )
    payload = json.dumps(sorted_decisions, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()


# --- routes ------------------------------------------------------------------------
@router.post("/challenge")
def approval_challenge(req: ApprovalChallengeRequest) -> dict[str, Any]:
    """Validate + hash the proposed batch and return an assertion challenge bound to
    it (mirrors `/api/decisions/{id}/challenge` exactly). Purpose `"approval"` is a
    new, distinct value in webauthn_gate's challenge cache — a terminal/action/topics/
    decisions/chat proof can never satisfy this route, and vice versa."""
    _validate_approval_decisions(req.decisions)
    ctx_hash = _approval_ctx_hash(req.decisions)
    try:
        return wa.assertion_options_any("approval", ctx_hash)
    except wa.NoPasskeyError:
        raise HTTPException(
            status_code=412,
            detail={"code": "no_passkey", "detail": "No passkey registered. Enrol in Settings first."},
        )


@router.post("/apply")
def approval_apply(req: ApprovalApplyRequest) -> dict[str, Any]:
    """Verify the assertion (bound to THIS exact batch), then atomically resolve each
    decision. Re-derives/re-validates before verifying — 400/404/409 on tamper or a
    stale card, exactly like `action_apply` and `decision_answer`."""
    _require_enrolled(req.devicekey_assertion)
    _validate_approval_decisions(req.decisions)  # re-derive/validate; 400s on tamper
    ctx_hash = _approval_ctx_hash(req.decisions)
    _verify_proof(req, "approval", ctx_hash)
    store = get_store()
    results = []
    for d in req.decisions:
        # The pre-check above already rejected an already-answered row with a 409 for
        # the WHOLE batch, but a proof takes real wall-clock time to present (Face ID)
        # — (d)'s CAS is what actually protects against a concurrent answer landing in
        # that window, not the pre-check alone.
        row, applied = store.answer_approval(run_id=d.run_id, request_id=d.request_id, choice=d.choice)
        forward_status, forward_reason = row["forward_status"], row.get("forward_reason") or ""
        if applied:
            if store.get_imessage_draft_by_request(d.request_id) is not None:
                # A hub-originated iMessage draft (chat/store.py's
                # `upsert_imessage_draft`): no gateway turn is parked on this
                # approval, so there is nothing to forward. The decision IS the
                # action — send (once = send, deny = discard) on the Mac, exactly
                # once, through the same shared record the Discord button uses.
                # `set_approval_forward_status` still runs so the `approval.answered`
                # frame closes the card on every open client.
                chat_imessage_draft.complete_draft_decision(d.run_id, d.request_id, row["choice"])
                forward_status, forward_reason = "local", "iMessage draft"
                store.set_approval_forward_status(
                    run_id=d.run_id, request_id=d.request_id, status=forward_status, reason=forward_reason
                )
            else:
                # Phase 3: the decision reaches the gateway as an approval_decision
                # event and the hub adapter resolves exactly this request_id. A
                # forward failure leaves the row answered-but-pending (durably
                # distinguishable) — the agent's own approval timeout still fails
                # closed on its side.
                forward_status, forward_reason = forward_gateway_event({
                    "kind": "approval_decision",
                    "thread_id": row["thread_id"],
                    "run_id": d.run_id,
                    "request_id": d.request_id,
                    "choice": row["choice"],
                })
                store.set_approval_forward_status(
                    run_id=d.run_id, request_id=d.request_id, status=forward_status, reason=forward_reason
                )
        results.append({
            "request_id": d.request_id,
            "run_id": d.run_id,
            "status": "answered" if applied else "already_answered",
            "choice": row["choice"],
            "forward_status": forward_status,
            "forward_reason": forward_reason,
        })
    return {"status": "ok", "decisions": results}
