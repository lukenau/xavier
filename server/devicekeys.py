"""devicekeys — the native-app half of the Hub write gate.

An ADDITIVE second verifier alongside `webauthn_gate`. A browser keeps using WebAuthn
untouched; the native iOS app cannot (Apple's CDN must fetch an AASA file from the RP
domain, and a hub reachable only over a private mesh has no public domain for it to
fetch, so the app can never register a passkey against it).

Instead the app holds a P-256 keypair in the iPhone's Secure Enclave, created with
`.biometryCurrentSet` access control so the private key is unusable without a live
Face ID match. The server stores only the SPKI public key.

TRUST CHAIN — a device key is never self-asserted:
  1. the user opens the PWA Security page and completes a REAL WebAuthn assertion (Face ID
     against a registered passkey) for the gated action `devicekey.enroll_code`.
  2. That mints one 6-character code, in memory, TTL `ENROLL_CODE_TTL_S`, single-use,
     replacing any code still outstanding (only ever one live code). Wrong guesses are
     rate-limited (per-peer and globally), never fatal to the code, and every failure
     returns one indistinguishable error (see `_consume_enroll_code` for what the two
     tiers do and do not guarantee).
  3. The app posts that code plus its SPKI public key to /api/devicekey/register.
So a human passkey ceremony vouches for every device key that ever enters the store.

PER-ACTION PROOF — no new challenge machinery. The device key signs the SAME canonical
challenge bytes a WebAuthn authenticator signs: the raw bytes of the server-minted
challenge, i.e. `base64url_decode(challenge_b64)` of the string `assertion_options()`
returned. Purpose and context-hash binding stay in `webauthn_gate._ChallengeCache`
(see `webauthn_gate.verify_devicekey`), so an action proof cannot unlock the terminal
and a proof for one WriteRequest cannot be replayed against another.

HONEST LIMITATION: user-verification is enforced on the device by the Enclave's
`.biometryCurrentSet` access control — the key simply cannot sign without Face ID, and
re-enrolling a face/finger invalidates the key. The server CANNOT attest to that the way
WebAuthn's UV flag lets it: a signature proves possession of the Enclave key, not that a
biometric matched. An attacker with a jailbroken/compromised handset and the unlocked
Enclave is therefore inside this gate. That is the accepted trade-off for shipping a
native app on a tailnet-only origin; the WebAuthn path remains available and is strictly
stronger, and the two verifiers are independent (compromising one does not weaken the
other).
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

log = logging.getLogger("hub.devicekeys")

# Sibling of passkeys.json by construction, so it follows HUB_PASSKEYS wherever the
# deploy points it (in the container: /data/hub/devicekeys.json). Public keys only —
# no secret material.
# (HUB_PASSKEYS is re-read here rather than imported from webauthn_gate: webauthn_gate
# imports THIS module for its device-key branch, so the dependency only points one way.)
_PASSKEYS_JSON = Path(os.environ.get("HUB_PASSKEYS", "/data/hub/passkeys.json"))
DEVICEKEYS_JSON = Path(
    os.environ.get("HUB_DEVICEKEYS", str(_PASSKEYS_JSON.with_name("devicekeys.json")))
)
ENROLL_CODE_TTL_S = float(os.environ.get("HUB_ENROLL_CODE_TTL_S", "120"))
# Sliding-window rate limit on FAILED /api/devicekey/register attempts. A throttle, not a
# burn-after-N: the endpoint is unauthenticated by necessity (the app holds no credential
# yet), so burning the code on a failure count would let any tailnet peer destroy the user's
# pairing code mid-typing.
#
# TWO TIERS, because the peer key below is a HINT, not an authenticated identity:
#   * per-peer (5 / 30 s) — fairness. Stops ONE flooding caller from starving the user's own
#     attempt, but only to the extent the peer key is real. A caller that can forge the
#     forwarded header rotates keys and evades this tier entirely.
#   * global (200 / 30 s) — the tier that actually bounds brute force, precisely because
#     it cannot be evaded by forging a peer key. 200/30 s = 800 guesses across a 120 s
#     code TTL against a 2^30 space: p ~ 7.4e-7 per pairing ceremony.
#
# This is NOT a strict improvement on the single global 5/30 s it replaced. Against a
# caller who forges the peer hint the global tier is the only live bound, so the
# brute-force ceiling LOOSENED ~40x (20 guesses -> 800 per ceremony; 1.9e-8 -> 7.4e-7).
# Both are negligible and the DoS cost is unchanged, which is why the trade is worth it —
# but it is a trade, not a free win. Tighten HUB_ENROLL_CODE_GLOBAL_MAX_ATTEMPTS if the
# per-peer hint turns out to be absent in practice (see _peer_key in app.py).
#
# What this does NOT guarantee: an attacker willing to sustain 200 failed requests every
# 30 s can still keep the global tier saturated and block the user indefinitely. That is a
# loud, obvious flood (and it trips the WARNING below), not a silent denial, and the user can
# re-mint at will — but it is denial of pairing, and calling it otherwise would be a lie.
# See the report's "per-peer keying" section for why no stronger guarantee is reachable
# without an authenticated caller identity, which this deployment does not have.
ENROLL_CODE_MAX_ATTEMPTS = int(os.environ.get("HUB_ENROLL_CODE_MAX_ATTEMPTS", "5"))
ENROLL_CODE_ATTEMPT_WINDOW_S = float(os.environ.get("HUB_ENROLL_CODE_ATTEMPT_WINDOW_S", "30"))
ENROLL_CODE_GLOBAL_MAX_ATTEMPTS = int(os.environ.get("HUB_ENROLL_CODE_GLOBAL_MAX_ATTEMPTS", "200"))
# Bound the peer table: a caller forging a fresh peer key per request must not be able to
# grow it without limit. Oldest-touched key is evicted first.
ENROLL_PEER_TABLE_MAX = 256
# ONE error string for every failure mode. Distinct strings ("no code outstanding" vs
# "code invalid") were a free liveness oracle: an unauthenticated poller could learn the
# exact moment the user minted a code and start guessing only then.
_ENROLL_FAILED = "enrol code invalid, expired, or too many attempts"
# Unambiguous alphabet (no O/0, I/1) — the code is read off a screen and typed on a phone.
_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_CODE_LEN = 6
# A single Enclave key is ~91 bytes of SPKI DER; the cap is a cheap parse-bomb guard.
MAX_SPKI_B64_LEN = 1024
MAX_SIG_B64_LEN = 1024
MAX_LABEL_LEN = 64
MAX_KEY_ID_LEN = 128
MAX_CHALLENGE_LEN = 256
# A real code is _CODE_LEN chars; anything longer is a failed attempt like any other.
# Bounds live here rather than as pydantic Field(max_length=...) constraints: a
# constrained str makes pydantic reject a lone surrogate at the model boundary, and
# FastAPI's error body echoes the raw input, which Starlette then cannot encode — an
# unauthenticated 500. Enforcing here keeps every hostile input on the fail-closed path.
MAX_CODE_LEN = 64


class EnrollCodeError(Exception):
    """Raised when an enrol code is missing, expired, wrong, or already spent."""


class DeviceKeyError(Exception):
    """Raised when the submitted public key is not a usable P-256 SPKI key."""


class DeviceKeyStoreError(Exception):
    """Raised when devicekeys.json exists but cannot be parsed. Distinct from
    DeviceKeyError because it is a server-state fault, not a bad client payload —
    and because a write MUST NOT proceed over a store we could not read."""


# ---------------------------------------------------------------------------
# Enrol codes: in-memory, exactly like _ChallengeCache. In-memory is deliberate —
# a hub-api restart invalidates every pending code, and nothing hits disk.
# ---------------------------------------------------------------------------
_enroll_codes: dict[str, list[Any]] = {}  # code -> [expires_at_monotonic, unused]
_attempt_times: dict[str, list[float]] = {}  # peer key -> stamps of recent FAILED attempts
_global_attempts: list[float] = []  # stamps of recent FAILED attempts, all peers
_enroll_lock = threading.Lock()
# Compared as BYTES: hmac.compare_digest raises TypeError on a non-ASCII str, which on an
# unauthenticated endpoint is a 500 and an unmetered attempt. Encoding first makes every
# input — non-ASCII, lone surrogates, empty — take the ordinary failed-attempt path.
# Length matches a real code so the no-code-live path costs the same as a wrong guess.
_NO_LIVE_CODE = b"\x00" * _CODE_LEN  # unreachable through _CODE_ALPHABET


def mint_enroll_code() -> dict[str, Any]:
    """Mint the one live enrol code, replacing any outstanding one. Callable ONLY from
    the WebAuthn-gated `devicekey.enroll_code` action — never from the device-key path."""
    code = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_LEN))
    with _enroll_lock:
        _enroll_codes.clear()
        # A fresh human ceremony (already behind a passkey assertion) clears both tiers.
        _attempt_times.clear()
        _global_attempts.clear()
        _enroll_codes[code] = [time.monotonic() + ENROLL_CODE_TTL_S, None]
    return {
        "code": code,
        "ttl_s": int(ENROLL_CODE_TTL_S),
        "expires_at": time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + ENROLL_CODE_TTL_S)
        ),
    }


def _consume_enroll_code(candidate: str, peer: str = "-") -> None:
    """Spend the live enrol code or raise EnrollCodeError(_ENROLL_FAILED).

    Single-use and TTL-bound. Wrong guesses are RATE-LIMITED (per-peer and globally, see
    the constants above), never fatal to the code — a blocked attempt is not itself
    recorded, so every window drains on its own and the code survives to be retried.

    Every failure path — no code outstanding, expired, wrong, non-ASCII, throttled —
    raises the SAME message at the same status, so nothing tells a caller whether a code
    is currently live."""
    # Encode BEFORE comparing: compare_digest(str, str) raises TypeError on non-ASCII.
    # surrogatepass keeps a lone surrogate (legal in a Python str, illegal in UTF-8) on
    # this path instead of raising UnicodeEncodeError. Over-long input is truncated rather
    # than rejected early, so it stays an ordinary counted failure with no distinct reply.
    candidate_bytes = (candidate or "")[:MAX_CODE_LEN].encode("utf-8", "surrogatepass")
    with _enroll_lock:
        now = time.monotonic()
        for code in [c for c, (exp, _) in _enroll_codes.items() if exp < now]:
            _enroll_codes.pop(code, None)
        _prune_attempts_locked(now)
        bucket = _attempt_times.get(peer, [])
        if len(_global_attempts) >= ENROLL_CODE_GLOBAL_MAX_ATTEMPTS or len(bucket) >= ENROLL_CODE_MAX_ATTEMPTS:
            raise EnrollCodeError(_ENROLL_FAILED)
        live = next(iter(_enroll_codes), None)
        # Compare unconditionally (against a value no client alphabet can produce when
        # nothing is live) so the absent-code path costs the same time as a wrong guess.
        matched = hmac.compare_digest(live.encode() if live is not None else _NO_LIVE_CODE, candidate_bytes)
        if live is not None and matched:
            _enroll_codes.pop(live, None)  # single-use: spent on the first correct submit
            _attempt_times.clear()
            _global_attempts.clear()
            return
        _record_failure_locked(peer, now)
        raise EnrollCodeError(_ENROLL_FAILED)


def _prune_attempts_locked(now: float) -> None:
    _global_attempts[:] = [t for t in _global_attempts if now - t < ENROLL_CODE_ATTEMPT_WINDOW_S]
    for key in list(_attempt_times):
        kept = [t for t in _attempt_times[key] if now - t < ENROLL_CODE_ATTEMPT_WINDOW_S]
        if kept:
            _attempt_times[key] = kept
        else:
            del _attempt_times[key]


def _record_failure_locked(peer: str, now: float) -> None:
    """Record one failed attempt and log ONCE per window when a tier fills. Logging only
    on the filling attempt (never on subsequent blocked ones) keeps a flood from also
    being a log-flood, and the line says nothing about WHICH failure mode occurred, so it
    is not a liveness oracle — only that a tier tripped, and for which peer key."""
    bucket = _attempt_times.setdefault(peer, [])
    bucket.append(now)
    _global_attempts.append(now)
    while len(_attempt_times) > ENROLL_PEER_TABLE_MAX:
        _attempt_times.pop(next(iter(_attempt_times)))
    if len(bucket) == ENROLL_CODE_MAX_ATTEMPTS:
        log.warning("device-key enrol throttled: peer=%s hit %d failures in %.0fs",
                    peer, ENROLL_CODE_MAX_ATTEMPTS, ENROLL_CODE_ATTEMPT_WINDOW_S)
    if len(_global_attempts) == ENROLL_CODE_GLOBAL_MAX_ATTEMPTS:
        log.warning("device-key enrol GLOBAL throttle hit (%d failures in %.0fs) — pairing "
                    "is blocked for every caller until the window drains",
                    ENROLL_CODE_GLOBAL_MAX_ATTEMPTS, ENROLL_CODE_ATTEMPT_WINDOW_S)


# ---------------------------------------------------------------------------
# Store (devicekeys.json is a list of records; same load/save idiom as passkeys.json).
# ---------------------------------------------------------------------------
def load_devicekeys() -> list[dict[str, Any]]:
    if not DEVICEKEYS_JSON.exists():
        return []
    try:
        data = json.loads(DEVICEKEYS_JSON.read_text())
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


# Sync FastAPI endpoints run in uvicorn's threadpool, so register and revoke genuinely
# interleave. Every load -> mutate -> save sequence runs under this lock; guarding only
# the save is NOT enough — a revoke landing between another caller's load and save was
# silently lost, resurrecting a key that had just been revoked (and still reporting it
# revoked). Lock order is _store_lock -> _enroll_lock, never the reverse.
_store_lock = threading.RLock()


def _load_devicekeys_for_write() -> list[dict[str, Any]]:
    """Like load_devicekeys, but RAISES on a store that exists and will not parse.
    load_devicekeys() returning [] is right for the verify path (a corrupt store must
    authorize nothing), but a writer that treated [] as "empty" would silently overwrite
    whatever was in the file — including a store corrupted by an attacker or a bad disk."""
    if not DEVICEKEYS_JSON.exists():
        return []
    try:
        data = json.loads(DEVICEKEYS_JSON.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        raise DeviceKeyStoreError(
            f"device-key store is unreadable ({exc.__class__.__name__}); refusing to overwrite it"
        ) from exc
    if not isinstance(data, list):
        raise DeviceKeyStoreError("device-key store is not a JSON list; refusing to overwrite it")
    return data


def _save_devicekeys(items: list[dict[str, Any]]) -> None:
    """Atomic replace, mode 0600. CALLERS MUST HOLD `_store_lock` — this is one half of a
    read-modify-write and is not safe on its own.

    Read the mode bits honestly. The contents are PUBLIC keys, so reading them grants
    nothing; WRITE access is what matters — appending a public key here is equivalent to
    owning the gate. 0600 buys exactly one thing: an unprivileged process running as some
    OTHER uid cannot edit the file. It does NOT defend against the adversary that actually
    matters: an assistant container that mounts the same data directory read-write and
    runs as root ignores the mode bits entirely, and anything that can write the
    containing DIRECTORY can replace the file regardless. A prompt-injected agent with
    that mount therefore still owns this store. 0600 is kept because it is strictly
    better than passkeys.json's 0644 and costs nothing. Keeping BOTH stores outside any
    directory the assistant can write is the only real fix."""
    DEVICEKEYS_JSON.parent.mkdir(parents=True, exist_ok=True)
    tmp = DEVICEKEYS_JSON.with_name(DEVICEKEYS_JSON.name + ".tmp")
    tmp.write_text(json.dumps(items, indent=2))
    os.chmod(tmp, 0o600)
    tmp.replace(DEVICEKEYS_JSON)


def has_devicekey() -> bool:
    return len(load_devicekeys()) > 0


def devicekey_status() -> dict[str, Any]:
    keys = load_devicekeys()
    return {
        "paired": len(keys) > 0,
        "count": len(keys),
        # Label + timestamp ONLY, mirroring passkey_status(), which deliberately
        # withholds credential_id. key_id is not secret (it is sha256 of a public key and
        # proves nothing without the Enclave), but there is no reason to hand an
        # unauthenticated tailnet caller a stable per-device identifier either. The app
        # learns its own key_id from the /api/devicekey/register response.
        "devices": [
            {"label": k.get("label", "iPhone"), "created_at": k.get("created_at")}
            for k in keys
        ],
    }


# ---------------------------------------------------------------------------
# Key parsing / registration.
# ---------------------------------------------------------------------------
def _b64_to_bytes(value: str, limit: int) -> bytes:
    """Decode base64 or base64url (padded or not). Raises ValueError on anything else."""
    if not isinstance(value, str) or not value or len(value) > limit:
        raise ValueError("bad base64 length")
    normalized = value.replace("-", "+").replace("_", "/")
    try:
        return base64.b64decode(normalized + "=" * (-len(normalized) % 4), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("undecodable base64") from exc


def _load_p256_public(spki_der: bytes) -> ec.EllipticCurvePublicKey:
    try:
        pub = serialization.load_der_public_key(spki_der)
    except Exception as exc:  # noqa: BLE001 — any parse failure is a rejected key
        raise DeviceKeyError("not a DER SubjectPublicKeyInfo") from exc
    if not isinstance(pub, ec.EllipticCurvePublicKey) or not isinstance(pub.curve, ec.SECP256R1):
        raise DeviceKeyError("device key must be an EC P-256 (secp256r1) public key")
    return pub


def register_devicekey(
    code: str, spki_der_b64: str, label: str | None = None, peer: str = "-"
) -> dict[str, Any]:
    """Spend the enrol code, then persist the P-256 public key.

    The whole read -> consume -> parse -> write sequence holds `_store_lock`, so a
    concurrent revoke cannot be lost. The store is read (strictly) FIRST so an unreadable
    store fails before the code is spent; after that the code is consumed BEFORE the key
    is parsed, so a malformed key still costs the attacker the code."""
    with _store_lock:
        existing = _load_devicekeys_for_write()
        _consume_enroll_code(code, peer)
        try:
            spki_der = _b64_to_bytes(spki_der_b64, MAX_SPKI_B64_LEN)
        except ValueError as exc:
            raise DeviceKeyError(str(exc)) from exc
        _load_p256_public(spki_der)
        key_id = hashlib.sha256(spki_der).hexdigest()
        keys = [k for k in existing if k.get("key_id") != key_id]
        keys.append(
            {
                "key_id": key_id,
                "spki_der_b64": base64.b64encode(spki_der).decode(),
                "label": (label or "iPhone")[:MAX_LABEL_LEN],
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
        )
        _save_devicekeys(keys)
        return {"key_id": key_id, "count": len(keys)}


def revoke_devicekey(key_id: str | None = None, all_keys: bool = False) -> dict[str, Any]:
    """Unpair exactly one device key, or every one when `all_keys` is set.

    The caller MUST state which; the request model rejects "neither" and "both" before
    reaching here, so an omitted/typo'd field can never silently mean revoke-everything.
    Revoke-all exists because /api/devicekey/status deliberately discloses no key ids
    (it mirrors /api/passkey/status), so "unpair my phone" must be expressible without
    one. Both forms are reachable only behind a verified passkey assertion."""
    with _store_lock:
        keys = _load_devicekeys_for_write()
        if all_keys:
            if not keys:
                raise DeviceKeyError("no device key paired")
            _save_devicekeys([])
            return {"key_id": None, "revoked": len(keys), "count": 0}
        remaining = [k for k in keys if k.get("key_id") != key_id]
        if len(remaining) == len(keys):
            raise DeviceKeyError("unknown key_id")
        _save_devicekeys(remaining)
        return {"key_id": key_id, "revoked": len(keys) - len(remaining), "count": len(remaining)}


# ---------------------------------------------------------------------------
# Signature verification (the crypto half; challenge/purpose/context binding lives in
# webauthn_gate.verify_devicekey, which calls this only after consuming the challenge).
# ---------------------------------------------------------------------------
def verify_devicekey_signature(assertion: dict[str, Any], challenge_bytes: bytes) -> str | None:
    """Return the matched key_id iff `signature_b64` is a valid ECDSA-P256-SHA256
    signature by the enrolled key `key_id` over EXACTLY `challenge_bytes`.

    Signature encoding is X9.62 DER (what iOS SecKey / CryptoKit emit); the payload is
    the raw challenge bytes, hashed with SHA-256 as part of the ECDSA operation. Fails
    closed on every anomaly — unknown key_id, undecodable base64, corrupt stored SPKI,
    or a bad signature — and never distinguishes them to the caller."""
    key_id = assertion.get("key_id")
    if not isinstance(key_id, str) or not key_id or len(key_id) > MAX_KEY_ID_LEN:
        return None
    record = next((k for k in load_devicekeys() if k.get("key_id") == key_id), None)
    if record is None:
        return None  # reject unknown device key
    try:
        signature = _b64_to_bytes(assertion.get("signature_b64", ""), MAX_SIG_B64_LEN)
        pub = _load_p256_public(_b64_to_bytes(record.get("spki_der_b64", ""), MAX_SPKI_B64_LEN))
    except (ValueError, DeviceKeyError) as exc:
        log.warning("device-key assertion unusable: %s", exc)
        return None
    try:
        pub.verify(signature, challenge_bytes, ec.ECDSA(hashes.SHA256()))
    except (InvalidSignature, ValueError) as exc:
        log.warning("device-key signature verification failed: %s", exc)
        return None
    return key_id
