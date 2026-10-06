"""The Hub chat cookie gate — VERDICT-V2 §4.1, mirroring the terminal unlock
(app.py's `/api/terminal/{challenge,session,logout}`, ~1572-1607) with two corrections
the plan calls out:

  - Path=/api/chat, not /terminal. A cookie scoped to /terminal is never sent on the
    chat WebSocket upgrade or a `/api/chat/media/{id}` load — both live under
    /api/chat/*, so the cookie has to match that prefix or the browser drops it.
  - `/api/chat/logout` REVOKES server-side. The terminal's logout only deletes the
    browser's cookie (`_term_session_drop` in app.py) but the in-process token it
    named lives on in `_TERM_SESSIONS` for the rest of its hour — a captured cookie
    keeps working after "logout" until the TTL expires. This module's logout instead
    pops the token from `_CHAT_SESSIONS` itself, the SAME dict `chat_session_valid`
    reads, so a revoked cookie fails on the very next request, from any client that
    presents it.

This module intentionally duplicates the small WebAuthn/device-key glue that lives on
`app` (AssertionPayload, DeviceKeyAssertion, GatedRequest, `_require_enrolled`,
`_verify_proof`) instead of importing it. app.py imports this module's router near the
top of the file — before any of those names exist as attributes of `app` — so
`from app import ...` here would be a genuine import-time circular reference, not just
an ordering nuisance. `webauthn_gate` and `devicekeys` have no such dependency on
`app.py`, so this module talks to them directly, the same shape `chat/platform.py`
already uses for its own (simpler, bearer-token) gate. The duplicated glue is ~30
lines and has no chat-specific behavior in it; if a third gated-cookie surface shows
up later, it's worth lifting this into its own module instead of a third copy.

The in-process `_CHAT_SESSIONS` dict is fine — it matches the terminal's own
precedent (`_TERM_SESSIONS` in app.py) and hub-api runs a single uvicorn worker
permanently (v2-decision-reliability.md §1) — but a hub-api restart empties it same as
`_TERM_SESSIONS`, so a restart invalidates every outstanding chat cookie and the app
must re-authenticate. That is the same behavior the terminal already has, not a
new gap this file introduces."""
from __future__ import annotations

import os
import json
import secrets
from pathlib import Path
import threading
import time
from typing import Any

from fastapi import APIRouter, Cookie, HTTPException, Response
from pydantic import BaseModel, model_validator

import devicekeys as dk
import webauthn_gate as wa

router = APIRouter(prefix="/api/chat", tags=["hub-chat-session"])

# Mirrors HUB_TERM_SESSION_TTL_S's env-tunable convention (app.py).
HUB_CHAT_SESSION_TTL_S = int(os.environ.get("HUB_CHAT_SESSION_TTL_S", "3600"))

# Active chat sessions: cookie token -> expiry (monotonic). Same shape and same
# single-worker justification as app.py's `_TERM_SESSIONS`.
_CHAT_SESSIONS: dict[str, float] = {}
# Sessions outlive the process. They used to live only in this dict, so every
# recreation of the container — about eighteen of them across 2026-09-27/28 —
# emptied it, every open socket 1008'd, and the user was asked for Face ID again
# ("sometimes the face id still resets"). Expiry is wall-clock so it means the
# same thing to the next process. Tokens are secrets: the file is 0600.
HUB_CHAT_SESSIONS_FILE = Path(os.environ.get("HUB_CHAT_SESSIONS_FILE", "/data/hub/chat/sessions.json"))


def _sessions_load() -> None:
    try:
        raw = json.loads(HUB_CHAT_SESSIONS_FILE.read_text())
    except (OSError, ValueError):
        return
    if not isinstance(raw, dict):
        return
    now = time.time()
    with _CHAT_LOCK:
        for token, exp in raw.items():
            if isinstance(token, str) and isinstance(exp, (int, float)) and exp > now:
                _CHAT_SESSIONS[token] = float(exp)


def _sessions_save_locked() -> None:
    """Caller holds _CHAT_LOCK. Never raises: a session that cannot be saved
    still works until this process ends, which is what it did before."""
    try:
        HUB_CHAT_SESSIONS_FILE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = HUB_CHAT_SESSIONS_FILE.with_name(HUB_CHAT_SESSIONS_FILE.name + ".tmp")
        # Created 0600, never widened first and narrowed after: the tokens
        # must not be world-readable for even the instant between the two.
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(_CHAT_SESSIONS))
        tmp.replace(HUB_CHAT_SESSIONS_FILE)
    except OSError:
        pass
