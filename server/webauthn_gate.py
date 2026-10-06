"""webauthn_gate — the ONE real WebAuthn gate for the Assistant hub write/control layer.

Slice 2b security foundation. A single passkey gate backs every privileged surface:
  * enrolment            — register a platform authenticator into passkeys.json
  * the write-action gate — /api/action/{challenge,apply} (config.set, cron.*)
  * the terminal unlock   — /api/terminal/{challenge,session}
  * the HA apply gate     — /api/ha/{challenge,apply} (purpose "ha_apply", context_hash
                             = sha256 of the proposal; see server/ha_actions.py)

All verification uses the well-tested `py_webauthn` library
(verify_registration_response / verify_authentication_response) — NO hand-rolled
crypto. Every assertion is checked against a credential registered in passkeys.json;
unknown credentials are rejected; anything unexpected fails CLOSED (returns
None / raises), never a silent pass.

Challenge binding: each challenge is cached with a `purpose` ("register" |
"action" | "terminal") and, for actions, a `context_hash` (the sha256 of the exact
WriteRequest). An assertion is only accepted if the challenge it signed is still
cached AND its purpose (and, for actions, its context_hash) match — so a terminal
assertion can't unlock an action, and an assertion for one WriteRequest can't be
replayed against another.

The challenge <-> assertion link is derived from the signed clientDataJSON (which
carries the base64url challenge), so we never have to guess which cached challenge
an assertion belongs to.

2026-09-10: `verify_devicekey` (bottom of this file) adds an ADDITIVE second verifier
for the native iOS app, which cannot hold a passkey for this tailnet-only RP. It reuses
this module's challenge cache and binding rules verbatim; nothing above it changed.
"""
from __future__ import annotations

import json
import logging
import os
import secrets
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any

