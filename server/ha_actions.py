"""HA action endpoints — per-action WebAuthn + dry-run apply.

Wiring per ADR 012 + ADR 011 amendment:
- POST /api/ha/challenge — returns a fresh WebAuthn challenge scoped to a
  specific proposal (challenge binds to the proposal's stable hash so
  the assertion can't be replayed against a different proposal).
- POST /api/ha/apply — verifies the assertion, then:
    * Day-1: appends a line to HA_WOULD_APPLY_LOG and returns dry_run_ok
    * Phase 2 (HA_LIVE_APPLY=true): proxies to HA's service-call API
      and returns applied status.

The propose side (POST /api/ha/propose) isn't implemented here — that
requires LLM plan-mode + HA MCP dry-run and stays Phase 2. The middleware
in app.py returns 405 for it with the generic "Phase 2" message.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import webauthn_gate as wa

router = APIRouter(prefix="/api/ha", tags=["ha"])

LOG_DIR = Path(os.environ.get("HUB_LOG_DIR", "/var/log/hub"))
HA_WOULD_APPLY_LOG = LOG_DIR / "ha-would-apply.jsonl"
HA_LIVE_APPLY = os.environ.get("HA_LIVE_APPLY", "").lower() in ("true", "1", "yes")

# The purpose this path binds its challenges to in the shared webauthn_gate cache —
# distinct from "action"/"terminal"/"chat" so an assertion minted for one of those
# can't unlock an HA apply, and vice versa.
HA_APPLY_PURPOSE = "ha_apply"


class ProposedChange(BaseModel):
    entity_id: str
    entity_label: str
    entity_icon: str
    kind: Literal["brightness", "color", "on_off", "climate", "media"]
    brightness: dict[str, Any] | None = None
    color: dict[str, Any] | None = None
    on_off: dict[str, Any] | None = None
    climate: dict[str, Any] | None = None
    media: dict[str, Any] | None = None


class Proposal(BaseModel):
    id: str
    source: Literal["pill", "scene", "ask"]
    request_text: str
    agent: Literal["concierge", "scout", "raw"]
    model: str
    changes: list[ProposedChange]
    created_at: str
    service_call_count: int


class ChallengeRequest(BaseModel):
    proposal: Proposal


class AssertionPayload(BaseModel):
    id: str
    raw_id: str
    client_data_json: str
    authenticator_data: str
    signature: str
    user_handle: str | None = None


class ApplyRequest(BaseModel):
    proposal: Proposal
    assertion: AssertionPayload


class AllowedCredential(BaseModel):
    id: str
    type: Literal["public-key"] = "public-key"


class ChallengeResponse(BaseModel):
    challenge: str
    rp_id: str
    user_verification: Literal["required", "preferred"] = "required"
    allowed_credentials: list[AllowedCredential]
    timeout_ms: int = Field(default=60_000)


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _proposal_hash(proposal: Proposal) -> str:
    return hashlib.sha256(_canonical_json(proposal.model_dump())).hexdigest()


@router.post("/challenge", response_model=ChallengeResponse)
def ha_challenge(req: ChallengeRequest) -> dict[str, Any]:
    """Assertion challenge for an HA apply, bound to this proposal's hash.

    Delegates entirely to the primary webauthn_gate: same passkey store, same
    single-use challenge cache, same purpose/context_hash binding every other
    privileged surface uses. There is no second challenge store here.
    """
    try:
        return wa.assertion_options(HA_APPLY_PURPOSE, _proposal_hash(req.proposal))
    except wa.NoPasskeyError:
        raise HTTPException(
            status_code=412,
            detail={"code": "no_passkey", "detail": "No passkey registered. Enrol via Settings before using HA actions."},
        )


def _log_would_apply(proposal: Proposal, credential_id: str) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "proposal_id": proposal.id,
        "request_text": proposal.request_text,
        "agent": proposal.agent,
        "model": proposal.model,
        "service_call_count": proposal.service_call_count,
        "changes": [
            {
                "entity_id": c.entity_id,
                "entity_label": c.entity_label,
                "kind": c.kind,
            }
            for c in proposal.changes
        ],
        "credential_id": credential_id,
        "dry_run": True,
    }
    with HA_WOULD_APPLY_LOG.open("a") as f:
        f.write(json.dumps(entry) + "\n")


def _live_apply(proposal: Proposal) -> dict[str, Any]:
    """Phase 2: proxy to HA's service-call API. Day-1 never reaches here
    unless HA_LIVE_APPLY=true AND ~/.hub/home-assistant.json has a token."""
    # Phase 2 implementation sketch (not yet invoked Day-1):
    #   - Read HA URL + long-lived token from ~/.hub/home-assistant.json
    #   - For each change, map (entity_icon, kind, values) to (domain, service, data)
    #   - POST https://home.<tailnet>.example.com/api/services/<domain>/<service>
    #     with Authorization: Bearer <token>
    #   - Collect results; partial-success handling
    # Until that's written, treat HA_LIVE_APPLY=true as a loaded gun: raise.
    raise HTTPException(
        status_code=501,
        detail={"code": "phase_2_pending", "detail": "HA_LIVE_APPLY=true but live-apply module not wired yet."},
    )


@router.post("/apply")
def ha_apply(req: ApplyRequest) -> dict[str, Any]:
    if not wa.has_passkey():
        raise HTTPException(
            status_code=412,
            detail={"code": "no_passkey", "detail": "No passkey registered."},
        )

    # The real cryptographic verification — origin/RP-ID check, user-verification
    # requirement, and the sign-count write-back for clone detection — all happen
    # inside webauthn_gate.verify_assertion, the same call every other privileged
    # surface (chat unlock, terminal, config-write actions) makes. It derives the
    # challenge from the assertion's own clientDataJSON and checks it against this
    # proposal's hash, so there is no separate challenge-matching loop here.
    expected_hash = _proposal_hash(req.proposal)
    cred_id = wa.verify_assertion(req.assertion.model_dump(), HA_APPLY_PURPOSE, expected_hash)
    if cred_id is None:
        raise HTTPException(
            status_code=403,
            detail={"code": "assertion_invalid", "detail": "Passkey verification failed."},
        )

    started = time.monotonic()
    if HA_LIVE_APPLY:
        outcome = _live_apply(req.proposal)
        return {
            "status": "applied",
            "applied_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "duration_ms": int((time.monotonic() - started) * 1000),
            "outcome": outcome,
        }

    _log_would_apply(req.proposal, cred_id)
    return {
        "status": "dry_run_ok",
        "applied_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "duration_ms": int((time.monotonic() - started) * 1000),
        "would_apply": f"{req.proposal.service_call_count} service calls logged to {HA_WOULD_APPLY_LOG}",
    }