_CHAT_LOCK = threading.Lock()


# --- gate glue (duplicated from app.py — see module docstring) ----------------
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


class ChatSessionRequest(GatedRequest):
    pass


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


def locked_gate_detail(surface: str) -> tuple[int, dict[str, str]]:
    """Status + body for a locked cookie gate (`surface` is "chat" or "terminal").

    Two states used to share the one message "… locked — unlock with Face ID", and
    on a fresh install that instruction named a credential the user does not have:

      * nothing enrolled yet — no passkey and no paired device. 412 `no_passkey`,
        the same code the challenge routes already answer, which the app renders as
        "enrol in Security first". The actionable step here is to ENROL.
      * a credential exists but the session lapsed (TTL, restart, logout). 401
        `<surface>_locked`. The actionable step here is to RE-AUTHENTICATE.
    """
    if wa.has_passkey() or dk.has_devicekey():
        return 401, {
            "code": f"{surface}_locked",
            "detail": f"The {surface} session has lapsed — re-authenticate to unlock it.",
        }
    return 412, {
        "code": "no_passkey",
        "detail": "No passkey or paired device registered yet. Enrol a passkey in Settings first.",
    }


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


_sessions_load()


# --- session tokens -----------------------------------------------------------
def _chat_session_new() -> str:
    token = secrets.token_urlsafe(32)
    with _CHAT_LOCK:
        # opportunistic GC, same as app.py's _term_session_new
        now = time.time()
        for t in [t for t, exp in _CHAT_SESSIONS.items() if exp < now]:
            _CHAT_SESSIONS.pop(t, None)
        _CHAT_SESSIONS[token] = now + HUB_CHAT_SESSION_TTL_S
        _sessions_save_locked()
    return token


def chat_session_valid(token: str | None) -> bool:
    """Exported for chat/routes.py (and the not-yet-built chat/ws.py, which must
    authenticate in-handler: `@app.middleware("http")` never runs on a WebSocket
    scope — see app.py's own note above `/terminal/ws`)."""
    if not token:
        return False
    with _CHAT_LOCK:
        exp = _CHAT_SESSIONS.get(token)
        if exp is None:
            return False
        if exp < time.time():
            _CHAT_SESSIONS.pop(token, None)
            _sessions_save_locked()
            return False
        return True


def _chat_session_drop(token: str | None) -> None:
    """The server-side revoke `/api/chat/logout` needs and the terminal's equivalent
    lacks: popping the token from the SAME dict `chat_session_valid` reads means a
    revoked cookie fails on its very next presentation, from anywhere."""
    if not token:
        return
    with _CHAT_LOCK:
        _CHAT_SESSIONS.pop(token, None)
        _sessions_save_locked()


# --- routes ---------------------------------------------------------------------
@router.post("/challenge")
def chat_challenge() -> dict[str, Any]:
    """Assertion challenge for the chat unlock — a passkey when one exists, else the
    native app's paired device key (`assertion_options_any`). Fails closed with 412
    only when NOTHING is enrolled."""
    try:
        return wa.assertion_options_any("chat", None)
    except wa.NoPasskeyError:
        raise HTTPException(
            status_code=412,
            detail={"code": "no_passkey", "detail": "No passkey registered. Enrol in Settings first."},
        )


@router.post("/session")
def chat_session(req: ChatSessionRequest, response: Response) -> dict[str, bool]:
    """Verify the assertion and, only on success, issue the hub_chat_session cookie.
    Path=/api/chat — NOT /terminal — so it rides on the chat WebSocket upgrade and any
    /api/chat/media/{id} load. Unknown/absent/invalid assertion -> 403/412."""
    _require_enrolled(req.devicekey_assertion)
    _verify_proof(req, "chat", None)
    token = _chat_session_new()
    response.set_cookie(
        "hub_chat_session",
        token,
        max_age=HUB_CHAT_SESSION_TTL_S,
        httponly=True,
        secure=True,
        samesite="strict",
        path="/api/chat",
    )
    return {"ok": True}


@router.post("/logout")
def chat_logout(response: Response, hub_chat_session: str | None = Cookie(default=None)) -> dict[str, bool]:
    """Revokes server-side BEFORE deleting the cookie — see module docstring for why
    this differs from the terminal's logout."""
    _chat_session_drop(hub_chat_session)
    response.delete_cookie("hub_chat_session", path="/api/chat")
    return {"ok": True}