from webauthn import (
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
from webauthn.helpers.structs import (
    AuthenticatorAttachment,
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

import devicekeys

log = logging.getLogger("hub.webauthn")

PASSKEYS_JSON = Path(os.environ.get("HUB_PASSKEYS", "/data/hub/passkeys.json"))
RP_NAME = os.environ.get("HUB_RP_NAME", "Hub")
USER_NAME = os.environ.get("HUB_USER_NAME", "user")
USER_DISPLAY = os.environ.get("HUB_USER_DISPLAY", "the user")
# Stable single-user handle (WebAuthn user.id): constant so re-enrolment maps to the
# same account. Must be <= 64 bytes.
USER_HANDLE = os.environ.get("HUB_USER_HANDLE", "hub-user").encode()[:64]


def _first_origin(raw: str) -> str:
    """HUB_ORIGIN is documented as a comma-separated list; a WebAuthn ceremony binds
    to exactly ONE origin, so the first entry is the one the gate uses."""
    return raw.split(",")[0].strip()


def _normalise_origin(raw: str) -> str | None:
    """scheme://host[:port] for a usable http(s) origin, else None.

    `expected_origin` is an exact string comparison, so a bare hostname or a trailing
    slash would fail in the browser with no clue. Normalising here surfaces a bad value
    at the gate (ConfigError) instead of at the user's Face ID prompt."""
    candidate = _first_origin(raw)
    if not candidate:
        return None
    try:
        parts = urllib.parse.urlsplit(candidate)
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError:  # malformed port / bracketed host
        return None
    if parts.scheme not in ("http", "https") or not host:
        return None
    return f"{parts.scheme}://{host}{f':{port}' if port else ''}"


def _origin_host(origin: str | None) -> str:
    try:
        return (urllib.parse.urlsplit(origin or "").hostname or "").lower()
    except ValueError:
        return ""


# The relying party every passkey is bound to. BOTH values are optional in the
# environment: ORIGIN (HUB_ORIGIN) is the exact origin a browser uses to reach this
# hub, and RP_ID (HUB_RP_ID) is the hostname the credential is scoped to, derived from
# ORIGIN's host when not set explicitly. There is deliberately NO `localhost` fallback:
# that default is right on exactly one machine, and everywhere else it turns a passkey
# ceremony into an unactionable browser-side failure. When either is missing the
# WebAuthn entry points below raise ConfigError naming the variable to set (see
# _require_config). HUB_PUBLIC_BASE is NOT a fallback: its placeholder default points
# nowhere, so deriving from it would repeat the same "looks set but isn't" trap.
ORIGIN: str | None = _normalise_origin(os.environ.get("HUB_ORIGIN", ""))
RP_ID: str | None = os.environ.get("HUB_RP_ID", "").strip() or (_origin_host(ORIGIN) or None)


def _require_config() -> tuple[str, str]:
    """The (rp_id, origin) a WebAuthn ceremony will be bound to, or raise ConfigError.

    Fails here — server-side, with the variable named — rather than letting a mismatched
    relying party or origin fail inside the browser. The disposition is deliberate: an
    explicit HUB_ORIGIN is REQUIRED (there is no safe default origin), while RP_ID is
    DERIVED from it. The origin is not derived from the request Host either: a
    client-supplied Host would let the caller choose what the passkey is bound to,
    which is exactly the origin binding this gate exists to enforce."""
    if not ORIGIN or not RP_ID:
        raise ConfigError(
            "WebAuthn is not configured: no public origin is set, so passkeys cannot be "
            "registered or verified. Set HUB_ORIGIN to the exact origin your browser uses "
            "to reach this hub (for example https://hub.example.com, or "
            "http://localhost:8090 for a local-only install), then restart the server. "
            "HUB_RP_ID defaults to that origin's hostname and only needs setting when it "
            "must differ."
        )
    host = _origin_host(ORIGIN)
    if RP_ID != host and not host.endswith("." + RP_ID):
        raise ConfigError(
            f"HUB_RP_ID ({RP_ID}) is neither HUB_ORIGIN's hostname ({host}) nor a parent "
            f"domain of it, so no browser could complete a passkey ceremony. Set "
            f"HUB_RP_ID={host} (or unset it to derive that default), then restart."
        )
    return RP_ID, ORIGIN

# Face-ID ceremony window: comfortably long for the create/get prompt, short enough
# that a leaked challenge is useless within a minute or two.
CHALLENGE_TTL_S = float(os.environ.get("HUB_CHALLENGE_TTL_S", "120"))


class NoPasskeyError(Exception):
    """Raised when a passkey-gated flow is attempted with no credential enrolled."""


class ChallengeError(Exception):
    """Raised when a registration challenge is missing/expired/wrong-purpose."""


class ConfigError(RuntimeError):
    """Raised when a WebAuthn flow is attempted on a host with no public origin set.

    Distinct from the fail-closed None/ChallengeError paths: this is a server
    misconfiguration, not an attacker-controlled anomaly, so it is surfaced to the
    caller as an actionable message instead of a silent rejection."""


# ---------------------------------------------------------------------------
# Challenge cache: challenge_b64u -> (purpose, context_hash | None, expires_at).
# Single uvicorn worker, but sync endpoints run in a threadpool, so guard with a lock.
# ---------------------------------------------------------------------------
class _ChallengeCache:
    def __init__(self) -> None:
        self._store: dict[str, tuple[str, str | None, float]] = {}
        self._lock = threading.Lock()

    def _gc_locked(self) -> None:
        now = time.monotonic()
        for c in [c for c, (_, _, exp) in self._store.items() if exp < now]:
            self._store.pop(c, None)

    def put(self, challenge: str, purpose: str, context_hash: str | None = None) -> None:
        with self._lock:
            self._gc_locked()
            self._store[challenge] = (purpose, context_hash, time.monotonic() + CHALLENGE_TTL_S)

    def take(self, challenge: str) -> tuple[str, str | None] | None:
        """Pop-and-return (purpose, context_hash) if present & unexpired, else None.
        Single-use: a challenge is consumed on the first take (no replay)."""
        with self._lock:
            self._gc_locked()
            entry = self._store.pop(challenge, None)
            if entry is None:
                return None
            purpose, ctx, _ = entry
            return purpose, ctx


_cache = _ChallengeCache()


# ---------------------------------------------------------------------------
# Passkey store (passkeys.json is a list of credential records).
# ---------------------------------------------------------------------------
def load_passkeys() -> list[dict[str, Any]]:
    if not PASSKEYS_JSON.exists():
        return []
    try:
        data = json.loads(PASSKEYS_JSON.read_text())
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _save_passkeys(items: list[dict[str, Any]]) -> None:
    PASSKEYS_JSON.parent.mkdir(parents=True, exist_ok=True)
    tmp = PASSKEYS_JSON.with_name(PASSKEYS_JSON.name + ".tmp")
    tmp.write_text(json.dumps(items, indent=2))
    tmp.replace(PASSKEYS_JSON)


def has_passkey() -> bool:
    return len(load_passkeys()) > 0


def passkey_status() -> dict[str, Any]:
    passkeys = load_passkeys()
    return {
        "registered": len(passkeys) > 0,
        "count": len(passkeys),
        # False means HUB_ORIGIN is unset, so enrolment/verification would refuse
        # (see _require_config). Surfaced here so the Settings UI can say why.
        "configured": bool(ORIGIN and RP_ID),
        "rp_id": RP_ID,
        "credentials": [
            {"label": p.get("label", "Face ID"), "created_at": p.get("created_at")}
            for p in passkeys
        ],
    }


# ---------------------------------------------------------------------------
# Registration (enrolment). Needs the user's platform authenticator once.
# ---------------------------------------------------------------------------
def registration_options() -> dict[str, Any]:
    """PublicKeyCredentialCreationOptions (as a JSON-ready dict) for
    navigator.credentials.create(). Caches the challenge under purpose 'register'.
    Raises ConfigError when no public origin is configured (see _require_config)."""
    rp_id, _ = _require_config()
    passkeys = load_passkeys()
    opts = generate_registration_options(
        rp_id=rp_id,
        rp_name=RP_NAME,
        user_id=USER_HANDLE,
        user_name=USER_NAME,
        user_display_name=USER_DISPLAY,
        authenticator_selection=AuthenticatorSelectionCriteria(
            authenticator_attachment=AuthenticatorAttachment.PLATFORM,
            resident_key=ResidentKeyRequirement.PREFERRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
        exclude_credentials=[
            PublicKeyCredentialDescriptor(id=base64url_to_bytes(p["credential_id"]))
            for p in passkeys
            if p.get("credential_id")
        ],
    )
    _cache.put(bytes_to_base64url(opts.challenge), "register", None)
    # options_to_json emits spec-shaped base64url fields the browser helper decodes.
    return json.loads(options_to_json(opts))


def verify_registration(credential: dict[str, Any], label: str | None = None) -> dict[str, Any]:
    """Verify an attestation from navigator.credentials.create() and persist the
    credential to passkeys.json. Raises ConfigError (no origin configured) or
    ChallengeError / Exception on failure."""
    rp_id, origin = _require_config()
    response = credential.get("response") if isinstance(credential, dict) else None
    client_data_b64u = (response or {}).get("clientDataJSON")
    if not client_data_b64u:
        raise ChallengeError("missing clientDataJSON")
    try:
        client_data = json.loads(base64url_to_bytes(client_data_b64u))
    except Exception as exc:  # noqa: BLE001
        raise ChallengeError("unparseable clientDataJSON") from exc
    challenge_b64u = client_data.get("challenge")
    entry = _cache.take(challenge_b64u) if challenge_b64u else None
    if entry is None or entry[0] != "register":
        raise ChallengeError("registration challenge expired or unknown")

    verification = verify_registration_response(
        credential=json.dumps(credential),
        expected_challenge=base64url_to_bytes(challenge_b64u),
        expected_rp_id=rp_id,
        expected_origin=origin,
        require_user_verification=True,
    )

    cred_id_b64u = bytes_to_base64url(verification.credential_id)
    passkeys = [p for p in load_passkeys() if p.get("credential_id") != cred_id_b64u]
    passkeys.append(
        {
            "credential_id": cred_id_b64u,
            "public_key": bytes_to_base64url(verification.credential_public_key),
            "sign_count": verification.sign_count,
            "transports": (response or {}).get("transports") or [],
            "label": label or "Face ID",
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
    )
    _save_passkeys(passkeys)
    return {"credential_id": cred_id_b64u, "count": len(passkeys)}


# ---------------------------------------------------------------------------
# Assertion (the gate for both actions and the terminal).
# ---------------------------------------------------------------------------
def assertion_options(purpose: str, context_hash: str | None = None) -> dict[str, Any]:
    """AssertionChallenge for navigator.credentials.get(). Fails closed (NoPasskeyError)
    when nothing is enrolled, and raises ConfigError when no public origin is configured.
    `challenge` is base64url of the raw challenge bytes; the browser helper decodes it
    before signing."""
    passkeys = load_passkeys()
    if not passkeys:
        raise NoPasskeyError()
    rp_id, _ = _require_config()
    challenge_b64u = secrets.token_urlsafe(32)
    _cache.put(challenge_b64u, purpose, context_hash)
    return {
        "challenge": challenge_b64u,
        "rp_id": rp_id,
        "user_verification": "required",
        "allowed_credentials": [
            {"id": p["credential_id"], "type": "public-key"}
            for p in passkeys
            if p.get("credential_id")
        ],
        "timeout_ms": 60_000,
    }


def assertion_options_any(purpose: str, context_hash: str | None = None) -> dict[str, Any]:
    """Challenge for EITHER proof, for callers that accept both.

    A passkey when one is enrolled (unchanged `assertion_options` output, so the PWA
    is unaffected). Otherwise, if a native device key is paired, issue a challenge in
    the same shape: the native signer signs these exact raw bytes and posts
    `challenge_b64`, which `verify_devicekey` looks up in the SAME `_ChallengeCache`
    under the same purpose/context hash. Without this fallback every challenge route
    answered 412 `no_passkey` on a device-key-only install — the native app could pair
    but never unlock chat/terminal or make any gated write.

    `rp_id`/`allowed_credentials`/`user_verification` are WebAuthn fields the native
    signer ignores; they are filled for shape parity only. No public origin is
    required for the device-key branch, so this works on a tailnet-only install.
    """
    if load_passkeys():
        return assertion_options(purpose, context_hash)
    if not devicekeys.has_devicekey():
        raise NoPasskeyError()
    challenge_b64u = secrets.token_urlsafe(32)
    _cache.put(challenge_b64u, purpose, context_hash)
    return {
        "challenge": challenge_b64u,
        "rp_id": RP_ID or "",
        "user_verification": "preferred",
        "allowed_credentials": [],
        "timeout_ms": 60_000,
    }


def verify_assertion(
    assertion: dict[str, Any], expected_purpose: str, expected_context_hash: str | None
) -> str | None:
    """Verify a WebAuthn assertion against passkeys.json for the given purpose/context.

    Returns the matched credential_id (b64url) on success, else None. Fails closed on
    every anomaly: no passkeys, no/expired challenge, wrong purpose, wrong context hash,
    unknown credential, or a bad signature. On success the stored sign_count is advanced
    (clone/replay detection). Raises ConfigError (not None) when the host has no public
    origin configured — that is a server misconfiguration, not an attacker anomaly."""
    passkeys = load_passkeys()
    if not passkeys:
        return None
    rp_id, origin = _require_config()

    client_data_b64u = assertion.get("client_data_json")
    if not client_data_b64u:
        return None
    try:
        client_data = json.loads(base64url_to_bytes(client_data_b64u))
    except Exception:  # noqa: BLE001
        return None
    challenge_b64u = client_data.get("challenge")
    if not challenge_b64u:
        return None

    entry = _cache.take(challenge_b64u)
    if entry is None:
        return None  # unknown/expired/already-consumed challenge
    purpose, ctx = entry
    if purpose != expected_purpose:
        return None
    if expected_context_hash is not None and ctx != expected_context_hash:
        return None

    cred_id = assertion.get("id")
    cred = next((p for p in passkeys if p.get("credential_id") == cred_id), None)
    if cred is None:
        return None  # reject unknown credential

    try:
        verification = verify_authentication_response(
            credential=json.dumps(
                {
                    "id": assertion["id"],
                    "rawId": assertion.get("raw_id", assertion["id"]),
                    "response": {
                        "clientDataJSON": assertion["client_data_json"],
                        "authenticatorData": assertion["authenticator_data"],
                        "signature": assertion["signature"],
                        "userHandle": assertion.get("user_handle"),
                    },
                    "type": "public-key",
                }
            ),
            expected_challenge=base64url_to_bytes(challenge_b64u),
            expected_rp_id=rp_id,
            expected_origin=origin,
            credential_public_key=base64url_to_bytes(cred["public_key"]),
            credential_current_sign_count=cred.get("sign_count", 0),
            require_user_verification=True,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("assertion verification failed: %s", exc)
        return None

    # Advance sign_count for clone detection; persist best-effort.
    cred["sign_count"] = verification.new_sign_count
    try:
        _save_passkeys(passkeys)
    except OSError as exc:
        log.warning("could not persist sign_count: %s", exc)
    return cred_id


# ---------------------------------------------------------------------------
# Device-key branch (native iOS app) — ADDITIVE. Everything above is unchanged.
#
# The native app cannot hold a passkey for this RP (tailnet-only origin, Apple's CDN
# cannot fetch the AASA), so it proves possession of a Secure-Enclave P-256 key instead.
# The proof reuses THIS module's challenge machinery verbatim: same _ChallengeCache,
# same single-use take(), same purpose check, same context_hash check. The only thing
# that differs is the signature format — raw ECDSA-P256-SHA256 over the challenge bytes
# instead of a WebAuthn authenticatorData||sha256(clientDataJSON) blob.
#
# The canonical signed bytes are base64url_to_bytes(challenge_b64) — i.e. the SAME raw
# challenge bytes a browser authenticator embeds in clientDataJSON for this challenge.
# See devicekeys.py for the trust chain and the user-verification caveat.
# ---------------------------------------------------------------------------
def verify_devicekey(
    assertion: dict[str, Any], expected_purpose: str, expected_context_hash: str | None
) -> str | None:
    """Verify a device-key assertion for the given purpose/context.

    Returns the matched key_id on success, else None. Mirrors verify_assertion's
    fail-closed posture: no device key enrolled, unknown/expired/already-consumed
    challenge, wrong purpose, wrong context hash, unknown key_id or a bad signature all
    return None. The challenge is consumed on the first take() whatever the outcome, so
    a proof is single-use even when it fails."""
    if not devicekeys.has_devicekey():
        return None

    challenge_b64u = assertion.get("challenge_b64")
    if (
        not isinstance(challenge_b64u, str)
        or not challenge_b64u
        or len(challenge_b64u) > devicekeys.MAX_CHALLENGE_LEN
    ):
        return None
    try:
        challenge_bytes = base64url_to_bytes(challenge_b64u)
    except Exception:  # noqa: BLE001 — malformed challenge string
        return None

    entry = _cache.take(challenge_b64u)
    if entry is None:
        return None  # unknown/expired/already-consumed challenge
    purpose, ctx = entry
    if purpose != expected_purpose:
        return None
    if expected_context_hash is not None and ctx != expected_context_hash:
        return None

    return devicekeys.verify_devicekey_signature(assertion, challenge_bytes)
