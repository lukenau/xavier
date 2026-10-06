"""pair_local — mint a device enrolment code from the machine running the server.

The device-key trust chain (see devicekeys.py) is unchanged. An enrolment code is
still single-use, TTL-bound, and only ever one live at a time; post-enrolment
writes still require a device-key proof. What this module adds is a second,
non-network SURFACE that can trigger the *existing* mint function,
``devicekeys.mint_enroll_code()`` — the exact call the WebAuthn-gated
``devicekey.enroll_code`` action makes in app.py. It is not a second generator:
alphabet, length and TTL live in devicekeys.py, so the app's PairSheet keeps
agreeing.

Why it exists: the only mint surface used to be the Hub web UI. That UI is not
part of this repository, so a self-hoster who has shell on the box but no
browser reached Pair and dead-ended. Host shell access is already full trust
(it can rewrite the device-key store directly), so minting from the host adds
no privilege — it just removes a dependency on a surface that may not exist.

Trust boundary: an ``AF_UNIX`` domain socket on the server's own filesystem
(default ``/data/hub/pair.sock``, mode 0600). An ``AF_UNIX`` socket has no IP
address and no port, so it cannot be reached over the network; only a process
that can open the socket file — one already running as the hub's uid on this
machine — can mint. This is deliberately the same trust level as
``devicekeys.json`` itself, which that same access can overwrite.
"""
from __future__ import annotations

import json
import logging
import os
import socket
import threading
from pathlib import Path
from typing import Any

import devicekeys as dk

log = logging.getLogger("hub.pair")

# AF_UNIX by construction: a filesystem socket, never a TCP port. Exposed as a
# module constant so a test can assert the listener is not network-reachable.
SOCKET_FAMILY = socket.AF_UNIX

# Default matches the other hub-side unix sockets (ttyd, tmuxd) under
# /data/hub. Empty string disables local minting entirely.
DEFAULT_PAIR_SOCK = "/data/hub/pair.sock"
# One short JSON line in, one out. Bound so a hostile local writer cannot make
# the server allocate without limit; a real request is ~20 bytes.
_REQ_MAX = 4096
_ACCEPT_TIMEOUT_S = 1.0


def resolved_socket_path(path: str | None = None) -> str:
    """The pair-socket path: explicit arg, else $HUB_PAIR_SOCK, else the default."""
    if path is not None:
        return path
    return os.environ.get("HUB_PAIR_SOCK", DEFAULT_PAIR_SOCK)


def _handle_request(raw: bytes) -> dict[str, Any]:
    """Answer one local request. Only ``{"cmd": "pair"}`` mints; anything else is
    an honest error. Minting delegates to the same function the WebAuthn action
    uses, so there is exactly one code path."""
    try:
        msg = json.loads(raw.decode("utf-8") or "{}")
    except (ValueError, UnicodeDecodeError):
        return {"ok": False, "error": "malformed request"}
    if not isinstance(msg, dict):
        return {"ok": False, "error": "malformed request"}
    cmd = msg.get("cmd", "pair")
    if cmd == "pair":
        try:
            minted = dk.mint_enroll_code()
        except Exception as exc:  # noqa: BLE001 — never take the server down for a local caller
            log.warning("local pair: mint failed: %s", exc)
            return {"ok": False, "error": "could not mint a code"}
        return {"ok": True, **minted}
    if cmd == "ping":
        return {"ok": True, "pong": True}
    return {"ok": False, "error": "unknown command"}


def _serve(listener: socket.socket) -> None:
    """Accept loop. Codes are minted inline (the work is microseconds); a local
    client that connects and stalls cannot spin the server because each accepted
    connection is read with a short timeout."""
    while True:
        try:
            conn, _ = listener.accept()
        except OSError:
            return  # listener closed on shutdown
        try:
            with conn:
                conn.settimeout(_ACCEPT_TIMEOUT_S)
                raw = conn.recv(_REQ_MAX)
                reply = _handle_request(raw)
                conn.sendall(json.dumps(reply).encode("utf-8") + b"\n")
        except OSError:
            continue


def start_local_pair_server(path: str | None = None) -> socket.socket | None:
    """Bind and serve the local pair socket in a daemon thread.

    Returns the listening socket (for tests), or None when disabled, when the
    path is unusable, or on any bind failure. A failure here must NEVER stop the
    API server from starting — local minting is a convenience surface, not a
    dependency of the read or write paths."""
    sock_path = resolved_socket_path(path)
    if not sock_path:
        log.info("local pair minting disabled (HUB_PAIR_SOCK empty)")
        return None
    try:
        parent = Path(sock_path).parent
        parent.mkdir(parents=True, exist_ok=True)
        # Clear a stale socket left by a previous run. Never unlink a regular
        # file that happens to sit at this path.
        if os.path.lexists(sock_path):
            if not _is_socket(sock_path):
                log.warning("local pair: %s exists and is not a socket; local minting off", sock_path)
                return None
            os.unlink(sock_path)
        listener = socket.socket(SOCKET_FAMILY, socket.SOCK_STREAM)
        listener.bind(sock_path)
        os.chmod(sock_path, 0o600)
        listener.listen(8)
    except OSError as exc:
        log.warning("local pair: could not bind %s (%s); local minting off", sock_path, exc)
        return None
    threading.Thread(target=_serve, args=(listener,), name="pair-local", daemon=True).start()
    log.info("local pair minting on %s (unix socket, mode 0600)", sock_path)
    return listener


def _is_socket(path: str) -> bool:
    import stat as _stat

    try:
        return _stat.S_ISSOCK(os.stat(path).st_mode)
    except OSError:
        return False
