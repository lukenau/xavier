#!/usr/bin/env python3
"""Mint a one-time device enrolment code on the machine running the server.

This is the local, non-web mint path. ``./install.sh --pair`` runs it inside the
running hub-api container for you; it can also be run directly on any host that
can open the pair socket:

    python3 pair_cli.py [--socket /data/hub/pair.sock]

Nothing is sent over the network: the code is minted inside the running server
over a local ``AF_UNIX`` socket. The code is single-use, expires
(``HUB_ENROLL_CODE_TTL_S``, 120 s by default), and replaces any code still
outstanding — only one is ever live.
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import sys


def _connect(path: str) -> socket.socket:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(10.0)
    sock.connect(path)
    return sock


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pair_cli.py",
        description="Mint a one-time device enrolment code from the local server.",
    )
    parser.add_argument(
        "--socket",
        default=os.environ.get("HUB_PAIR_SOCK", "/data/hub/pair.sock"),
        help="path to the server's local pair socket "
        "(default: $HUB_PAIR_SOCK or /data/hub/pair.sock)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="print the raw JSON response instead of the human-readable form",
    )
    args = parser.parse_args(argv)

    if not os.path.exists(args.socket):
        print(
            f"No pair socket at {args.socket}.\n"
            "The server is not running, or local minting is off. Start it with\n"
            "  ./install.sh\n"
            "then run\n"
            "  ./install.sh --pair",
            file=sys.stderr,
        )
        return 2
    try:
        with _connect(args.socket) as sock:
            sock.sendall(json.dumps({"cmd": "pair"}).encode("utf-8") + b"\n")
            chunks: list[bytes] = []
            while True:
                buf = sock.recv(4096)
                if not buf:
                    break
                chunks.append(buf)
    except OSError as exc:
        print(f"Could not talk to the pair socket at {args.socket}: {exc}", file=sys.stderr)
        return 2

    try:
        reply = json.loads(b"".join(chunks).decode("utf-8") or "{}")
    except (ValueError, UnicodeDecodeError):
        print("The server returned an unreadable reply.", file=sys.stderr)
        return 3

    if args.json:
        print(json.dumps(reply))
        return 0 if reply.get("ok") else 3
    if not reply.get("ok"):
        print(f"Could not mint a code: {reply.get('error', 'unknown error')}", file=sys.stderr)
        return 3

    print()
    print(f"  Enrolment code:   {reply['code']}")
    print(f"  Valid for:        {reply.get('ttl_s', '?')} seconds")
    print(f"  Expires at:       {reply.get('expires_at', '?')} UTC")
    print()
    print("  Enter it in the app:  Config -> Security & approvals -> Passkeys & Face ID -> Face ID device key")
    print("  Single-use; minting another code replaces this one.")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
