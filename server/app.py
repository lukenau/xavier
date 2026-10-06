"""hub-api — the FastAPI server behind the app.

- Reads (GET) serve cached files and optional integrations (the assistant gateway,
  the hub-bridge sidecar, the calendar snapshot, the /files roots). Most reads are
  unauthenticated: the network boundary is the access control (see SECURITY.md).
  The chat, terminal and tmux surfaces are cookie-gated.
- Writes: only the prefixes in POST_ALLOWLIST_PREFIXES accept a POST (anything else
  is a 405), and the comment beside each prefix names its gate. Sensitive writes need
  a fresh per-action proof — a WebAuthn passkey assertion or a paired device-key
  signature over a server-minted challenge (webauthn_gate.py, devicekeys.py).
- Every request must name an allowed Host (HostAllowlistMiddleware, at the end of
  this file): a defence against DNS rebinding, since the server binds loopback.
- One optional subprocess call: `openclaw status --json` (fixed argv), only when
  OPENCLAW_BIN names that binary.

The container listens on 0.0.0.0:8090; docker-compose publishes it on 127.0.0.1
only. Put a private mesh or an authenticating TLS proxy in front (docs/MESH.md).
"""
from __future__ import annotations

import asyncio
import ast
import hashlib
import hmac
import html
import http.client
import json
import logging
import mimetypes
import os
import re
import secrets as secrets_mod
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

import websockets
from fastapi import Cookie, Depends, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, model_validator

import devicekeys as dk
import pair_local
import webauthn_gate as wa
from ha_actions import router as ha_router
from files import router as files_router
from hub_calendar import router as calendar_router
from hub_tz import hub_tz
from chat.approval import router as chat_approval_router
from chat.automations import platform_router as chat_automations_platform_router
from chat.automations import router as chat_automations_router
from chat.automations import badge_router as chat_automations_badge_router
from chat import imessage_draft as chat_imessage_draft
from chat.platform import _platform_key_dep, get_store, platform_key_valid, router as chat_platform_router
from chat.store import ATTENTION_KIND_IMESSAGE_DRAFT
from chat.routes import router as chat_routes_router
from chat.routes import forward_gateway_event as chat_forward_gateway_event
from chat.routes import send_user_text as chat_send_user_text
from chat.session import router as chat_session_router, chat_session_valid, locked_gate_detail
from chat.ws import router as chat_ws_router
import live_session  # the wiring below sets its send_message, stop_run and origin_ok

logger = logging.getLogger("hub.api")

LOG_DIR = Path(os.environ.get("HUB_LOG_DIR", "/var/log/hub"))
HEALTH_JSONL = LOG_DIR / "healthcheck.jsonl"
RESTIC_JSON = LOG_DIR / "restic-snapshots.json"
COST_WATCH_JSONL = LOG_DIR / "cost-watch.jsonl"
OR_PROXY_JSONL = LOG_DIR / "or-proxy.jsonl"
ACCESS_JSON = Path(os.environ.get("HUB_ACCESS_REPORT", str(Path.home() / ".hub/access-report.json")))
ROSTER_JSON = Path(os.environ.get("HUB_ROSTER", str(Path.home() / ".hub/agents.json")))
ACTIVITY_JSON = Path(os.environ.get("HUB_ACTIVITY", str(Path.home() / ".hub/activity.json")))
SCHEDULES_JSON = Path(os.environ.get("HUB_SCHEDULES", str(Path.home() / ".hub/schedules.json")))
SKILLS_JSON = Path(os.environ.get("HUB_SKILLS", str(Path.home() / ".hub/skills.json")))
MY_PAGES_ROOT = Path(os.environ.get("MY_PAGES_ROOT", str(Path.home() / "Sites/my-pages")))
# Agent-dropped feed cards + status line (see /api/feed). The dir may not exist
# yet on a given box — every reader treats absence as an honest empty source.
INBOX_DIR = Path(os.environ.get("HUB_INBOX_DIR", "/data/hub-inbox"))
PASSKEYS_JSON = Path(os.environ.get("HUB_PASSKEYS", str(Path(__file__).parent / "passkeys.json")))
OPENCLAW_BIN = os.environ.get("OPENCLAW_BIN", "")
HERMES_API_BASE = os.environ.get("HERMES_API_BASE", "")
HERMES_API_KEY = os.environ.get("HERMES_API_KEY", "")
HERMES_AGENT_ID = os.environ.get("HERMES_AGENT_ID", "hermes")
HERMES_AGENT_NAME = os.environ.get("HERMES_AGENT_NAME", "Xavier")
# litellm has been decommissioned: the cockpit's spend surfaces now read native
# Hermes state.db via the hub-bridge /spend capability, the Chat model list is a
# static direct-provider tier list, and vitals no longer probes litellm/postgres.
# CLI-bridge (Slice 2a) — privileged sidecar that runs hermes-CLI-only reads via
# `docker exec example-gateway hermes <argv>`. hub-api holds NO docker socket; it POSTs
# argv to the bridge over the compose network and the bridge enforces a strict READ-ONLY
# allowlist. Empty base = feature disabled (honest errors, never fake-green).
HUB_BRIDGE_URL = os.environ.get("HUB_BRIDGE_URL", "")
# Slightly above the bridge's own 30s exec timeout so we surface the bridge's honest
# "timed out" body rather than tripping our own connection timeout first.
HUB_BRIDGE_TIMEOUT_S = float(os.environ.get("HUB_BRIDGE_TIMEOUT_S", "35"))
# Shared bearer key for the bridge: the SAME file the bridge reads, holding the SAME
# key install.sh mints beside the hub-platform key. Sent as Authorization: Bearer on
# every bridge call so the bridge (which holds the docker socket) authenticates us.
# Read from the file only, never an env var; re-read per call so a rotation takes
# effect without a restart. Unset/empty = no header sent (the bridge then 503s, since
# it fails closed) — kept non-fatal so a key-less demo bridge still works.
HUB_BRIDGE_KEY_FILE = Path(os.environ.get("HUB_BRIDGE_KEY_FILE", "/data/hub-bridge/HUB_BRIDGE_KEY"))


def _bridge_headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    headers = dict(extra or {})
    try:
        key = HUB_BRIDGE_KEY_FILE.read_text().strip()
    except OSError:
        key = ""
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return headers
CACHE_MAX_AGE_S = int(os.environ.get("HUB_CACHE_MAX_AGE_S", "900"))
# Terminal backend: the host ttyd (set up by host/install.sh) binds a UNIX-DOMAIN
# SOCKET, not a TCP port, in a directory only its user and the hub's group can enter
# (/run/xavier, mounted read-only by host/compose.host.yml). Nothing on the network
# reaches it; anything that can open the socket file has a shell, which is why the
# directory must never be mounted anywhere else. The /terminal proxy below forwards
# http + websocket to it ONLY after a valid hub_term_session cookie, which is issued
# exclusively by a verified assertion (POST /api/terminal/session). Empty = off.
HUB_TTYD_SOCK = os.environ.get("HUB_TTYD_SOCK", "")
# ttyd runs with --base-path /terminal, so its UI/token/ws all live under this prefix.
HUB_TTYD_BASE = os.environ.get("HUB_TTYD_BASE", "/terminal")
# hub_term_session cookie lifetime (seconds); matches the Max-Age on the cookie.
HUB_TERM_SESSION_TTL_S = int(os.environ.get("HUB_TERM_SESSION_TTL_S", "3600"))
# Host tmux manager (host/hub-tmuxd): a second host unix socket beside ttyd's, with
# the same isolation. Reads need the terminal session cookie; spawn/kill dispatch
# exclusively from the write gate (tmux.spawn / tmux.kill). Empty = off: no default
# path, so a socket is never looked for in the data dir, which agents may share.
HUB_TMUXD_SOCK = os.environ.get("HUB_TMUXD_SOCK", "")
HUB_TZ = hub_tz()

app = FastAPI(title="hub-api", docs_url=None, redoc_url=None)
app.include_router(ha_router)
app.include_router(files_router)
app.include_router(calendar_router)
app.include_router(chat_platform_router)
app.include_router(chat_session_router)
app.include_router(chat_routes_router)
app.include_router(chat_ws_router)
app.include_router(chat_approval_router)
app.include_router(chat_automations_platform_router)
app.include_router(chat_automations_router)
app.include_router(chat_automations_badge_router)
app.include_router(live_session.router)


# Live voice (live_session.py): a finished spoken turn goes through the SAME send
# machinery as POST /api/chat/threads/<id>/send, so it is recorded durably and
# forwarded like a typed message; the tap that stops a reply is the thread's Stop.
# The sqlite and gateway calls run off the event loop. The socket's Origin check is
# wired beside the terminal's, further down.
async def _live_send_message(
    thread_id: str, text: str, notes: list[str], read_aloud: bool,
) -> dict[str, Any] | None:
    return await asyncio.to_thread(
        chat_send_user_text, thread_id, text, live_voice=True, read_aloud=read_aloud, notes=notes,
    )


async def _live_stop_run(thread_id: str) -> None:
    await asyncio.to_thread(chat_forward_gateway_event, {"kind": "stop", "thread_id": thread_id})


live_session.send_message = _live_send_message
live_session.stop_run = _live_stop_run


# ---------------------------------------------------------------------------
# Request-validation errors: report WHERE and WHAT KIND, never WHAT WAS SENT.
#
# FastAPI's default handler echoes the offending input back in the 422 body. Starlette
# then serialises that body with json.dumps(ensure_ascii=False).encode("utf-8"), which
# RAISES on a lone surrogate ("\ud800" — legal in a Python str, unrepresentable in UTF-8)
# — turning any hostile string into an unauthenticated 500 on EVERY endpoint that takes a
# pydantic model. Every wrong-type, Literal-mismatch, extra-field or model-validator
# rejection is a trigger, and the model is validated BEFORE any gate runs, so
# /api/action/apply and /api/terminal/session are reachable this way without a proof.
# Dropping string constraints cannot fix this; only replacing the handler can.
#
# Shape is deliberately FastAPI's minus `input`/`ctx`: `detail` stays a list of
# {loc, msg, type}. apps/hub/src/lib/api.ts parseError() reads `raw.detail`, finds a list
# (so `nested.detail` is undefined) and falls back to "<path> → 422" exactly as it does
# today — no client sees a shape change.
# ---------------------------------------------------------------------------
_MAX_VALIDATION_ERRORS = 20
_MAX_VALIDATION_LOC_PARTS = 8
_VALIDATION_FALLBACK = b'{"detail":[{"loc":["body"],"msg":"request validation failed","type":"invalid"}]}'


def _safe_text(value: Any, limit: int = 200) -> str:
    """Text that is guaranteed to survive JSON encoding. errors="replace" is what strips
    lone surrogates (and anything else UTF-8 cannot represent) instead of raising."""
    text = value if isinstance(value, str) else repr(value)
    return text.encode("utf-8", "replace").decode("utf-8", "replace")[:limit]


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError) -> Response:
    """422 that cannot itself raise. Every field is sanitised, the list is bounded, the
    body is dumped with ensure_ascii=True (so the output is pure ASCII by construction),
    and a static payload backs up the ENTIRE construction — errors(), the loc walk and the
    dump alike. The broad except is the point, not laziness: this handler is the one place
    in the app where an exception is served as a 500 to an unauthenticated caller, so the
    guard has to cover every line that touches attacker-influenced data, not just the dump."""
    try:
        items: list[dict[str, Any]] = []
        for err in list(exc.errors())[:_MAX_VALIDATION_ERRORS]:
            # loc parts are locations, not values — but an extra-field rejection puts the
            # attacker-chosen FIELD NAME here, so it is sanitised and capped like the rest.
            loc = [
                part if isinstance(part, int) else _safe_text(part, 64)
                for part in tuple(err.get("loc") or ())[:_MAX_VALIDATION_LOC_PARTS]
            ]
            items.append({
                "loc": loc,
                "msg": _safe_text(err.get("msg") or "invalid"),
                "type": _safe_text(err.get("type") or "invalid", 64),
            })
        payload = json.dumps({"detail": items}, ensure_ascii=True).encode("ascii")
    except Exception:  # noqa: BLE001 — a raise here would be the exact bug this fixes
        payload = _VALIDATION_FALLBACK
    return Response(content=payload, status_code=422, media_type="application/json")


@app.exception_handler(wa.ConfigError)
async def webauthn_config_error_handler(request: Request, exc: wa.ConfigError) -> Response:
    """A WebAuthn flow ran on a host with no public origin configured — HUB_ORIGIN
    unset (see webauthn_gate._require_config). Answered as an honest, actionable 503
    naming the variable to set, instead of letting a mismatched relying party fail
    inside the browser with an error the user cannot act on. Covers every gated
    surface (enrolment, action, terminal, chat, HA, topics, decisions, push) because
    they all reach the one gate module."""
    return JSONResponse(
        status_code=503,
        content={"detail": {"code": "webauthn_unconfigured", "detail": str(exc)}},
    )


def tail_jsonl(path: Path, n: int = 20) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    lines = path.read_text().splitlines()[-n:]
    out: list[dict[str, Any]] = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def read_cache(path: Path, what: str, max_age_s: int | None = None) -> Any:
    if not path.exists():
        raise HTTPException(status_code=503, detail=f"{what} cache not yet written")
    if max_age_s is not None and time.time() - path.stat().st_mtime > max_age_s:
        # Delete-on-failure in the writer only fires when the writer runs; a dead
        # cron would otherwise serve the last write as fresh forever.
        raise HTTPException(status_code=503, detail=f"{what} cache stale")
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError:
        raise HTTPException(status_code=503, detail=f"{what} cache unreadable")
    if isinstance(data, dict) and isinstance(data.get("data"), list):
        return data["data"]  # writer wraps lists as {generated_at, data}; the PWA wants bare arrays
    return data


def _rel_time(iso: str | None) -> str:
    # Computed at read time — a baked-in writer string would label stale data "just now" forever.
    try:
        then = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return "unknown"
    s = (datetime.now(timezone.utc) - then).total_seconds()
    if s < 60:
        return "just now"
    if s < 3600:
        return f"{int(s // 60)}m"
    if s < 86400:
        return f"{int(s // 3600)}h"
    return f"{int(s // 86400)}d"


def _time_label(iso: str | None) -> str:
    # Computed at read time (like _rel_time) — a writer-baked "7:21 PM" would label
    # week-old entries as today forever. Format per apps/hub/src/lib/mock.ts:
    # same-day "7:21 PM" / <6 days "Sun" / else "Apr 1", rendered in HUB_TZ.
    try:
        t = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(HUB_TZ)
    except (AttributeError, ValueError):
        return ""
    now = datetime.now(HUB_TZ)
    if t.date() == now.date():
        return f"{t.hour % 12 or 12}:{t.minute:02d} {'AM' if t.hour < 12 else 'PM'}"
    if (now - t).total_seconds() < 6 * 86400:
        return t.strftime("%a")
    return f"{t.strftime('%b')} {t.day}"


@app.get("/api/health")
def health() -> dict[str, Any]:
    rows = tail_jsonl(HEALTH_JSONL, 40)
    if not rows:
        # Honest "no data yet" (cron not wired / HUB_LOG_DIR mispointed) — never fake-green.
        raise HTTPException(status_code=503, detail="health feed not yet written")
    by_service: dict[str, dict[str, Any]] = {}
    for r in rows:
        sid = r.get("service")
        if sid:
            by_service[sid] = r
    services = sorted(by_service.values(), key=lambda r: r.get("service", ""))
    for s in services:
        s["time_ago"] = _rel_time(s.get("last_probe") or s.get("ts"))
    overall = "red" if any(s.get("status") == "down" for s in services) \
        else "amber" if any(s.get("status") in ("degraded", "disabled") for s in services) \
        else "green"
    return {"updated_at": rows[-1].get("ts"), "overall": overall, "services": services}


def _openclaw_status() -> dict[str, Any]:
    if not OPENCLAW_BIN or not Path(OPENCLAW_BIN).exists():
        return {}
    try:
        # Single fixed-arg subprocess — no shell, no parameterization.
        proc = subprocess.run(
            [OPENCLAW_BIN, "status", "--json"],
            capture_output=True, text=True, timeout=5, check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return {}
    if proc.returncode != 0 or not proc.stdout.strip():
        return {}
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {}


def _hermes_get(path: str) -> Any:
    req = urllib.request.Request(
        f"{HERMES_API_BASE}{path}",
        headers={"Authorization": f"Bearer {HERMES_API_KEY}"},
    )
    with urllib.request.urlopen(req, timeout=3) as resp:
        return json.loads(resp.read())


class BridgeError(RuntimeError):
    """Raised when the CLI-bridge is unreachable, times out, or rejects an argv."""


def _bridge_run(argv: list[str], timeout: float | None = None) -> dict[str, Any]:
    """Run a READ-ONLY hermes CLI command via the hub-bridge sidecar (Slice 2a).

    The bridge (services/hub-bridge) is the ONLY component with docker-socket access;
    hub-api reaches it over the compose network at HUB_BRIDGE_URL and never runs docker
    itself. `argv` is sent as a list (no shell) and re-validated against the bridge's
    strict read-only allowlist before it runs `docker exec example-gateway hermes <argv>`.

    Returns the bridge's {"stdout", "stderr", "code"} on success (code is hermes' own
    exit status — a non-zero code is still a successful bridge call, not an exception).
    Raises BridgeError when the bridge is unconfigured/unreachable/timed out or REJECTS
    the argv (HTTP 403 for a non-allowlisted command). This is an INTERNAL helper only —
    it is deliberately NOT wired to any public endpoint in this slice.
    """
    if not HUB_BRIDGE_URL:
        raise BridgeError("CLI-bridge not configured (HUB_BRIDGE_URL unset)")
    body = json.dumps({"argv": argv}).encode()
    req = urllib.request.Request(
        f"{HUB_BRIDGE_URL}/run",
        data=body,
        headers=_bridge_headers({"Content-Type": "application/json"}),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout or HUB_BRIDGE_TIMEOUT_S) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        # 403 = argv not allowlisted; 400 = malformed. Surface the bridge's reason, truncated.
        detail = exc.read().decode(errors="replace")[:200]
        raise BridgeError(f"CLI-bridge refused argv (HTTP {exc.code}): {detail}")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise BridgeError(f"CLI-bridge unreachable: {exc}")
    if not isinstance(data, dict) or "code" not in data:
        raise BridgeError("CLI-bridge returned an unexpected payload")
    return data


def _bridge_write(argv: list[str], timeout: float | None = None) -> dict[str, Any]:
    """Run a WRITE hermes CLI command via the bridge's /run-write endpoint.

    THE ONLY CALLER of this is /api/action/apply, AFTER a WebAuthn assertion has been
    verified. It re-uses _bridge_run's transport but targets the bridge's separate
    WRITE allowlist (config set, cron create/edit/pause/resume/run/remove). Reads never
    reach /run-write and writes never reach /run — the bridge keeps the two disjoint."""
    if not HUB_BRIDGE_URL:
        raise BridgeError("CLI-bridge not configured (HUB_BRIDGE_URL unset)")
    body = json.dumps({"argv": argv}).encode()
    req = urllib.request.Request(
        f"{HUB_BRIDGE_URL}/run-write",
        data=body,
        headers=_bridge_headers({"Content-Type": "application/json"}),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout or HUB_BRIDGE_TIMEOUT_S) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:200]
        raise BridgeError(f"CLI-bridge refused write argv (HTTP {exc.code}): {detail}")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise BridgeError(f"CLI-bridge unreachable: {exc}")
    if not isinstance(data, dict) or "code" not in data:
        raise BridgeError("CLI-bridge returned an unexpected payload")
    return data


def _bridge_spend(cutoff_epoch: int, split_epoch: int, granularity: str, timeout: float | None = None) -> dict[str, Any]:
    """Fetch computed spend from the hub-bridge /spend capability (Cost tab pivot).

    hub-api is non-root, has no docker socket and does NOT mount the agent's data directory, so it cannot
    read the gateway's state.db directly. The bridge holds the socket and runs a FIXED,
    SELECT-only query (see hub-bridge/bridge.py SPEND_SCRIPT) that computes dollars from
    tokens via the embedded pricing map. Rows in [cutoff_epoch, split_epoch) feed ONLY
    summary.prev_total_usd (the delta baseline); rows >= split_epoch feed everything
    else. `granularity` is validated by the bridge against a literal allowlist. Raises
    BridgeError on any transport/query failure so callers translate to an honest 503 —
    never a fabricated zero."""
    if not HUB_BRIDGE_URL:
        raise BridgeError("CLI-bridge not configured (HUB_BRIDGE_URL unset)")
    body = json.dumps(
        {"cutoff_epoch": cutoff_epoch, "split_epoch": split_epoch, "granularity": granularity}
    ).encode()
    req = urllib.request.Request(
        f"{HUB_BRIDGE_URL}/spend",
        data=body,
        headers=_bridge_headers({"Content-Type": "application/json"}),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout or HUB_BRIDGE_TIMEOUT_S) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:200]
        raise BridgeError(f"CLI-bridge spend error (HTTP {exc.code}): {detail}")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise BridgeError(f"CLI-bridge unreachable: {exc}")
    if not isinstance(data, dict) or "summary" not in data:
        raise BridgeError("CLI-bridge returned an unexpected spend payload")
    return data


def _bridge_config_raw(timeout: float | None = None) -> dict[str, Any]:
    """Fetch the full masked config tree from the hub-bridge /config-raw capability.

    hub-api is non-root, has no docker socket and does NOT mount the agent's data directory, so it cannot
    read config.yaml directly (and `hermes config show` only emits a curated summary). The
    bridge holds the socket and runs a FIXED dump script (see hub-bridge/bridge.py
    CONFIG_DUMP_SCRIPT) that yaml.safe_loads the file and redacts every secret leaf. Returns
    {"config": <nested tree>}. Raises BridgeError on any transport/dump failure so callers
    translate to an honest 503 — never a fabricated-empty config."""
    if not HUB_BRIDGE_URL:
        raise BridgeError("CLI-bridge not configured (HUB_BRIDGE_URL unset)")
    req = urllib.request.Request(f"{HUB_BRIDGE_URL}/config-raw", headers=_bridge_headers(), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout or HUB_BRIDGE_TIMEOUT_S) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:200]
        raise BridgeError(f"CLI-bridge config-raw error (HTTP {exc.code}): {detail}")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise BridgeError(f"CLI-bridge unreachable: {exc}")
    if not isinstance(data, dict) or not isinstance(data.get("config"), dict):
        raise BridgeError("CLI-bridge returned an unexpected config-raw payload")
    return data


def _bridge_cron_logs(limit: int, timeout: float | None = None) -> dict[str, Any]:
    """Fetch recent cron run-logs from the hub-bridge /cron-logs capability (Ops Logs view).

    hub-api is non-root, has no docker socket and does NOT mount the agent's data directory, so it cannot read
    the gateway's archived cron run outputs (its `cron/output/<job_id>/<timestamp>.md` archive)
    directly. The bridge holds the socket and runs a FIXED script (see hub-bridge/bridge.py
    CRON_LOGS_SCRIPT) that globs the archive, takes the `limit` most-recent runs by mtime, and
    parses each into {job_id, name, run_time, mode, status, output, truncated}. `limit` is
    re-validated by the bridge against its own clamp. Raises BridgeError on any transport/query
    failure so callers translate to an honest 503 — never a fabricated-empty list."""
    if not HUB_BRIDGE_URL:
        raise BridgeError("CLI-bridge not configured (HUB_BRIDGE_URL unset)")
    body = json.dumps({"limit": limit}).encode()
    req = urllib.request.Request(
        f"{HUB_BRIDGE_URL}/cron-logs",
        data=body,
        headers=_bridge_headers({"Content-Type": "application/json"}),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout or HUB_BRIDGE_TIMEOUT_S) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:200]
        raise BridgeError(f"CLI-bridge cron-logs error (HTTP {exc.code}): {detail}")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise BridgeError(f"CLI-bridge unreachable: {exc}")
    if not isinstance(data, dict) or not isinstance(data.get("runs"), list):
        raise BridgeError("CLI-bridge returned an unexpected cron-logs payload")
    return data


def _bridge_cron_costs(timeout: float | None = None) -> dict[str, Any]:
    """Fetch per-cron-job cost/tokens from the hub-bridge /cron-costs capability.

    hub-api is non-root, has no docker socket and does NOT mount the agent's data directory, so it cannot
    read state.db or cron/jobs.json directly. The bridge holds the socket and runs a FIXED,
    parameterless script (see hub-bridge/bridge.py CRON_COSTS_SCRIPT) that joins
    sessions(source='cron') to the cron store's names and returns per-job last-run +
    trailing-7d cost/tokens/runs with a per-day rollup. Ledger semantics: cost_status
    'unknown' runs carry cost_usd null and land in unknown_runs — never a fake $0. Raises
    BridgeError on any transport/query failure so callers translate to an honest 503."""
    if not HUB_BRIDGE_URL:
        raise BridgeError("CLI-bridge not configured (HUB_BRIDGE_URL unset)")
    req = urllib.request.Request(f"{HUB_BRIDGE_URL}/cron-costs", headers=_bridge_headers(), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout or HUB_BRIDGE_TIMEOUT_S) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:200]
        raise BridgeError(f"CLI-bridge cron-costs error (HTTP {exc.code}): {detail}")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise BridgeError(f"CLI-bridge unreachable: {exc}")
    if not isinstance(data, dict) or not isinstance(data.get("jobs"), list):
        raise BridgeError("CLI-bridge returned an unexpected cron-costs payload")
    return data


# Device-code providers whose OAuth login the Hub can drive natively (no Terminal). Must
# match the bridge's DEVICE_OAUTH_PROVIDERS allowlist. loopback-PKCE (anthropic, xai-oauth)
# and api-key (openrouter) providers are NOT here — they fall back to Terminal / the key form.
_DEVICE_CODE_PROVIDERS = {"nous", "openai-codex", "minimax-oauth"}


def _bridge_oauth_start(provider: str, timeout: float | None = None) -> dict[str, Any]:
    """Start a detached device-code OAuth login via the bridge's /oauth-start (Phase 1).

    Launches `hermes auth add <provider> --no-browser` inside the gateway and returns
    immediately with {"stage": "pending"}. The bridge re-validates `provider` against its
    own device-code allowlist. Raises BridgeError on transport/validation failure."""
    if not HUB_BRIDGE_URL:
        raise BridgeError("CLI-bridge not configured (HUB_BRIDGE_URL unset)")
    body = json.dumps({"provider": provider}).encode()
    req = urllib.request.Request(
        f"{HUB_BRIDGE_URL}/oauth-start",
        data=body,
        headers=_bridge_headers({"Content-Type": "application/json"}),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout or HUB_BRIDGE_TIMEOUT_S) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:200]
        raise BridgeError(f"CLI-bridge refused oauth-start (HTTP {exc.code}): {detail}")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise BridgeError(f"CLI-bridge unreachable: {exc}")
    if not isinstance(data, dict) or "stage" not in data:
        raise BridgeError("CLI-bridge returned an unexpected oauth-start payload")
    return data


def _bridge_oauth_status(provider: str, timeout: float | None = None) -> dict[str, Any]:
    """Read a device-code login's progress via the bridge's /oauth-status (Phase 1).

    Returns {"stage": "pending"|"connected"|"failed", "url"?, "code"?, "error"?}. The
    url/code are the verification link + user_code the operator opens on their phone;
    they are not secrets (approval happens on the provider's own authenticated site).
    Raises BridgeError on transport/validation failure."""
    if not HUB_BRIDGE_URL:
        raise BridgeError("CLI-bridge not configured (HUB_BRIDGE_URL unset)")
    url = f"{HUB_BRIDGE_URL}/oauth-status?provider={urllib.parse.quote(provider)}"
    req = urllib.request.Request(url, headers=_bridge_headers(), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout or HUB_BRIDGE_TIMEOUT_S) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:200]
        raise BridgeError(f"CLI-bridge oauth-status error (HTTP {exc.code}): {detail}")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise BridgeError(f"CLI-bridge unreachable: {exc}")
    if not isinstance(data, dict) or "stage" not in data:
        raise BridgeError("CLI-bridge returned an unexpected oauth-status payload")
    return data


def _hermes_up() -> bool:
    """Strict liveness: gateway running AND telegram connected. An HTTP answer
    alone (e.g. a 401) must never render a dead Telegram bridge as a green agent."""
    try:
        health = _hermes_get("/health/detailed")
    except (OSError, ValueError):
        return False
    telegram = (health.get("platforms") or {}).get("telegram") or {}
    return health.get("gateway_state") == "running" and telegram.get("state") == "connected"


def _hermes_roster() -> list[dict[str, Any]]:
    """Single-agent roster derived live from the Hermes gateway when no roster
    cache is seeded. Fields the gateway can't attest stay null/0 — never faked."""
    if not HERMES_API_BASE:
        return []
    agent: dict[str, Any] = {
        "id": HERMES_AGENT_ID,
        "name": HERMES_AGENT_NAME,
        "model": None,
        "status": "up" if _hermes_up() else "down",
        "last_message_at": None,
        "messages_today": 0,
        "avatar_glyph": None,
    }
    try:
        sessions = _hermes_get("/api/sessions?source=telegram&limit=50").get("data") or []
    except (OSError, ValueError):
        return [agent]
    if sessions:
        agent["model"] = sessions[0].get("model")
        last = sessions[0].get("last_active")
        if last:
            agent["last_message_at"] = datetime.fromtimestamp(last, tz=timezone.utc).isoformat()
        midnight = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        # started_at-based: undercounts long-lived sessions, never inflates.
        agent["messages_today"] = sum(
            s.get("message_count") or 0 for s in sessions if (s.get("started_at") or 0) >= midnight
        )
    return [agent]


def _live_status() -> str:
    """Coarse fallback status for roster agents that don't pin their own.
    'disabled' when no probe is configured (neither openclaw nor Hermes)."""
    if OPENCLAW_BIN and Path(OPENCLAW_BIN).exists():
        return "up" if _openclaw_status() else "down"
    if not HERMES_API_BASE:
        return "disabled"
    return "up" if _hermes_up() else "down"


@app.get("/api/agents")
def agents() -> list[dict[str, Any]]:
    """Bare Agent[] per apps/hub/src/lib/types.ts — the PWA maps over it directly."""
    if not ROSTER_JSON.exists():
        return _hermes_roster()
    if time.time() - ROSTER_JSON.stat().st_mtime > CACHE_MAX_AGE_S:
        raise HTTPException(status_code=503, detail="agents cache stale")
    try:
        roster = json.loads(ROSTER_JSON.read_text())
    except json.JSONDecodeError:
        # A truncated write must not read as a healthy empty roster.
        return _hermes_roster()
    if isinstance(roster, dict) and isinstance(roster.get("data"), list):
        roster = roster["data"]
    live: str | None = None
    out: list[dict[str, Any]] = []
    for a in roster:
        status = a.get("status")
        if not status:
            if live is None:
                live = _live_status()
            status = live
        out.append({
            "id": a.get("id"),
            "name": a.get("name"),
            "model": a.get("model"),
            "status": status,
            "last_message_at": a.get("last_message_at"),
            "messages_today": a.get("messages_today", 0),
            "avatar_glyph": a.get("avatar_glyph"),
        })
    return out


@app.get("/api/backups")
def backups() -> dict[str, Any]:
    data = read_cache(RESTIC_JSON, "restic snapshot")
    rel = _rel_time((data.get("latest") or {}).get("ts"))
    data["rel_time"] = rel if rel in ("just now", "unknown") else f"{rel} ago"
    return data


# Every field AuditCard.tsx / AmbientFooter.tsx dereference unguarded — a partial
# object crashes Home the moment the response is truthy.
AUDIT_FIELDS = (
    "keys_ok", "keys_total", "spend_mtd_usd", "spend_cap_usd", "drift_count",
    "last_audit_at", "tool_calls_24h", "mcp_calls_24h", "flagged_24h",
)


@app.get("/api/audit")
def audit() -> dict[str, Any]:
    if not ACCESS_JSON.exists():
        raise HTTPException(status_code=503, detail="access report not yet written")
    try:
        report: dict[str, Any] = json.loads(ACCESS_JSON.read_text())
    except json.JSONDecodeError:
        raise HTTPException(status_code=503, detail="access report unreadable")
    if any(report.get(f) is None for f in AUDIT_FIELDS):
        # The box writer only emits truthfully derivable counts — no custody audit,
        # no priced spend source. Stay an honest 503 until one exists.
        raise HTTPException(status_code=503, detail="access report incomplete — no spend source configured")
    return report


# ===========================================================================
# WebAuthn gate (Slice 2b) — enrolment + the generalized write-action gate +
# the terminal unlock. All verification is real (webauthn_gate.py → py_webauthn);
# unknown credentials are rejected and every anomaly fails closed.
# ===========================================================================

# --- Request/response models ------------------------------------------------
class AssertionPayload(BaseModel):
    """A WebAuthn assertion from navigator.credentials.get() (base64url fields)."""
    id: str
    raw_id: str
    client_data_json: str
    authenticator_data: str
    signature: str
    user_handle: str | None = None


class DeviceKeyAssertion(BaseModel):
    """The native app's proof (devicekeys.py): an ECDSA-P256-SHA256 signature, X9.62 DER
    in base64, by an enrolled Secure-Enclave key over the RAW bytes of `challenge_b64` —
    the same canonical challenge bytes a WebAuthn authenticator signs for that challenge."""
    # Plain `str`, deliberately NOT Field(max_length=...): a CONSTRAINED str makes
    # pydantic reject a lone surrogate ("\ud800") at the model boundary, and FastAPI's
    # validation-error body then echoes that raw input, which Starlette cannot encode —
    # turning a hostile string into an unauthenticated 500 on an ungated endpoint.
    # Unconstrained strs are accepted and every bound below is enforced where the value is
    # actually used (verify_devicekey / verify_devicekey_signature), on the fail-closed path.
    key_id: str
    challenge_b64: str
    signature_b64: str


class GatedRequest(BaseModel):
    """Base for every apply model: EXACTLY ONE proof — the PWA's WebAuthn assertion or
    the native app's device-key signature. Neither (or both) is a 422, the same status
    the previously-required `assertion` field produced, so the PWA is unaffected."""
    assertion: AssertionPayload | None = None
    devicekey_assertion: DeviceKeyAssertion | None = None

    @model_validator(mode="after")
    def _exactly_one_proof(self) -> "GatedRequest":
        if (self.assertion is None) == (self.devicekey_assertion is None):
            raise ValueError("exactly one of assertion / devicekey_assertion is required")
        return self


# The structured write the gate protects. hub-api maps this to an argv server-side
# (build_write_argv) — the client never supplies raw argv — and the bridge re-validates
# the argv against its own WRITE allowlist. Two independent gates, no shell anywhere.
#
# extra="forbid": a misspelled field used to be silently dropped, which for a field whose
# ABSENCE carries meaning (devicekey.revoke) turned one transposed character into a
# different, broader action. Verified safe for the PWA: apps/hub/src/lib/types.ts
# WriteRequest is a strict subset of the fields below and no call site spreads an
# arbitrary object into applyWrite, so nothing it sends can be rejected by this.
class WriteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal[
        "config.set",
        "cron.create",
        "cron.edit",
        "cron.pause",
        "cron.resume",
        "cron.run",
        "cron.remove",
        "pairing.approve",
        "pairing.revoke",
        "gateway.restart",
        "gateway.drain",
        "advisor.preset",
        "tmux.spawn",
        "tmux.kill",
        # Native-app pairing administration. Neither reaches the bridge; both are
        # reserved to a real passkey assertion (see _DEVICEKEY_ADMIN_ACTIONS).
        "devicekey.enroll_code",
        "devicekey.revoke",
    ]
    # config.set
    key: str | None = None
    value: str | None = None
    # advisor.preset — one of {cost,quality,off}
    preset: str | None = None
    # cron.* targets / fields
    job_id: str | None = None
    schedule: str | None = None
    prompt: str | None = None
    name: str | None = None
    deliver: str | None = None
    repeat: str | None = None
    workdir: str | None = None
    script: str | None = None
    skills: list[str] | None = None
    no_agent: bool = False
    accept_hooks: bool = False
    # pairing.{approve,revoke} targets — the hermes CLI takes (platform, code|user_id).
    platform: str | None = None
    code: str | None = None
    user_id: str | None = None
    # tmux.* target host (hub-tmuxd host id; omitted = the VPS itself)
    host: str | None = None
    # tmux.spawn — resume a past Claude Code session (id + project dir from /api/tmux/history)
    resume: str | None = None
    cwd: str | None = None
    # devicekey.revoke target: EXACTLY ONE of key_id (sha256 hex of the enrolled SPKI
    # DER) or all=true. Absence never means "all" — see _devicekey_revoke_target below.
    key_id: str | None = None
    all: bool = False

    @model_validator(mode="after")
    def _devicekey_revoke_target(self) -> "WriteRequest":
        """devicekey.revoke must name its target explicitly. Rejecting "neither" is the
        point: a dropped `undefined` from JSON.stringify, or a typo'd key name, must fail
        loudly instead of quietly widening a single-key revoke into revoke-everything."""
        if self.action == "devicekey.revoke" and self.all == (self.key_id is not None):
            raise ValueError("devicekey.revoke requires exactly one of key_id or all=true")
        return self


class RegisterVerifyRequest(BaseModel):
    credential: dict[str, Any]
    label: str | None = None


class RegisterOptionsRequest(BaseModel):
    """Body of /api/passkey/register/options. Empty only while NOTHING is enrolled —
    no passkey and no paired device — the bootstrap case, where there is no credential
    to prove possession of yet. Once either exists it must carry exactly one proof (a
    fresh WebAuthn or device-key assertion for purpose "register_reauth"); see
    _verify_reenrol_proof."""

    assertion: AssertionPayload | None = None
    devicekey_assertion: DeviceKeyAssertion | None = None


def _verify_reenrol_proof(req: RegisterOptionsRequest) -> None:
    """Enrolling a passkey while any credential exists is privileged: whoever can reach
    the origin must also hold a credential, or the write gate is self-provisionable (an
    unauthenticated peer could append its own passkey to passkeys.json and then pass
    every gated surface). A paired device key counts: on a device-key-only install (the
    native app's normal state) an open enrolment would hand the gate to anyone who can
    reach the origin. The proof is verified for its OWN purpose, "register_reauth", so a
    proof minted for action/terminal/chat cannot be spent here and vice versa.
    Fails closed: no proof, wrong purpose, or a bad signature is a 403."""
    if req.devicekey_assertion is not None:
        key_id = wa.verify_devicekey(req.devicekey_assertion.model_dump(), "register_reauth", None)
        if key_id is None:
            raise HTTPException(
                status_code=403,
                detail={"code": "assertion_invalid", "detail": "Device key verification failed."},
            )
        return
    if req.assertion is not None:
        cred_id = wa.verify_assertion(req.assertion.model_dump(), "register_reauth", None)
        if cred_id is None:
            raise HTTPException(
                status_code=403,
                detail={"code": "assertion_invalid", "detail": "Passkey verification failed."},
            )
        return
    raise HTTPException(
        status_code=403,
        detail={
            "code": "register_proof_required",
            "detail": "A passkey or paired device is already enrolled: POST "
            "/api/passkey/register/challenge, sign it with that credential, and send the "
            "assertion in the options request.",
        },
    )


class ActionChallengeRequest(BaseModel):
    request: WriteRequest


class ActionApplyRequest(GatedRequest):
    request: WriteRequest


class TerminalSessionRequest(GatedRequest):
    pass


class DeviceKeyRegisterRequest(BaseModel):
    # Unconstrained for the same reason as DeviceKeyAssertion above. Bounds are enforced
    # downstream: an over-long code is an ordinary counted failed attempt
    # (_consume_enroll_code), spki_der_b64 by _b64_to_bytes, label by truncation.
    code: str
    spki_der_b64: str
    label: str | None = None


_CONFIG_KEY_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_JOB_ID_RE = re.compile(r"^[A-Za-z0-9._:-]+$")
_DELIVER_RE = re.compile(r"^[A-Za-z0-9._:@-]+$")
_PLATFORM_RE = re.compile(r"^[a-z][a-z0-9_-]*$")
_PAIRING_TOKEN_RE = re.compile(r"^[A-Za-z0-9._:@-]+$")


def _canonical_write_hash(req: WriteRequest) -> str:
    """Stable sha256 over the WriteRequest — binds a challenge to one exact write.
    Computed server-side at BOTH challenge and apply time (never supplied by a client),
    so adding a field to WriteRequest cannot desynchronise the two."""
    payload = json.dumps(req.model_dump(), separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()


# Device-key administration: minting an enrol code or unpairing a phone. Both require a
# real human passkey assertion, never a device-key one.
#
# READ THIS AS DEFENCE IN DEPTH, NOT AS A PRIVILEGE BOUNDARY. It raises the cost of the
# obvious move (a stolen device key minting a second pairing, or revoking the one the user
# would use to lock it out) and it makes that move visible. It does NOT contain a
# compromised device key: that key still passes tmux.spawn, gateway.restart and
# /api/terminal/session, and from any of those shells devicekeys.json is writable — so an
# attacker who owns the key can reach the same end by a longer route. A device key is a
# fully privileged writer on this estate; treat losing one as losing the box, and revoke
# from the PWA. Do not add anything to this set expecting it to be sealed off.
_DEVICEKEY_ADMIN_ACTIONS = frozenset({"devicekey.enroll_code", "devicekey.revoke"})
_DEVICEKEY_ID_RE = re.compile(r"^[0-9a-f]{64}$")


def _require_enrolled(devicekey_assertion: DeviceKeyAssertion | None) -> None:
    """Fail closed before any verification when the relevant store is empty. The passkey
    branch is byte-identical to the check every apply handler ran before this change."""
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
    """Verify the request's single proof against the cached challenge for this purpose
    and context hash; raise 403 on any failure. Both branches consume the challenge on
    the first attempt, so neither a WebAuthn assertion nor a device-key signature can be
    retried or replayed. Returns a scheme-tagged identity for logging."""
    if req.devicekey_assertion is not None:
        key_id = wa.verify_devicekey(req.devicekey_assertion.model_dump(), purpose, ctx_hash)
        if key_id is None:
            raise HTTPException(
                status_code=403,
                detail={"code": "assertion_invalid", "detail": "Device key verification failed."},
            )
        return f"devicekey:{key_id}"
    cred_id = wa.verify_assertion(req.assertion.model_dump(), purpose, ctx_hash)
    if cred_id is None:
        raise HTTPException(
            status_code=403,
            detail={"code": "assertion_invalid", "detail": "Passkey verification failed."},
        )
    return f"passkey:{cred_id}"


# ---------------------------------------------------------------------------
# Advisor presets (Anthropic advisor tool). Each preset is a full, canonical
# config state applied as an ORDERED list of `config set <key> <value>` writes —
# the SAME bridge write path config.set uses — followed by a gateway restart
# (advisor_config is read ONCE at agent init, so a config edit is a no-op until
# the gateway restarts). Values are string tokens exactly as `hermes config set`
# accepts; hermes coerces "true"/"false" to the bool the config stores.
#   off     : advisor disabled; the solo executor is restored to sonnet (so
#             switching OFF from `cost` also drops the haiku executor).
#   quality : strong executor (sonnet) advised by opus — the recommended default.
#   cost    : cheap executor (haiku) advised by OPUS (per the docs' Haiku
#             recommendation — the earlier sonnet advisor was the weaker pairing).
# `off` sets model.default back to sonnet AND advisor.enabled=false (2 keys);
# quality/cost write all 3. Derivation (_derive_advisor_preset) keys `off` off
# advisor.enabled=false alone, which uniquely distinguishes it from cost/quality
# (both require the advisor enabled); cost vs quality then split on the executor.
ADVISOR_PRESETS: dict[str, list[tuple[str, str]]] = {
    "off": [
        ("model.default", "claude-sonnet-4-6"),
        ("advisor.enabled", "false"),
    ],
    "quality": [
        ("model.default", "claude-sonnet-4-6"),
        ("advisor.enabled", "true"),
        ("advisor.model", "claude-opus-4-8"),
    ],
    "cost": [
        ("model.default", "claude-haiku-4-5"),
        ("advisor.enabled", "true"),
        ("advisor.model", "claude-opus-4-8"),
    ],
}


def advisor_preset_pairs(preset: str | None) -> list[tuple[str, str]]:
    """Validate a preset name and return its ordered (key, value) config writes.
    Raises HTTP 400 (same honest-400 posture as build_write_argv) on unknown/missing."""
    if preset not in ADVISOR_PRESETS:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "bad_request",
                "detail": f"advisor.preset requires preset in {sorted(ADVISOR_PRESETS)}",
            },
        )
    return ADVISOR_PRESETS[preset]


def _derive_advisor_preset(executor: Any, advisor_enabled: Any, advisor_model: Any) -> str:
    """Map live config values to a preset label. 'off' when the advisor is disabled
    (uniquely — cost/quality both enable it); 'cost'/'quality' on an exact executor+
    advisor-model match; 'custom' otherwise (advisor on but matching no defined preset)."""
    if advisor_enabled is False:
        return "off"
    if advisor_enabled is True:
        # cost and quality both pair with the OPUS advisor now; they split on the executor.
        if executor == "claude-sonnet-4-6" and advisor_model == "claude-opus-4-8":
            return "quality"
        if executor == "claude-haiku-4-5" and advisor_model == "claude-opus-4-8":
            return "cost"
    return "custom"


_TMUX_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}$")
_TMUX_KILL_RE = re.compile(r"^claude-[a-z0-9][a-z0-9-]{0,30}$")
# claude-main is the live remote agent; hub-term backs the Hub terminal. hub-tmuxd
# enforces the same blocklist independently (two gates, like hub-api + bridge).
_TMUX_PROTECTED = frozenset({"claude-main", "hub-term"})
_TMUX_HOST_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,15}$")
_TMUX_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_TMUX_CWD_RE = re.compile(r"^/[A-Za-z0-9_./-]{0,200}$")


def _validate_tmux_request(req: WriteRequest) -> None:
    """tmux.* never builds a hermes argv — it dispatches to the host hub-tmuxd over its
    unix socket. Optional host id (host/hub-tmuxd manages only its own machine, "vps";
    omitted = that machine). Spawn: optional slug (daemon auto-names claude-N), optional
    resume id + cwd (daemon resolves the cwd inside its allowed roots, starts a resume in
    the transcript's own directory, and refuses a transcript that is already running).
    Kill: full claude-* session name, never a protected one. Both gates validate: these
    values reach tmux, which treats a trailing ';' as a new command and runs #(...) in
    session names and directories."""
    def bad(msg: str) -> HTTPException:
        return HTTPException(status_code=400, detail={"code": "bad_request", "detail": msg})
    if req.host and not _TMUX_HOST_RE.match(req.host):
        raise bad("tmux host must match [a-z0-9][a-z0-9-]{0,15}")
    if req.action == "tmux.spawn":
        if req.name and not _TMUX_SLUG_RE.match(req.name):
            raise bad("tmux.spawn name must match [a-z0-9][a-z0-9-]{0,30}")
        if req.resume and not _TMUX_UUID_RE.match(req.resume):
            raise bad("tmux.spawn resume must be a Claude Code session id")
        if req.cwd and (not _TMUX_CWD_RE.match(req.cwd)
                        or {".", ".."} & set(req.cwd.split("/"))):
            raise bad("tmux.spawn cwd must be an absolute path without . or .. segments")
        return
    if not req.name or not _TMUX_KILL_RE.match(req.name):
        raise bad("tmux.kill requires a claude-<slug> session name")
    if req.host in (None, "vps") and req.name in _TMUX_PROTECTED:
        raise bad(f"{req.name} is protected")


def _validate_write_request(req: WriteRequest) -> None:
    """Validate a WriteRequest's shape BEFORE a challenge is issued or a write dispatched.
    advisor.preset is a multi-step write (N config sets + a restart) with no single argv,
    so it is validated via advisor_preset_pairs; tmux.* dispatches to hub-tmuxd rather
    than the bridge; every other action via build_write_argv."""
    if req.action == "advisor.preset":
        advisor_preset_pairs(req.preset)
        return
    if req.action in ("tmux.spawn", "tmux.kill"):
        _validate_tmux_request(req)
        return
    if req.action in _DEVICEKEY_ADMIN_ACTIONS:
        # The key_id-xor-all requirement is enforced on the model (422). Here: when a
        # key_id IS given it must be an exact sha256 hex id — no prefix, no wildcard.
        if req.action == "devicekey.revoke" and req.key_id is not None and not _DEVICEKEY_ID_RE.match(req.key_id):
            raise HTTPException(
                status_code=400,
                detail={"code": "bad_request",
                        "detail": "devicekey.revoke key_id must be 64 hex chars"},
            )
        return
    build_write_argv(req)


def build_write_argv(req: WriteRequest) -> list[str]:
    """Map a validated WriteRequest to a hermes argv list. Raises HTTP 400 on any
    malformed/missing field BEFORE a challenge is ever issued or dispatched. The bridge
    re-validates independently, but we validate here too (defense in depth, honest 400s)."""
    def bad(msg: str) -> HTTPException:
        return HTTPException(status_code=400, detail={"code": "bad_request", "detail": msg})

    a = req.action
    if a == "config.set":
        if not req.key or not _CONFIG_KEY_RE.match(req.key):
            raise bad("config.set requires a valid dotted key")
        # Same rule that masks these values on read (_CONFIG_SENSITIVE_RE): a key
        # the hub is never allowed to display is a key it must never write either.
        if _CONFIG_SENSITIVE_RE.search(req.key):
            raise bad("sensitive keys are set from the terminal, not the hub")
        if req.value is None:
            raise bad("config.set requires a value")
        return ["config", "set", req.key, req.value]

    # cron.{pause,resume,run,remove} — job_id only
    simple = {"cron.pause": "pause", "cron.resume": "resume", "cron.remove": "remove", "cron.run": "run"}
    if a in simple:
        if not req.job_id or not _JOB_ID_RE.match(req.job_id):
            raise bad(f"{a} requires a valid job_id")
        argv = ["cron", simple[a], req.job_id]
        if a == "cron.run" and req.accept_hooks:
            argv.append("--accept-hooks")
        return argv

    if a == "cron.create":
        if not req.schedule:
            raise bad("cron.create requires a schedule")
        argv = ["cron", "create", req.schedule]
        if req.prompt:
            argv.append(req.prompt)
        argv += _cron_common_flags(req, bad)
        return argv

    if a == "cron.edit":
        if not req.job_id or not _JOB_ID_RE.match(req.job_id):
            raise bad("cron.edit requires a valid job_id")
        argv = ["cron", "edit", req.job_id]
        if req.schedule:
            argv += ["--schedule", req.schedule]
        if req.prompt:
            argv += ["--prompt", req.prompt]
        argv += _cron_common_flags(req, bad)
        return argv

    # pairing.approve <platform> <code> / pairing.revoke <platform> <user_id>
    if a in ("pairing.approve", "pairing.revoke"):
        if not req.platform or not _PLATFORM_RE.match(req.platform):
            raise bad(f"{a} requires a valid platform (e.g. telegram)")
        target = req.code if a == "pairing.approve" else req.user_id
        field = "code" if a == "pairing.approve" else "user_id"
        if not target or not _PAIRING_TOKEN_RE.match(target):
            raise bad(f"{a} requires a valid {field}")
        verb = "approve" if a == "pairing.approve" else "revoke"
        return ["pairing", verb, req.platform, target]

    # gateway.restart -> `gateway restart`; gateway.drain -> `gateway stop` (graceful
    # stop; hermes has no native `drain` verb). Bare argv — no --all/--system flags.
    if a == "gateway.restart":
        return ["gateway", "restart"]
    if a == "gateway.drain":
        return ["gateway", "stop"]

    raise bad(f"unsupported action {a}")


def _cron_common_flags(req: WriteRequest, bad) -> list[str]:
    argv: list[str] = []
    if req.name:
        argv += ["--name", req.name]
    if req.deliver:
        if not _DELIVER_RE.match(req.deliver):
            raise bad("invalid deliver target")
        argv += ["--deliver", req.deliver]
    if req.repeat:
        if not req.repeat.isdigit():
            raise bad("repeat must be a positive integer")
        argv += ["--repeat", req.repeat]
    if req.workdir:
        argv += ["--workdir", req.workdir]
    if req.script:
        argv += ["--script", req.script]
    for skill in req.skills or []:
        argv += ["--skill", skill]
    if req.no_agent:
        argv.append("--no-agent")
    return argv


# --- Enrolment (register a platform authenticator) --------------------------
@app.get("/api/passkey/status")
def passkey_status() -> dict[str, Any]:
    """Whether a passkey is enrolled (drives the Settings enrolment UI). GET, unauth —
    reveals only enrolment state + labels, never credential material."""
    return wa.passkey_status()


@app.post("/api/passkey/register/challenge")
def passkey_register_reauth_challenge() -> dict[str, Any]:
    """Assertion challenge for enrolling a passkey while a credential already exists — a
    passkey challenge when one is enrolled, else one the paired device key signs
    (`assertion_options_any`). 412 only when nothing is enrolled, and then the first
    enrolment needs no challenge — see /register/options."""
    try:
        return wa.assertion_options_any("register_reauth", None)
    except wa.NoPasskeyError:
        raise HTTPException(
            status_code=412,
            detail={"code": "no_passkey", "detail": "Nothing enrolled yet: the first passkey needs no proof."},
        )


@app.post("/api/passkey/register/options")
def passkey_register_options(req: RegisterOptionsRequest) -> dict[str, Any]:
    """PublicKeyCredentialCreationOptions for navigator.credentials.create().

    Open ONLY while nothing at all is enrolled — no passkey AND no paired device key:
    there is no credential yet, so there is nothing to prove possession of (that is
    trust-on-first-use, stated honestly in SECURITY.md). Once ANY credential exists,
    a passkey or a device key, the request must carry a fresh WebAuthn or device-key
    assertion for purpose "register_reauth": without it, any caller who can reach the
    origin could append its own passkey to passkeys.json and then pass every gated
    surface. Config is checked first so an unconfigured host still answers the honest
    503 (see _require_config)."""
    wa._require_config()
    if wa.has_passkey() or dk.has_devicekey():
        _verify_reenrol_proof(req)
    return wa.registration_options()


@app.post("/api/passkey/register/verify")
def passkey_register_verify(req: RegisterVerifyRequest) -> dict[str, Any]:
    """Verify the attestation and persist the credential to passkeys.json."""
    try:
        result = wa.verify_registration(req.credential, req.label)
    except wa.ChallengeError as exc:
        raise HTTPException(status_code=412, detail={"code": "challenge_expired", "detail": str(exc)})
    except Exception as exc:  # noqa: BLE001 — invalid attestation
        raise HTTPException(status_code=400, detail={"code": "assertion_invalid", "detail": str(exc)})
    return {"ok": True, **result}


# --- Device-key pairing (native iOS app) ------------------------------------
def _peer_key(request: Request) -> str:
    """Best-effort caller identity for the enrol-attempt limiter. A HINT, NOT AUTHENTICATED.

    Behind Docker's port publish, `request.client.host` is the bridge gateway for every
    caller — mesh requests and local scripts arrive identically — so the socket peer
    carries no caller information at all.

    So we fall back to forwarded headers. `tailscale serve` documents the
    `Tailscale-User-*` identity headers but says nothing about `X-Forwarded-For`. Both are
    therefore treated as untrusted hints: rightmost XFF entry (rightmost = appended last
    by the nearest proxy, correct whether the proxy appends or overwrites), else the
    Tailscale login, else a single shared bucket. On a single-user tailnet the login is
    nearly useless regardless: the user and anything compromised on it share one login.

    Because the key can be absent OR forged, per-peer limiting alone cannot bound brute
    force; that is what the global tier in devicekeys.py is for. The peer key a tripped
    limiter logs (`device-key enrol throttled: peer=…`) shows which of these a given
    deployment actually receives."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        candidates = [part.strip() for part in forwarded.split(",") if part.strip()]
        if candidates:
            return candidates[-1][:64]
    return (request.headers.get("tailscale-user-login") or "-")[:64]


@app.get("/api/devicekey/status")
def devicekey_status() -> dict[str, Any]:
    """Whether a native-app device key is paired. GET, unauth — discloses exactly what
    /api/passkey/status does: label and created_at, no per-credential identifier. The app
    learns its own key_id from the register response, and devicekey.revoke accepts no
    key_id at all when the intent is "unpair everything"."""
    return dk.devicekey_status()


@app.post("/api/devicekey/register")
def devicekey_register(req: DeviceKeyRegisterRequest, request: Request) -> dict[str, Any]:
    """Enrol a Secure-Enclave P-256 public key. Carries no assertion of its own because
    it cannot: the app has no credential yet. It is authorized instead by the one-time
    enrol code, which exists ONLY because a real WebAuthn assertion minted it seconds
    earlier (devicekey.enroll_code — TTL, single-use, attempt-capped). Unknown/expired/
    spent code → 403; anything but a P-256 SPKI key → 400."""
    try:
        result = dk.register_devicekey(req.code, req.spki_der_b64, req.label, _peer_key(request))
    except dk.DeviceKeyStoreError as exc:
        # Never overwrite a store we could not read — surface it instead of silently
        # discarding whatever was in the file.
        raise HTTPException(status_code=503, detail={"code": "devicekey_store_unreadable", "detail": str(exc)})
    except dk.EnrollCodeError as exc:
        raise HTTPException(status_code=403, detail={"code": "enroll_code_invalid", "detail": str(exc)})
    except dk.DeviceKeyError as exc:
        raise HTTPException(status_code=400, detail={"code": "bad_devicekey", "detail": str(exc)})
    return {"ok": True, **result}


def _apply_devicekey_revoke(key_id: str | None, all_keys: bool) -> dict[str, Any]:
    """Unpair one named device key, or every one when all=true. The model already
    guarantees exactly one of the two is set. Reached ONLY from /api/action/apply after a
    verified PASSKEY assertion (never a device-key one — see _DEVICEKEY_ADMIN_ACTIONS)."""
    try:
        result = dk.revoke_devicekey(key_id, all_keys)
    except dk.DeviceKeyStoreError as exc:
        raise HTTPException(status_code=503, detail={"code": "devicekey_store_unreadable", "detail": str(exc)})
    except dk.DeviceKeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "unknown_devicekey", "detail": str(exc)})
    return {
        "status": "revoked",
        **result,
        "applied_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


# --- Generalized write-action gate -----------------------------------------
@app.post("/api/action/challenge")
def action_challenge(req: ActionChallengeRequest) -> dict[str, Any]:
    """Hash+cache the WriteRequest and return an assertion challenge bound to it."""
    _validate_write_request(req.request)  # validate shape BEFORE issuing a challenge (honest 400)
    ctx_hash = _canonical_write_hash(req.request)
    try:
        return wa.assertion_options_any("action", ctx_hash)
    except wa.NoPasskeyError:
        raise HTTPException(
            status_code=412,
            detail={"code": "no_passkey", "detail": "No passkey registered. Enrol in Settings first."},
        )


@app.post("/api/action/apply")
def action_apply(req: ActionApplyRequest) -> dict[str, Any]:
    """Verify the assertion (bound to THIS WriteRequest), then dispatch to the bridge.
    This is the ONLY path that reaches the bridge's WRITE allowlist."""
    _require_enrolled(req.devicekey_assertion)
    _validate_write_request(req.request)  # re-derive/validate; 400s on tamper
    if req.request.action in _DEVICEKEY_ADMIN_ACTIONS and req.devicekey_assertion is not None:
        raise HTTPException(
            status_code=403,
            detail={"code": "webauthn_required",
                    "detail": f"{req.request.action} requires a passkey assertion."},
        )
    ctx_hash = _canonical_write_hash(req.request)
    _verify_proof(req, "action", ctx_hash)
    # Device-key administration never touches the bridge; it is answered here.
    if req.request.action == "devicekey.enroll_code":
        return dk.mint_enroll_code()
    if req.request.action == "devicekey.revoke":
        return _apply_devicekey_revoke(req.request.key_id, req.request.all)
    # advisor.preset is a multi-step write (N config sets THEN a gateway restart) rather
    # than one argv — dispatch it separately. Both paths reach ONLY the bridge WRITE
    # allowlist, and only here, after the assertion above is verified.
    if req.request.action == "advisor.preset":
        return _apply_advisor_preset(req.request.preset)
    if req.request.action in ("tmux.spawn", "tmux.kill"):
        return _apply_tmux(req.request)
    argv = build_write_argv(req.request)  # re-derive; 400s on tamper
    try:
        result = _bridge_write(argv)
    except BridgeError as exc:
        raise HTTPException(status_code=502, detail={"code": "bridge_error", "detail": str(exc)})
    return {
        "status": "applied" if result.get("code") == 0 else "error",
        "code": result.get("code"),
        "stdout": result.get("stdout", ""),
        "stderr": result.get("stderr", ""),
        "applied_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def _apply_advisor_preset(preset: str | None) -> dict[str, Any]:
    """Atomically apply an advisor preset: write every config key via the SAME bridge
    write path config.set uses, THEN restart the gateway so advisor_config is re-read.
    Sequenced with a check after each write — if ANY config write fails we ABORT BEFORE
    the restart so the agent is never restarted into a half-applied preset. Reuses the
    existing config.set + gateway.restart bridge verbs (no new bridge verb)."""
    pairs = advisor_preset_pairs(preset)  # 400 on unknown preset (already validated upstream)
    keys_written: list[str] = []
    # 1) Config writes — abort the whole action on the first failure, before any restart.
    for key, value in pairs:
        try:
            r = _bridge_write(["config", "set", key, value])
        except BridgeError as exc:
            raise HTTPException(
                status_code=502,
                detail={"code": "bridge_error", "stage": "config", "key": key,
                        "keys_written": keys_written, "restarted": False, "detail": str(exc)},
            )
        if r.get("code") != 0:
            raise HTTPException(
                status_code=502,
                detail={"code": "config_write_failed", "stage": "config", "key": key,
                        "keys_written": keys_written, "restarted": False,
                        "stderr": (r.get("stderr") or "").strip()[:300],
                        "detail": f"config set {key} exited {r.get('code')}"},
            )
        keys_written.append(key)
    # 2) All config writes landed → restart the gateway (advisor_config re-read at init).
    try:
        rr = _bridge_write(["gateway", "restart"])
    except BridgeError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "bridge_error", "stage": "restart", "keys_written": keys_written,
                    "restarted": False, "detail": str(exc)},
        )
    restarted = rr.get("code") == 0
    return {
        "status": "applied" if restarted else "restart_failed",
        "preset": preset,
        "keys_written": keys_written,
        "restarted": restarted,
        "restart_code": rr.get("code"),
        "restart_stderr": (rr.get("stderr") or "").strip()[:300],
        "applied_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def _tmuxd_request(method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
    """One HTTP round-trip to the host hub-tmuxd unix socket (same transport pattern
    as the ttyd proxy: _UnixHTTPConnection, defined with the terminal proxy below)."""
    if not HUB_TMUXD_SOCK:
        raise OSError("hub-tmuxd is not configured (HUB_TMUXD_SOCK is empty; see host/README.md)")
    conn = _UnixHTTPConnection(HUB_TMUXD_SOCK, timeout=25.0)
    try:
        conn.request(method, path, body=json.dumps(body or {}),
                     headers={"Host": "localhost", "Content-Type": "application/json"})
        resp = conn.getresponse()
        raw = resp.read()
        try:
            data = json.loads(raw or b"{}")
        except ValueError:
            data = {"error": raw.decode(errors="replace")[:200]}
        return resp.status, data
    finally:
        conn.close()


def _apply_tmux(req: WriteRequest) -> dict[str, Any]:
    """Dispatch a verified tmux.spawn/tmux.kill to hub-tmuxd. The daemon re-validates
    independently (slug shape, protected blocklist) — two gates, same as the bridge."""
    path = "/spawn" if req.action == "tmux.spawn" else "/kill"
    body: dict[str, Any] = {}
    if req.name:
        body["name"] = req.name
    if req.host:
        body["host"] = req.host
    if req.resume:
        body["resume"] = req.resume
    if req.cwd:
        body["cwd"] = req.cwd
    try:
        status, data = _tmuxd_request("POST", path, body)
    except OSError as exc:
        raise HTTPException(status_code=502, detail={"code": "tmuxd_unreachable", "detail": str(exc)})
    if status != 200:
        raise HTTPException(status_code=502, detail={"code": "tmuxd_error",
                                                     "detail": data.get("error", f"HTTP {status}")})
    return {
        "status": "applied",
        **data,
        "applied_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def _require_term_session(token: str | None) -> None:
    """The tmux reads disclose host session names, working directories and transcript
    titles, so they need the same terminal session the shell itself does. The cookie is
    issued with a second path, /api/tmux, beside /terminal (see terminal_session), so a
    client that unlocked the terminal carries it here too."""
    if not _term_session_valid(token):
        status, detail = locked_gate_detail("terminal")
        raise HTTPException(status_code=status, detail=detail)


@app.get("/api/tmux/sessions")
def tmux_sessions(hub_term_session: str | None = Cookie(default=None)) -> dict[str, Any]:
    """Host tmux sessions via hub-tmuxd: names, timestamps and window counts, never
    content. Gated by the terminal session cookie."""
    _require_term_session(hub_term_session)
    try:
        status, data = _tmuxd_request("GET", "/sessions")
    except OSError as exc:
        raise HTTPException(status_code=503, detail=f"tmuxd unreachable: {exc}")
    if status != 200:
        raise HTTPException(status_code=502, detail=str(data.get("error", f"HTTP {status}")))
    return data


@app.get("/api/tmux/history")
def tmux_history(hub_term_session: str | None = Cookie(default=None)) -> dict[str, Any]:
    """Recent Claude Code transcripts per host via hub-tmuxd (titles + ids only, never
    content) — the pool a tmux.spawn with `resume` draws from. Gated by the terminal
    session cookie."""
    _require_term_session(hub_term_session)
    try:
        status, data = _tmuxd_request("GET", "/history")
    except OSError as exc:
        raise HTTPException(status_code=503, detail=f"tmuxd unreachable: {exc}")
    if status != 200:
        raise HTTPException(status_code=502, detail=str(data.get("error", f"HTTP {status}")))
    return data


# --- Terminal unlock (WebAuthn assertion -> hub_term_session cookie) --------
# Active terminal sessions: cookie token -> expiry (monotonic). In-process is fine —
# the compose file pins hub-api to a single uvicorn worker.
_TERM_SESSIONS: dict[str, float] = {}
_TERM_LOCK = threading.Lock()


def _term_session_new() -> str:
    token = secrets_mod.token_urlsafe(32)
    with _TERM_LOCK:
        # opportunistic GC
        now = time.monotonic()
        for t in [t for t, exp in _TERM_SESSIONS.items() if exp < now]:
            _TERM_SESSIONS.pop(t, None)
        _TERM_SESSIONS[token] = now + HUB_TERM_SESSION_TTL_S
    return token


def _term_session_valid(token: str | None) -> bool:
    if not token:
        return False
    with _TERM_LOCK:
        exp = _TERM_SESSIONS.get(token)
        if exp is None:
            return False
        if exp < time.monotonic():
            _TERM_SESSIONS.pop(token, None)
            return False
        return True


def _term_session_drop(token: str | None) -> None:
    if not token:
        return
    with _TERM_LOCK:
        _TERM_SESSIONS.pop(token, None)


@app.post("/api/terminal/challenge")
def terminal_challenge() -> dict[str, Any]:
    """Assertion challenge for the terminal unlock — a passkey when one exists, else the
    native app's paired device key. Fails closed with 412 only when NOTHING is enrolled."""
    try:
        return wa.assertion_options_any("terminal", None)
    except wa.NoPasskeyError:
        raise HTTPException(
            status_code=412,
            detail={"code": "no_passkey", "detail": "No passkey registered. Enrol in Settings first."},
        )


# The same session token rides two paths: /terminal (the ttyd proxy) and /api/tmux (the
# tmux reads). A cookie path is a prefix match, so one cookie cannot cover both without
# also reaching every other /api route.
_TERM_COOKIE_PATHS = ("/terminal", "/api/tmux")


@app.post("/api/terminal/session")
def terminal_session(req: TerminalSessionRequest, response: Response) -> dict[str, bool]:
    """Verify the assertion and, only on success, issue the hub_term_session cookie
    that the /terminal proxy and the /api/tmux reads require. Unknown/absent/invalid
    assertion → 403/412."""
    _require_enrolled(req.devicekey_assertion)
    _verify_proof(req, "terminal", None)
    token = _term_session_new()
    for path in _TERM_COOKIE_PATHS:
        response.set_cookie(
            "hub_term_session",
            token,
            max_age=HUB_TERM_SESSION_TTL_S,
            httponly=True,
            secure=True,
            samesite="strict",
            path=path,
        )
    return {"ok": True}


@app.post("/api/terminal/logout")
def terminal_logout(response: Response, hub_term_session: str | None = Cookie(default=None)) -> dict[str, bool]:
    _term_session_drop(hub_term_session)
    for path in _TERM_COOKIE_PATHS:
        response.delete_cookie("hub_term_session", path=path)
    return {"ok": True}


@app.get("/api/activity")
def activity() -> list[dict[str, Any]]:
    """ActivityEntry[] newest-first, per apps/hub/src/lib/types.ts, from the
    cache the box activity writer maintains. time_label is computed here at
    read time from each entry's ts."""
    entries = read_cache(ACTIVITY_JSON, "activity", CACHE_MAX_AGE_S)
    for e in entries:
        e["time_label"] = _time_label(e.get("ts"))
    return entries


@app.get("/api/schedules")
def schedules() -> list[dict[str, Any]]:
    """ScheduledTask[] {id, label, cadence, next_run_at, last_run} per
    apps/hub/src/lib/types.ts. Served verbatim from the cache the box
    schedule writer maintains (Hermes cron store)."""
    return read_cache(SCHEDULES_JSON, "schedules", CACHE_MAX_AGE_S)


# /api/skills is repointed to the CLI-bridge (`hermes skills list`) in the
# System read surface below — the old cache-backed stub was removed in Slice 2a.


_BRIEF_SLUG_RE = re.compile(r"^briefing-\d{4}-\d{2}-\d{2}$")
_TITLE_TAG_RE = re.compile(r"<title>(.*?)</title>", re.IGNORECASE | re.DOTALL)


def _scan_my_pages() -> list[dict[str, Any]]:
    """Agent-published pages: every MY_PAGES_ROOT subdir WITH an index.html is a
    page (asset-only dirs like fonts/ don't qualify). title from the first 8KB's
    <title> tag (fallback slug), mtime from index.html, newest first. Shared by
    /api/my-pages and the /api/feed brief items."""
    pages: list[dict[str, Any]] = []
    if MY_PAGES_ROOT.is_dir():
        for entry in MY_PAGES_ROOT.iterdir():
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            index = entry / "index.html"
            try:
                with index.open("rb") as fh:
                    head = fh.read(8192).decode("utf-8", errors="replace")
                mtime = int(index.stat().st_mtime)
            except OSError:
                continue  # no index.html (or unreadable) — not a page
            m = _TITLE_TAG_RE.search(head)
            title = html.unescape(m.group(1)).strip() if m else ""
            pages.append({
                "slug": entry.name,
                "title": title or entry.name,
                "mtime": mtime,
                "kind": "brief" if _BRIEF_SLUG_RE.match(entry.name) else "page",
            })
    pages.sort(key=lambda p: p["mtime"], reverse=True)
    return pages


@app.get("/api/my-pages")
def my_pages() -> dict[str, Any]:
    """Self-hosted pages under MY_PAGES_ROOT, one entry per slug dir with an
    index.html. The curated ~/.hub/my-pages.json layer is retired — the scan
    itself is the catalogue."""
    return {"pages": _scan_my_pages()}


# Finance snapshot: written by a scheduled job you run beside the gateway (this repo
# does not ship one). hub-api never touches the finance source — it only serves the
# file.
FINANCE_SNAPSHOT = Path(os.environ.get("HUB_FINANCE_SNAPSHOT", "/data/sites/finance/snapshot.json"))


@app.get("/api/finance")
def finance() -> dict[str, Any]:
    """Day-to-day spend snapshot for the Hub. 404 → cards self-hide (not-set-up yet)."""
    if not FINANCE_SNAPSHOT.exists():
        raise HTTPException(status_code=404, detail="finance snapshot not written yet")
    try:
        return json.loads(FINANCE_SNAPSHOT.read_text())
    except (json.JSONDecodeError, OSError):
        raise HTTPException(status_code=503, detail="finance snapshot unreadable")


# Sandboxed static serving for the pages themselves. These are agent-generated
# from UNTRUSTED inputs (email/calendar content), so every response — including
# errors — carries a CSP that forbids script outright: a poisoned page must never
# run same-origin with the hub's terminal cookie. tailscale serve is repointed
# from the old static file server to this route at deploy time.
_MY_PAGES_HEADERS = {
    "Content-Security-Policy": (
        "sandbox; default-src 'self' data:; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; script-src 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
}

# Path-scoped relaxation for the iMessage compose sub-pages ONLY
# (*/imessage/*.html): they carry a plain same-origin POST form to
# /api/chat/imessage/draft, so they need allow-forms + allow-same-origin and
# form-action 'self'. Script stays forbidden — the compose flow is 100%
# server-rendered, no JS anywhere. Every other my-page keeps the fully
# locked-down _MY_PAGES_HEADERS above.
_IMESSAGE_PAGE_HEADERS = {
    "Content-Security-Policy": (
        "sandbox allow-forms allow-same-origin; default-src 'self' data:; "
        "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
        "script-src 'none'; form-action 'self'"
    ),
    "X-Content-Type-Options": "nosniff",
}

# Same relaxation for the briefing pages themselves (briefing-<date>/*.html):
# their dismiss/snooze controls are plain POST forms. Script stays 'none' —
# the whole flow is server-rendered. An earlier attempt inlined JS here and
# could never work: `sandbox` alone blocks form submission AND `script-src
# 'none'` blocks every listener, silently, with no console error.
_BRIEFING_PAGE_HEADERS = _IMESSAGE_PAGE_HEADERS

# --- briefing dismiss / snooze ------------------------------------------------
# The store lives under the hub mount because that is the ONLY writable path
# hub-api shares with the gateway (`sites` is ro, `workspace` isn't mounted at
# all). The generator reads the same file at the hub data mount and drops
# hidden items at render time; this module hides them at SERVE time, so a
# dismissal takes effect on the very next page load instead of tomorrow.
BRIEFING_DISMISSALS = Path(os.environ.get(
    "HUB_BRIEFING_DISMISSALS", "/data/hub/data/briefing_dismissals.json"))

_DZ_ID_RE = re.compile(r"^[0-9a-f]{12}$")
_DZ_RETURN_RE = re.compile(
    r"^/my-pages/briefing-\d{4}-\d{2}-\d{2}/(?:(?:index|work|personal)\.html)?$")
_DZ_SNOOZE_DAYS = {"1d": 1, "3d": 3, "7d": 7}
_dz_lock = threading.Lock()

_DZ_CARD_RE = re.compile(r"<!--dz:([0-9a-f]{12})(:need)?-->.*?<!--/dz:\1-->", re.DOTALL)
_DZ_SEC_RE = re.compile(r"<!--dzsec-->.*?<!--/dzsec-->", re.DOTALL)
_DZ_COUNT_RE = re.compile(r'(<[^>]*\bdata-dz-count="(sec|page|need|needall)"[^>]*>)([^<]*)(</)')
_DZ_NEED_RE = re.compile(r"<!--dz:([0-9a-f]{12}):need-->")
_DZ_TPL_RE = re.compile(r'data-dz-tpl="([^"]*)"')


_DZ_NOW_RE = re.compile(r"<!--dznow:(\d+):(\d+)-->")


def _dz_now(page: str, slug: str) -> str:
    """Drop a 'you are here' marker on today's day strip. The page is rendered
    once at 07:30, so the position has to be computed per request or it lies."""
    m = _DZ_NOW_RE.search(page)
    if not m:
        return page
    now = datetime.now(HUB_TZ)
    if f"briefing-{now:%Y-%m-%d}" != slug:
        return page
    lo, hi = int(m.group(1)), int(m.group(2))
    mins = now.hour * 60 + now.minute
    if not lo <= mins <= hi or hi <= lo:
        return page
    left = (mins - lo) / (hi - lo) * 100
    return page.replace(m.group(0),
                        f'<span class="dnow" style="left:{left:.1f}%"></span>', 1)


def _is_brief_page(root: Path, target: Path) -> bool:
    """A top-level .html of a briefing dir — index/work/personal, never the
    email/ and imessage/ sub-pages one level deeper."""
    rel = target.relative_to(root).parts
    return len(rel) == 2 and rel[1].endswith(".html")


def _dz_load() -> dict[str, dict[str, str]]:
    """Active dismissals. Expired snoozes are filtered on read, never rewritten
    here — the writer owns the file."""
    try:
        data = json.loads(BRIEFING_DISMISSALS.read_text())
    except (OSError, json.JSONDecodeError):
        return {"dismissed": {}, "snoozed": {}}
    now = datetime.now(timezone.utc).isoformat()
    return {
        "dismissed": dict(data.get("dismissed") or {}),
        "snoozed": {k: v for k, v in (data.get("snoozed") or {}).items() if str(v) > now},
    }


def _dz_hidden() -> set[str]:
    d = _dz_load()
    return set(d["dismissed"]) | set(d["snoozed"])


def _dz_save(mutate) -> None:
    with _dz_lock:
        try:
            data = json.loads(BRIEFING_DISMISSALS.read_text())
        except (OSError, json.JSONDecodeError):
            data = {}
        data.setdefault("dismissed", {})
        data.setdefault("snoozed", {})
        mutate(data)
        BRIEFING_DISMISSALS.parent.mkdir(parents=True, exist_ok=True)
        tmp = BRIEFING_DISMISSALS.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, sort_keys=True))
        os.replace(tmp, BRIEFING_DISMISSALS)


_DZ_REASONS = {
    "irrelevant": "not relevant", "bot": "automated",
    # Ruling 146: the native undo-row "why" chips. Codes match what
    # brief_triage.load_exemplars groups negatives by — not-mine reads as
    # D1/D4, done as DONE, noise as D2/NOISE.
    "not-mine": "not his", "done": "already done", "noise": "not important",
}


def _dz_undo_bar(item_id: str, action: str, return_to: str, reason: str = "") -> str:
    """Undo, plus — on a dismiss — a one-tap 'why'. The reason is the only
    signal tomorrow's gather gets about what the user does not want to see, so it
    is offered at the one moment he has just proved he has an opinion."""
    snoozed = action.startswith("snooze")
    label = f"Snoozed {action.split(':', 1)[1]}" if action.startswith("snooze:") else (
        "Snoozed" if snoozed else "Dismissed")
    if reason:
        label = f"Noted — less {_DZ_REASONS[reason]} mail like that"
    why = "" if (snoozed or reason) else "".join(
        f'<button class="dz-why" name="action" value="reason:{code}">{text}</button>'
        for code, text in _DZ_REASONS.items())
    return (
        f'<form class="dz-undo{" snoozed" if snoozed else ""}" method="POST" '
        f'action="/api/briefing/dismiss">'
        f'<input type="hidden" name="item_id" value="{html.escape(item_id)}">'
        f'<input type="hidden" name="return_to" value="{html.escape(return_to)}">'
        f'<span class="dz-undo-label">{label}</span>{why}'
        f'<button name="action" value="undo">Undo</button></form>'
    )


_DZ_WS_RE = re.compile(r"\s+")


def _dz_one_line(text: str) -> str:
    """Feedback is a JSONL ledger the gather reads back line by line — a title
    carrying a newline (subjects routinely do) has to collapse to one line."""
    return _DZ_WS_RE.sub(" ", text).strip()


def _dz_card_facts(brief_dir: Path, item_id: str) -> dict[str, str]:
    """Title/source for a card, read back off the rendered pages — so the form
    stays two hidden fields instead of shipping the whole item through a URL."""
    pat = re.compile(r"<!--dz:" + item_id + r"(?::need)?-->(.*?)<!--/dz:" + item_id + r"-->",
                     re.DOTALL)
    try:
        pages = sorted(brief_dir.glob("*.html"))
    except OSError:
        return {}
    for p in pages:
        try:
            m = pat.search(p.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
        if not m:
            continue
        card = m.group(1)
        # cards and the three row shapes each name their title differently
        title = re.search(
            r'class="(?:card-title|row-title|li-title|m-payee)"[^>]*>(?:<a[^>]*>)?([^<]+)', card)
        tag = re.search(r'class="(?:tag|tag card-jump|li-tag|src)"[^>]*>([^<↗]+)', card)
        return {"title": _dz_one_line(html.unescape(title.group(1))) if title else "",
                "source": _dz_one_line(html.unescape(tag.group(1))) if tag else "",
                "page": p.name}
    return {}


BRIEFING_FEEDBACK = Path(os.environ.get(
    "HUB_BRIEFING_FEEDBACK", "/data/hub/data/briefing_feedback.jsonl"))


def _dz_feedback(entry: dict[str, Any]) -> None:
    """Append-only: the gather reads it to learn what to stop surfacing."""
    with _dz_lock:
        BRIEFING_FEEDBACK.parent.mkdir(parents=True, exist_ok=True)
        with BRIEFING_FEEDBACK.open("a") as fh:
            fh.write(json.dumps(entry, sort_keys=True) + "\n")


def _dz_feedback_once(entry: dict[str, Any]) -> bool:
    """Append unless (brief, item_id, signal) is already on the ledger. Scan and
    append share the one lock so two taps cannot both decide they are the first."""
    key = (entry["brief"], entry["item_id"], entry["signal"])
    with _dz_lock:
        try:
            lines = BRIEFING_FEEDBACK.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            lines = []
        for line in lines:
            try:
                seen = json.loads(line)
            except ValueError:
                continue
            if (seen.get("brief"), seen.get("item_id"), seen.get("signal")) == key:
                return False
        BRIEFING_FEEDBACK.parent.mkdir(parents=True, exist_ok=True)
        with BRIEFING_FEEDBACK.open("a") as fh:
            fh.write(json.dumps(entry, sort_keys=True) + "\n")
    return True


def _dz_needall(brief_dir: Path, hidden: set[str]) -> int:
    """Hidden needs-you items across the WHOLE briefing. The index status line
    tallies both splits, so a card dismissed on work.html has to move it even
    though that card never appears on the index."""
    ids: set[str] = set()
    try:
        pages = sorted(brief_dir.glob("*.html"))
    except OSError:
        return 0
    for p in pages:
        try:
            ids |= set(_DZ_NEED_RE.findall(p.read_text(encoding="utf-8", errors="replace")))
        except OSError:
            continue
    return len(ids & hidden)


def _dz_apply(page: str, hidden: set[str], undo: str, needall: int = 0) -> str:
    """Drop hidden cards, prune sections they emptied, refresh the counters
    that named them, and drop the undo bar into its slot."""
    gone, gone_need = set(), set()
    for m in _DZ_CARD_RE.finditer(page):
        if m.group(1) in hidden:
            gone.add(m.group(1))
            if m.group(2):
                gone_need.add(m.group(1))

    # Counters are DECREMENTED, never replaced by the surviving-card count: a
    # pagehead tallies every item on the page, and Money/FYI rows carry no
    # dismiss control, so overwriting it with the card count erased them.
    # Always derived from the static file's number, so re-filtering is stable.
    def recount(chunk: str, removed: dict[str, int]) -> str:
        def fix(m: re.Match) -> str:
            drop = removed.get(m.group(2))
            if drop is None:
                return m.group(0)
            was = re.match(r"\s*(\d+)", html.unescape(m.group(3)))
            if not was:
                return m.group(0)
            n = max(0, int(was.group(1)) - drop)
            tpl = _DZ_TPL_RE.search(m.group(1))
            if tpl:
                forms = html.unescape(tpl.group(1)).split("|")
                text = (forms[0] if n == 1 else forms[-1]).replace("{n}", str(n))
            else:
                text = str(n)
            return f"{m.group(1)}{text}{m.group(4)}"
        return _DZ_COUNT_RE.sub(fix, chunk)

    # section counters first, while the section still shows what it is losing
    def recount_section(m: re.Match) -> str:
        inner = set(re.findall(r"<!--dz:([0-9a-f]{12})", m.group(0)))
        return recount(m.group(0), {"sec": len(inner & gone)})

    page = _DZ_SEC_RE.sub(recount_section, page)
    page = _DZ_CARD_RE.sub(lambda m: "" if m.group(1) in hidden else m.group(0), page)
    # a <!--dzsec--> wrapper only ever holds cards, so zero survivors = empty section
    page = _DZ_SEC_RE.sub(lambda m: "" if not _DZ_CARD_RE.search(m.group(0)) else m.group(0), page)
    page = recount(page, {"page": len(gone), "need": len(gone_need), "needall": needall})
    return page.replace("<!--dz-undo-->", undo, 1)


@app.post("/api/briefing/dismiss")
async def briefing_dismiss(request: Request) -> Response:
    """Plain form POST from a briefing page. No JS — the page it returns to is
    filtered at serve time, so the card is simply gone on arrival."""
    form = await _form_fields(request)
    item_id = form.get("item_id", "").strip()
    action = form.get("action", "").strip()
    return_to = form.get("return_to", "").strip()

    if not _DZ_ID_RE.match(item_id) or not _DZ_RETURN_RE.match(return_to):
        raise HTTPException(status_code=400, detail="bad dismiss request",
                            headers=_MY_PAGES_HEADERS)

    if action == "undo":
        def undo(d):
            d["dismissed"].pop(item_id, None)
            d["snoozed"].pop(item_id, None)
        _dz_save(undo)
        return Response(status_code=303, headers={"Location": return_to})

    if action.startswith("reason:"):
        code = action.partition(":")[2]
        if code not in _DZ_REASONS:
            raise HTTPException(status_code=400, detail="unknown reason",
                                headers=_MY_PAGES_HEADERS)
        brief = MY_PAGES_ROOT / return_to.split("/")[2]
        facts = _dz_card_facts(brief, item_id)
        _dz_feedback({"ts": datetime.now(timezone.utc).isoformat(),
                      "item_id": item_id, "reason": code,
                      "title": facts.get("title", ""),
                      "source": facts.get("source", ""),
                      "brief": brief.name})
        return Response(status_code=303,
                        headers={"Location": f"{return_to}?u={item_id}&a=dismiss&r={code}"})

    if action == "dismiss":
        def dismiss(d):
            d["dismissed"][item_id] = "permanent"
            d["snoozed"].pop(item_id, None)
        _dz_save(dismiss)
        back = f"{return_to}?u={item_id}&a=dismiss"
    elif action.startswith("snooze"):
        span = action.partition(":")[2] or "1d"
        days = _DZ_SNOOZE_DAYS.get(span)
        if days is None:
            raise HTTPException(status_code=400, detail="bad snooze span",
                                headers=_MY_PAGES_HEADERS)
        until = (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()

        def snooze(d):
            d["snoozed"][item_id] = until
            d["dismissed"].pop(item_id, None)
        _dz_save(snooze)
        back = f"{return_to}?u={item_id}&a=snooze:{span}"
    else:
        raise HTTPException(status_code=400, detail="bad action",
                            headers=_MY_PAGES_HEADERS)

    return Response(status_code=303, headers={"Location": back})


# --- brief.json for the native app -------------------------------------------
# The app never fetches the rendered HTML: it reads the same brief.json the
# generator wrote, filtered at serve time by the dismissal store so a tap on one
# surface is gone on the other. brief.json itself is NOT reachable over HTTP
# (Ruling 50 — see my_page_static below); this endpoint is the only door.
_BRIEF_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_BRIEF_BUCKETS = ("now", "today", "week", "background")
_BRIEF_FALLBACK_DAYS = 5

# The brief is a live, per-request filtered view of a store the user is mutating
# from two surfaces — a cached copy would resurrect cards he just dismissed.
_BRIEF_JSON_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
}

# Per-item dismiss proof (Ruling 57): a background-capable app cannot present
# Face ID, so the write gate is an HMAC the generator mints per (date, item_id)
# rather than a device-key assertion. The key is a FILE under the hub mount, not
# an env var — provisioning it must never need a container recreate. Missing key
# = every token-checked endpoint 503s; there is no ungated path.
BRIEF_DISMISS_KEY_FILE = Path(os.environ.get(
    "HUB_BRIEF_DISMISS_KEY_FILE", "/data/hub/data/brief_dismiss.key"))


def _brief_dismiss_key() -> bytes:
    try:
        return BRIEF_DISMISS_KEY_FILE.read_bytes().strip()
    except OSError:
        return b""


def _require_brief_token(date: str, item_id: str, token: str) -> None:
    key = _brief_dismiss_key()
    if not key:
        raise HTTPException(status_code=503, detail={"code": "dismiss_key_unprovisioned",
                                                     "detail": "brief dismiss key not provisioned"})
    expected = hmac.new(key, f"{date}:{item_id}".encode(), hashlib.sha256).hexdigest()[:24]
    if not hmac.compare_digest(expected.encode(), token.encode()):
        raise HTTPException(status_code=403, detail={"code": "bad_item_token",
                                                     "detail": "bad item token"})


def _brief_load(date: str) -> dict[str, Any] | None:
    try:
        data = json.loads((MY_PAGES_ROOT / f"briefing-{date}" / "brief.json").read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _brief_item_facts(date: str, item_id: str) -> dict[str, str]:
    """Title/source straight off brief.json — the HTML scrape (_dz_card_facts)
    is for the form path, which only knows the slug."""
    buckets = (_brief_load(date) or {}).get("buckets")
    if not isinstance(buckets, dict):
        return {}
    for name in _BRIEF_BUCKETS:
        for item in buckets.get(name) or []:
            if isinstance(item, dict) and item.get("item_id") == item_id:
                return {"title": _dz_one_line(str(item.get("title") or "")),
                        "source": _dz_one_line(str(item.get("source") or ""))}
    return {}


# --- live source health -------------------------------------------------------
#
# `sources` inside a brief records the run that BUILT it, which is the right
# thing for explaining that brief — but it goes on naming a source hours after
# the user has reconnected it (a mail source reconnected in the afternoon could
# still read as down in the next morning's brief). mcp-watch probes the
# real capability every 30 minutes and its newest line is the freshest signal
# the box has, so the brief carries it alongside the snapshot and the app drops
# a warning the probe says is over. Only sources whose health an MCP actually
# determines appear here; the rest keep the snapshot's word.
MCP_WATCH_LOG = Path(os.environ.get("HUB_MCP_WATCH_LOG", "/data/hub/log/mcp-watch.jsonl"))

_MCP_FOR_SOURCE = {"email": "superhuman_mail", "calendar": "superhuman_mail",
                   "packages": "aftership", "imessage": "imessage"}


def _live_source_health() -> dict[str, str]:
    """{source: "ok"|"down"} from mcp-watch's newest line, or {} when it cannot
    be read. Silence is not health: an unreadable or stale-beyond-a-day log
    yields nothing and the brief's own snapshot stands unchallenged."""
    try:
        with MCP_WATCH_LOG.open("rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - 4096))
            tail = fh.read().decode("utf-8", "replace").splitlines()
        probe = json.loads(tail[-1])
    except (OSError, ValueError, IndexError):
        return {}
    try:
        ts = datetime.fromisoformat(str(probe.get("ts", "")).replace("Z", "+00:00"))
    except ValueError:
        return {}
    if datetime.now(timezone.utc) - ts > timedelta(hours=24):
        return {}
    out: dict[str, str] = {}
    for source, mcp in _MCP_FOR_SOURCE.items():
        raw = probe.get(mcp)
        if raw is None:
            continue
        out[source] = "ok" if str(raw) in ("200", "up", "ok") else "down"
    return out


@app.get("/api/brief")
def brief(date: str | None = None) -> Response:
    """Today's brief (ET), or ?date=YYYY-MM-DD. A missing day falls back to the
    most recent one within 5 days — served_date always says what was served, so
    the app can label a stale brief instead of showing an empty one."""
    if date is not None and not _BRIEF_DATE_RE.match(date):
        raise HTTPException(status_code=400, detail="bad date", headers=_BRIEF_JSON_HEADERS)
    try:
        start = (datetime.strptime(date, "%Y-%m-%d").date() if date
                 else datetime.now(HUB_TZ).date())
    except ValueError:
        raise HTTPException(status_code=400, detail="bad date", headers=_BRIEF_JSON_HEADERS)

    for back in range(_BRIEF_FALLBACK_DAYS + 1):
        served = (start - timedelta(days=back)).isoformat()
        data = _brief_load(served)
        if data is not None:
            break
    else:
        raise HTTPException(status_code=404, detail="no brief", headers=_BRIEF_JSON_HEADERS)

    hidden = _dz_hidden()
    hidden_count = 0
    buckets = data.get("buckets")
    if isinstance(buckets, dict):
        for name in _BRIEF_BUCKETS:
            items = buckets.get(name)
            if not isinstance(items, list):
                continue
            kept = [i for i in items
                    if not (isinstance(i, dict) and i.get("item_id") in hidden)]
            hidden_count += len(items) - len(kept)
            buckets[name] = kept
    data["hidden_count"] = hidden_count
    data["served_date"] = served
    data["live_sources"] = _live_source_health()
    return JSONResponse(data, headers=_BRIEF_JSON_HEADERS)


class BriefDismissBody(BaseModel):
    item_id: str
    action: str
    token: str
    date: str


class BriefUsefulBody(BaseModel):
    item_id: str
    token: str
    date: str


class BriefNoteBody(BaseModel):
    item_id: str
    token: str
    date: str
    note: str


@app.post("/api/briefing/dismiss.json")
def briefing_dismiss_json(body: BriefDismissBody) -> dict[str, Any]:
    """The native app's dismiss/snooze/undo. Same store and same actions as the
    form path above; the token replaces the form's return_to as the proof that
    the caller is acting on an item the generator actually emitted."""
    item_id, action, date = body.item_id.strip(), body.action.strip(), body.date.strip()
    if not _DZ_ID_RE.match(item_id) or not _BRIEF_DATE_RE.match(date):
        raise HTTPException(status_code=400, detail="bad dismiss request")
    _require_brief_token(date, item_id, body.token.strip())

    if action == "undo":
        def undo(d):
            d["dismissed"].pop(item_id, None)
            d["snoozed"].pop(item_id, None)
        _dz_save(undo)
        return {"ok": True, "item_id": item_id, "action": action}

    if action.startswith("reason:"):
        code = action.partition(":")[2]
        if code not in _DZ_REASONS:
            raise HTTPException(status_code=400, detail="unknown reason")
        facts = _brief_item_facts(date, item_id)
        _dz_feedback({"ts": datetime.now(timezone.utc).isoformat(),
                      "item_id": item_id, "reason": code,
                      "title": facts.get("title", ""),
                      "source": facts.get("source", ""),
                      "brief": f"briefing-{date}"})
        return {"ok": True, "item_id": item_id, "action": action}

    if action == "dismiss":
        def dismiss(d):
            d["dismissed"][item_id] = "permanent"
            d["snoozed"].pop(item_id, None)
        _dz_save(dismiss)
        return {"ok": True, "item_id": item_id, "action": action}

    if action.startswith("snooze"):
        span = action.partition(":")[2] or "1d"
        days = _DZ_SNOOZE_DAYS.get(span)
        if days is None:
            raise HTTPException(status_code=400, detail="bad snooze span")
        until = (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()

        def snooze(d):
            d["snoozed"][item_id] = until
            d["dismissed"].pop(item_id, None)
        _dz_save(snooze)
        return {"ok": True, "item_id": item_id, "action": action, "until": until}

    raise HTTPException(status_code=400, detail="bad action")


@app.post("/api/briefing/useful.json")
def briefing_useful_json(body: BriefUsefulBody) -> dict[str, Any]:
    """The positive half of the signal: dismissals told tomorrow's gather what to
    drop, this tells it what to keep. One entry per (brief, item) — a double tap
    must not weight the exemplar twice."""
    item_id, date = body.item_id.strip(), body.date.strip()
    if not _DZ_ID_RE.match(item_id) or not _BRIEF_DATE_RE.match(date):
        raise HTTPException(status_code=400, detail="bad useful request")
    _require_brief_token(date, item_id, body.token.strip())

    facts = _brief_item_facts(date, item_id)
    entry = {"ts": datetime.now(timezone.utc).isoformat(), "item_id": item_id,
             "signal": "useful", "title": facts.get("title", ""),
             "source": facts.get("source", ""), "brief": f"briefing-{date}"}
    if not _dz_feedback_once(entry):
        return {"ok": True, "item_id": item_id, "signal": "useful", "already": True}
    return {"ok": True, "item_id": item_id, "signal": "useful"}


@app.post("/api/briefing/note.json")
def briefing_note_json(body: BriefNoteBody) -> dict[str, Any]:
    """"Tell the brief about this" (Ruling 146): a one-line note on a past
    item, in the user's own words. Unlike useful.json this is NOT deduped —
    notes may repeat, because he can say something different about the same
    item twice and each one is worth keeping."""
    item_id, date = body.item_id.strip(), body.date.strip()
    if not _DZ_ID_RE.match(item_id) or not _BRIEF_DATE_RE.match(date):
        raise HTTPException(status_code=400, detail="bad note request")
    _require_brief_token(date, item_id, body.token.strip())

    note = _dz_one_line(body.note)
    if not (1 <= len(note) <= 300):
        raise HTTPException(status_code=400, detail="note must be 1-300 chars")

    facts = _brief_item_facts(date, item_id)
    _dz_feedback({"ts": datetime.now(timezone.utc).isoformat(), "item_id": item_id,
                  "signal": "note", "note": note, "title": facts.get("title", ""),
                  "source": facts.get("source", ""), "brief": f"briefing-{date}"})
    return {"ok": True, "item_id": item_id, "signal": "note"}


# --- briefing standing rules (Ruling 146) -------------------------------------
# "Teach the brief" — the user's own sentences, read back into every morning's
# prompt (brief_triage.load_exemplars, right after the date line). Not
# per-item, so the per-item brief HMAC (_require_brief_token) does not apply;
# gated instead the way every other non-item native write is: a device-key or
# WebAuthn assertion bound to the exact {text, remove} being applied, the same
# challenge -> assertion -> apply shape as /api/config/topics.
BRIEFING_RULES = Path(os.environ.get(
    "HUB_BRIEFING_RULES", "/data/hub/data/briefing_rules.json"))


class BriefingRuleOp(BaseModel):
    text: str | None = None
    remove: str | None = None

    @model_validator(mode="after")
    def _exactly_one_op(self) -> "BriefingRuleOp":
        if (self.text is None) == (self.remove is None):
            raise ValueError("exactly one of text or remove is required")
        return self


class BriefingRuleApplyRequest(GatedRequest, BriefingRuleOp):
    pass


def _validate_briefing_rule_op(op: BriefingRuleOp) -> None:
    """Shape-validate BEFORE a challenge is issued or a write lands — same
    posture as _validate_topics_config."""
    if op.text is not None:
        stripped = _dz_one_line(op.text)
        if not (1 <= len(stripped) <= 300):
            raise HTTPException(status_code=400,
                                detail={"code": "bad_request", "detail": "rule text must be 1-300 chars"})
    else:
        if not re.match(r"^[0-9a-f]{12}$", op.remove or ""):
            raise HTTPException(status_code=400,
                                detail={"code": "bad_request", "detail": "invalid rule id"})


def _canonical_rule_hash(op: BriefingRuleOp) -> str:
    """Same challenge-binding scheme as _canonical_topics_hash: sha256 over the
    canonical {text, remove}, so an assertion for one op can't apply another."""
    payload = json.dumps({"text": op.text, "remove": op.remove}, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()


def _rules_load() -> list[dict[str, Any]]:
    try:
        data = json.loads(BRIEFING_RULES.read_text())
    except (OSError, json.JSONDecodeError):
        return []
    rules = data.get("rules") if isinstance(data, dict) else None
    return rules if isinstance(rules, list) else []


def _rules_save(rules: list[dict[str, Any]]) -> None:
    with _dz_lock:
        BRIEFING_RULES.parent.mkdir(parents=True, exist_ok=True)
        tmp = BRIEFING_RULES.with_name(BRIEFING_RULES.name + ".tmp")
        tmp.write_text(json.dumps({"rules": rules}, indent=2, ensure_ascii=False) + "\n")
        tmp.replace(BRIEFING_RULES)


@app.get("/api/briefing/rules.json")
def briefing_rules_get() -> dict[str, Any]:
    """Read-only, no gate — tailnet-only like /api/brief itself."""
    return {"rules": _rules_load()}


@app.post("/api/briefing/rules.json/challenge")
def briefing_rules_challenge(op: BriefingRuleOp) -> dict[str, Any]:
    """Hash+cache the proposed add/remove and return an assertion challenge
    bound to it (mirrors /api/config/topics/challenge exactly)."""
    _validate_briefing_rule_op(op)
    try:
        return wa.assertion_options_any("briefing_rules", _canonical_rule_hash(op))
    except wa.NoPasskeyError:
        raise HTTPException(
            status_code=412,
            detail={"code": "no_passkey", "detail": "No passkey registered. Enrol in Settings first."},
        )


@app.post("/api/briefing/rules.json")
def briefing_rules_apply(req: BriefingRuleApplyRequest) -> dict[str, Any]:
    """Verify the assertion (bound to THIS exact op), then atomically add or
    remove one rule. Mirrors /api/config/topics's apply."""
    _require_enrolled(req.devicekey_assertion)
    _validate_briefing_rule_op(req)  # re-derive/validate; 400s on tamper
    _verify_proof(req, "briefing_rules", _canonical_rule_hash(req))
    rules = _rules_load()
    if req.text is not None:
        text = _dz_one_line(req.text)
        ts = datetime.now(timezone.utc).isoformat()
        rule_id = hashlib.sha256(f"{text}{ts}".encode()).hexdigest()[:12]
        rules.append({"id": rule_id, "text": text, "ts": ts})
    else:
        rules = [r for r in rules if r.get("id") != req.remove]
    _rules_save(rules)
    return {"rules": rules}


@app.get("/my-pages/{slug}")
@app.get("/my-pages/{slug}/{path:path}")
def my_page_static(request: Request, slug: str, path: str = "") -> Response:
    """Serve one file from MY_PAGES_ROOT/<slug>/ — directory paths get index.html.
    Traversal-guarded like files.py: dot segments rejected up front, then the
    resolved target must still sit under the resolved root (catches symlinks)."""
    segments = [s for s in f"{slug}/{path}".split("/") if s]
    if any(s.startswith(".") for s in segments):
        raise HTTPException(status_code=404, detail="not found", headers=_MY_PAGES_HEADERS)
    root = MY_PAGES_ROOT.resolve()
    target = root.joinpath(*segments).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=404, detail="not found", headers=_MY_PAGES_HEADERS)
    if target.is_dir():
        target = target / "index.html"
    if not target.is_file():
        raise HTTPException(status_code=404, detail="not found", headers=_MY_PAGES_HEADERS)
    # Ruling 50: a briefing dir also holds its own inputs — brief.json and
    # candidates/*.json, the unfiltered pre-dismissal record. Only the rendered
    # pages are servable; the app gets the data through /api/brief, which filters.
    if _BRIEF_SLUG_RE.match(segments[0]) and not target.name.endswith(".html"):
        raise HTTPException(status_code=404, detail="not found", headers=_MY_PAGES_HEADERS)
    ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    headers = _MY_PAGES_HEADERS
    if len(segments) >= 3 and segments[-2] == "imessage" and segments[-1].endswith(".html"):
        headers = _IMESSAGE_PAGE_HEADERS
    elif _BRIEF_SLUG_RE.match(segments[0]) and _is_brief_page(root, target):
        page = target.read_text(encoding="utf-8", errors="replace")
        if "<!--dz:" in page or "<!--dz-undo-->" in page:
            q = request.query_params
            uid, act = q.get("u", ""), q.get("a", "")
            undo = ""
            if _DZ_ID_RE.match(uid) and act[:7] in ("dismiss", "snooze:"):
                why = q.get("r", "")
                undo = _dz_undo_bar(uid, act, f"/my-pages/{segments[0]}/{target.name}",
                                    why if why in _DZ_REASONS else "")
            hidden = _dz_hidden()
            needall = (_dz_needall(target.parent, hidden)
                       if 'data-dz-count="needall"' in page else 0)
            return Response(
                content=_dz_now(_dz_apply(page, hidden, undo, needall), segments[0]),
                media_type=ctype, headers=_BRIEFING_PAGE_HEADERS)
        headers = _BRIEFING_PAGE_HEADERS
    return Response(content=target.read_bytes(), media_type=ctype, headers=headers)


# --- iMessage compose / approve / send ----------------------------------------
# The briefing's iMessage sub-pages POST a plain HTML form to
# /api/chat/imessage/draft (authenticated: the chat session cookie, or the platform
# bearer key for a server-side caller); hub-api forwards it to the Mac's iMessage
# MCP server (streamable HTTP JSON-RPC).
# Protocol facts (probed 2026-08-02 against imessage v3.4.4): the server
# REQUIRES a session — `initialize` returns an Mcp-Session-Id response header
# that must accompany every later call (a call without one is rejected 400
# "Missing session ID"); responses arrive as SSE ("event: message\ndata: {...}").
# Tool schemas (from tools/list): draft_imessage{to: str, text: str} where `to`
# is a contact name / exact phone / email / group-chat name (NOT the numeric
# chat_id); send_draft{draft_id: int}. Drafts expire ~15 min after creation and
# send_draft returns "pending" until the human approves on the Mac side.
#
# Design rules: GETs are side-effect-free (link-preview bots prefetch links);
# a message sends only after an explicit answer — a gated decision or chat
# approval, the approver's Discord button, or a POST to
# /api/imessage/send/{draft_id} carrying the draft's HMAC token — and a draft
# the Hub recorded answers through its first-answer-wins record, so it sends at
# most once; every response is server-rendered no-JS HTML and never claims
# success the MCP didn't confirm.

IMESSAGE_MCP_URL = os.environ.get("IMESSAGE_MCP_URL", "http://mac.internal.example:8400/mcp")
IMESSAGE_TOKEN_FILE = Path(os.environ.get("IMESSAGE_TOKEN_FILE", "/data/hub/secrets/imessage-token"))
IMESSAGE_QUEUE_DIR = Path(os.environ.get("IMESSAGE_QUEUE_DIR", "/data/hub/queue/imessage-drafts"))
COMPOSE_HMAC_FILE = Path(os.environ.get("COMPOSE_HMAC_FILE", "/data/hub/secrets/compose-hmac"))
HUB_PUBLIC_BASE = os.environ.get("HUB_PUBLIC_BASE", "https://hub.example.com")
# A draft created without a chat thread (an automation's draft) anchors its
# needs-you row in one bare, message-free thread so the home inbox — which reads
# every open attention row across threads — can still name where it lives.
IMESSAGE_ATTENTION_THREAD = os.environ.get("HUB_IMESSAGE_ATTENTION_THREAD", "home")
# How long (seconds) the Mac's own draft stays approvable — driven onto the
# needs-you row's countdown.
_IM_DRAFT_TTL_S = int(os.environ.get("HUB_IMESSAGE_DRAFT_TTL_S", "900"))
_IM_CONNECT_TIMEOUT_S = 3.0
_IM_TOTAL_TIMEOUT_S = 8.0
_IM_TEXT_MAX = 2000
_CHAT_ID_RE = re.compile(r"^\d{1,16}$")


class MacUnreachable(Exception):
    """The Mac (or its MCP port) can't be reached — asleep or off-tailnet."""


class ImessageMcpError(Exception):
    def __init__(self, message: str, code: int = -1):
        self.message, self.code = message, code
        super().__init__(message)


def _imessage_token() -> str:
    tok = os.environ.get("IMESSAGE_MCP_TOKEN", "").strip()
    if tok:
        return tok
    try:
        tok = IMESSAGE_TOKEN_FILE.read_text().strip()
    except OSError:
        tok = ""
    if not tok:
        raise ImessageMcpError("iMessage MCP token not configured (env IMESSAGE_MCP_TOKEN or /data/hub/secrets/imessage-token)")
    return tok


def _mcp_post(payload: dict[str, Any], session_id: str | None = None) -> tuple[Any, str | None]:
    """One JSON-RPC POST to the Mac MCP. Returns (result, session_id).
    Parses the SSE `data:` frame the server wraps responses in. Notifications
    (202, empty body) return (None, session_id)."""
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {_imessage_token()}",
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    req = urllib.request.Request(IMESSAGE_MCP_URL, data=json.dumps(payload).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=_IM_TOTAL_TIMEOUT_S) as resp:
            sid = resp.headers.get("Mcp-Session-Id") or session_id
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        raise ImessageMcpError(f"MCP HTTP {e.code}: {body}", e.code)
    except (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError, OSError) as e:
        raise MacUnreachable(str(e))
    if not raw.strip():
        return None, sid
    m = re.search(r"data:\s*(\{.*\})", raw, re.DOTALL)
    try:
        body_json = json.loads(m.group(1) if m else raw)
    except json.JSONDecodeError:
        raise ImessageMcpError(f"unparseable MCP response: {raw[:200]!r}")
    if "error" in body_json:
        err = body_json["error"]
        raise ImessageMcpError(err.get("message", str(err)), err.get("code", -1))
    return body_json.get("result"), sid


def _imessage_tool_call(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Full handshake + tools/call, blocking (callers run it in a thread).
    A cheap TCP preflight (3s) classifies Mac-asleep before the 8s calls."""
    u = urllib.parse.urlsplit(IMESSAGE_MCP_URL)
    try:
        socket.create_connection((u.hostname, u.port or 80), timeout=_IM_CONNECT_TIMEOUT_S).close()
    except OSError as e:
        raise MacUnreachable(f"connect {u.hostname}:{u.port}: {e}")
    _, sid = _mcp_post({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                   "clientInfo": {"name": "hub-api-compose", "version": "1.0"}},
    })
    _mcp_post({"jsonrpc": "2.0", "method": "notifications/initialized"}, session_id=sid)
    result, _ = _mcp_post({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }, session_id=sid)
    return result if isinstance(result, dict) else {}


def _tool_result_text(result: dict[str, Any]) -> str:
    parts = [c.get("text", "") for c in result.get("content") or []
             if isinstance(c, dict) and c.get("type") == "text"]
    return "\n".join(p for p in parts if p)


def _extract_draft_id(result: dict[str, Any]) -> int | None:
    sc = result.get("structuredContent")
    if isinstance(sc, dict):
        for container in (sc, sc.get("result") if isinstance(sc.get("result"), dict) else {}):
            for key in ("draft_id", "id"):
                v = container.get(key)
                if isinstance(v, int):
                    return v
                if isinstance(v, str) and v.isdigit():
                    return int(v)
    m = re.search(r"draft[_\s-]*id\D{0,5}(\d+)", _tool_result_text(result), re.IGNORECASE)
    return int(m.group(1)) if m else None


def _mac_decide_draft(draft_id: int, decision: str) -> None:
    """Tell the Mac the user's decision on a draft, through its own `decide_draft`
    tool — the SAME pending→approved|denied CAS its Discord button applies. Without
    this the Mac keeps the draft 'pending' and `send_draft` refuses to send, even
    though the Hub already recorded the answer.

    Best-effort by design: an older Mac build without the tool (or an unreachable
    Mac) must not fail the Hub's own answer — the draft then stays for the
    Discord/tapback path exactly as before. Never raises."""
    try:
        _imessage_tool_call("decide_draft", {"draft_id": draft_id, "decision": decision})
    except Exception:  # noqa: BLE001 — a missing tool/Mac must not break the answer
        logger.warning("decide_draft on the Mac failed for draft %s (%s)", draft_id, decision)


def _send_draft_outcome(draft_id: int) -> tuple[str, str]:
    """Ask the Mac to send one approved draft, normalized to (outcome, detail).

    First applies the user's approval to the Mac's own draft gate (`decide_draft`),
    then calls `send_draft` — so a Hub approval is sufficient on its own; the
    Discord ✅ / self-chat ❤️ tapback remains a fallback, not a requirement.

    Never raises: every failure is a recorded outcome the card can state, never a
    second send. The OUTCOME vocabulary is `chat/imessage_draft.py`'s
    (sent|pending|unreachable|error|unconfirmed). This is app.py's half of that
    module's injected sender, so the Hub answer route and the Discord button both
    reach the Mac through exactly this one function."""
    _mac_decide_draft(draft_id, "approve")
    try:
        result = _imessage_tool_call("send_draft", {"draft_id": draft_id})
    except MacUnreachable:
        return "unreachable", "the Mac was unreachable"
    except ImessageMcpError as e:
        return "error", e.message[:250]
    text_out = _tool_result_text(result)
    sc = result.get("structuredContent") if isinstance(result.get("structuredContent"), dict) else {}
    blob = f"{str(sc.get('status', '')).lower()} {text_out}".lower()
    if result.get("isError"):
        return "error", text_out[:250]
    if "pending" in blob or "not yet approved" in blob or "awaiting" in blob:
        return "pending", text_out[:200]
    if str(sc.get("status", "")).lower() == "sent" or re.search(r"\bsent\b", blob):
        return "sent", text_out[:200]
    # never claim a send the Mac did not confirm
    return "unconfirmed", (text_out or json.dumps(sc))[:250]


chat_imessage_draft.set_sender(_send_draft_outcome)
chat_imessage_draft.set_decider(_mac_decide_draft)


def _imessage_draft_expiry_iso() -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=_IM_DRAFT_TTL_S)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _mirror_draft_to_hub(draft_id: int, contact: str, text: str,
                         thread_id: str | None = None) -> str | None:
    """Best-effort: put the draft in the Hub's needs-you inbox — and, when a chat
    thread named the draft, as the thread card the Hub (and the Discord button)
    answer through the SAME first-answer-wins record. A draft with no thread (an
    automation's) gets the attention row ONLY: nothing is delivered into any
    chat, and the home inbox stays the one place it shows. A mirror failure must
    never fail the compose — the draft exists on the Mac either way (the same
    contract `_notify_approvals` follows). After this,
    `chat_imessage_draft.resolve_imessage_draft` owns the one send. Returns the
    attention row's id, or None when nothing could be recorded."""
    summary = f"Approve iMessage to {contact}" + (f": “{text[:120]}”" if text else "")
    rid = f"imessage_draft_{draft_id}"
    try:
        if thread_id:
            get_store().upsert_imessage_draft(
                draft_id=draft_id,
                thread_id=thread_id,
                contact=contact,
                text=text,
                expires_at_derived=_imessage_draft_expiry_iso(),
                summary=summary,
                thread_title=None,
            )
            row = get_store().thread_open_attention(thread_id)
            att = next((a for a in row if a.get("request_id") == rid), None)
            if att is None:
                return None
            return att.get("attention_id") or att.get("id")
        get_store().register_imessage_draft_automation(
            draft_id=draft_id,
            contact=contact,
            text=text,
            expires_at_derived=_imessage_draft_expiry_iso(),
        )
        _write_draft_decision(draft_id, contact, text)
        return rid
    except Exception:
        import sys, traceback as _tb
        print("MIRROR-FAIL:", file=sys.stderr); _tb.print_exc()
        return None


def _compose_hmac_key() -> bytes:
    """Per-box HMAC key for approve/send tokens; generated once, mode 0600."""
    try:
        key = COMPOSE_HMAC_FILE.read_bytes().strip()
        if key:
            return key
    except OSError:
        pass
    COMPOSE_HMAC_FILE.parent.mkdir(parents=True, exist_ok=True)
    key = secrets_mod.token_hex(32).encode()
    try:
        fd = os.open(str(COMPOSE_HMAC_FILE), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(key)
        return key
    except FileExistsError:
        return COMPOSE_HMAC_FILE.read_bytes().strip()


def _draft_token(draft_id: int) -> str:
    return hmac.new(_compose_hmac_key(), f"imessage-draft:{draft_id}".encode(), hashlib.sha256).hexdigest()


def _verify_draft_token(draft_id: int, t: str) -> bool:
    return bool(t) and hmac.compare_digest(_draft_token(draft_id), t)


_COMPOSE_PAGE_TMPL = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>{title}</title>
<style>
:root{{color-scheme:dark light}}
body{{background:#0a0b0d;color:#f2f3f5;font-family:-apple-system,system-ui,sans-serif;
  margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px}}
@media (prefers-color-scheme:light){{body{{background:#f5f5f7;color:#1a1a1e}}
  .card{{background:#fff;border-color:rgba(0,0,0,.08)}}
  .sub{{color:#6e6e78}} .meta{{color:#9999a4;border-color:rgba(0,0,0,.07)}}}}
.card{{background:#121316;border:1px solid rgba(255,255,255,.08);border-radius:16px;
  max-width:440px;width:100%;padding:28px 24px;text-align:center}}
.icon{{font-size:34px;margin-bottom:12px}}
h1{{font-size:19px;font-weight:650;margin:0 0 8px}}
.sub{{font-size:14.5px;line-height:1.5;color:#8b919b;margin:0 0 4px}}
.meta{{font-size:12px;color:#5d626b;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,.06);
  overflow-wrap:break-word;white-space:pre-wrap;text-align:left}}
.btn{{display:inline-block;background:#0a84ff;color:#fff;border:none;border-radius:22px;
  padding:12px 28px;font-size:16px;font-weight:600;cursor:pointer;margin-top:14px;
  font-family:inherit;text-decoration:none}}
.btn:active{{opacity:.85}}
a.link{{color:#60a5fa;font-size:13.5px;text-decoration:none}}
form{{margin:0}}
</style>
</head>
<body>
<div class="card">
<div class="icon">{icon}</div>
<h1>{heading}</h1>
{body}
</div>
</body>
</html>"""


def _compose_page(title: str, icon: str, heading: str, body: str, status: int = 200) -> Response:
    """Server-rendered no-JS result page. `body` is pre-built HTML whose dynamic
    parts the callers html.escape() themselves."""
    page = _COMPOSE_PAGE_TMPL.format(title=html.escape(title), icon=icon,
                                     heading=html.escape(heading), body=body)
    return Response(content=page, media_type="text/html", status_code=status,
                    headers=_IMESSAGE_PAGE_HEADERS)


def _queue_draft(chat_id: str, contact: str, text: str) -> str:
    """Persist a draft request for a dequeue job of your own; returns the queue filename."""
    IMESSAGE_QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    name = f"{ts}-{secrets_mod.token_hex(4)}.json"
    payload = {
        "chat_id": chat_id,
        "contact": contact,
        "to": contact or chat_id,
        "text": text,
        "queued_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "hub-api compose",
    }
    (IMESSAGE_QUEUE_DIR / name).write_text(json.dumps(payload, indent=1))
    return name


# --- Approvals bot (Discord, optional) -----------------------------------------
# Posts each new draft to an approvals channel with Approve/Deny buttons. It runs on
# its OWN bot token, separate from the assistant's, so the assistant cannot post as
# the approver and this token can do nothing but post in that channel. A draft never
# auto-sends: a press is one more explicit answer through the draft's own record.
#
# Buttons arrive over an OUTBOUND gateway websocket, never an inbound
# interactions-endpoint URL, so nothing has to be exposed to the internet.
#
# Dormant until the token file, the channel and the approver are all set.
DISCORD_APPROVALS_TOKEN_FILE = Path(os.environ.get(
    "HUB_DISCORD_APPROVALS_TOKEN", "/data/hub/secrets/discord-approvals-token"))
DISCORD_APPROVALS_CHANNEL = os.environ.get("HUB_APPROVALS_CHANNEL", "")
# Only this Discord user may approve. A button is visible to the channel; the
# press is still authorised per-user, and separately by the draft's HMAC.
DISCORD_APPROVER_ID = os.environ.get("HUB_APPROVER_DISCORD_ID", "")
_DISCORD_API = "https://discord.com/api/v10"


def _discord_approvals_token() -> str:
    try:
        return DISCORD_APPROVALS_TOKEN_FILE.read_text().strip()
    except OSError:
        return ""


def _discord_api(method: str, path: str, payload: dict[str, Any] | None = None,
                 token: str | None = None) -> dict[str, Any]:
    tok = _discord_approvals_token() if token is None else token
    headers = {"Content-Type": "application/json", "User-Agent": "hub-api-approvals/1.0"}
    if tok:
        headers["Authorization"] = f"Bot {tok}"
    req = urllib.request.Request(
        f"{_DISCORD_API}{path}",
        data=json.dumps(payload).encode() if payload is not None else None,
        headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=8) as r:
        body = r.read()
    return json.loads(body) if body else {}


def _approval_buttons(draft_id: int) -> list[dict[str, Any]]:
    # custom_id carries the same HMAC the approval URL uses, so a forged
    # interaction cannot approve a draft even from an allowed user.
    tok = _draft_token(draft_id)[:32]
    return [{"type": 1, "components": [
        {"type": 2, "style": 3, "label": "Approve & send",
         "custom_id": f"im:ok:{draft_id}:{tok}"},
        {"type": 2, "style": 4, "label": "Deny",
         "custom_id": f"im:no:{draft_id}:{tok}"},
    ]}]


def _notify_approvals(message: str, draft_id: int | None = None) -> None:
    """Post the draft to #approvals as the approvals bot, with Approve/Deny.
    Best-effort: no token, unreachable Discord, or a Discord error must never
    fail the compose request — the draft still exists on the Mac either way."""
    if not (_discord_approvals_token() and DISCORD_APPROVALS_CHANNEL):
        return
    try:
        payload: dict[str, Any] = {"content": message[:1900],
                                   "allowed_mentions": {"parse": []}}
        if draft_id is not None:
            payload["components"] = _approval_buttons(draft_id)
        _discord_api("POST", f"/channels/{DISCORD_APPROVALS_CHANNEL}/messages", payload)
    except Exception:
        pass


async def _form_fields(request: Request) -> dict[str, str]:
    """Parse an application/x-www-form-urlencoded body without python-multipart
    (not in the image — declaring fastapi.Form() would crash route setup)."""
    raw = (await request.body()).decode("utf-8", errors="replace")
    parsed = urllib.parse.parse_qs(raw, keep_blank_values=True)
    return {k: v[0] for k, v in parsed.items()}


# The thread-id rules the chat routes enforce (chat/platform.py) — the same
# charset/length a requesting thread must satisfy before a draft cards into it.
_IM_THREAD_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class ImessageDraftMirrorRequest(BaseModel):
    """Gateway-to-hub-api body for POST /api/imessage/drafts/mirror: record a draft
    the agent already created via the Mac's draft_imessage MCP, so the Hub shows
    it (thread card when `thread_id` is given; attention row only otherwise). The
    draft already exists — this endpoint never calls the Mac."""

    model_config = ConfigDict(extra="forbid")
    draft_id: int
    thread_id: str | None = None
    contact: str
    text: str

    @model_validator(mode="after")
    def _bounds(self) -> "ImessageDraftMirrorRequest":
        if not (1 <= self.draft_id <= 999_999_999):
            raise ValueError("draft_id out of range")
        if self.thread_id is not None:
            self.thread_id = self.thread_id.strip() or None
            if self.thread_id is not None and not _IM_THREAD_ID_RE.match(self.thread_id):
                raise ValueError(f"thread_id must match {_IM_THREAD_ID_RE.pattern}")
        if not self.contact.strip():
            raise ValueError("contact is required")
        self.contact = self.contact.strip()[:120]
        self.text = self.text.strip()
        if not self.text:
            raise ValueError("text is required")
        if len(self.text) > _IM_TEXT_MAX:
            raise ValueError(f"text over {_IM_TEXT_MAX} chars")
        return self


@app.post("/api/imessage/drafts/mirror", dependencies=[Depends(_platform_key_dep)])
async def imessage_draft_mirror(req: ImessageDraftMirrorRequest) -> dict[str, Any]:
    """Record a draft the gateway/agent created directly on the Mac. Platform-key auth
    (the gateway's own bearer, chat/platform.py), checked before the body is parsed —
    this is a gateway-to-hub-api call, not a browser one. Nothing is sent here: the
    draft already exists, and `resolve_imessage_draft` owns the one send."""
    attention_id = _mirror_draft_to_hub(req.draft_id, req.contact, req.text, req.thread_id)
    return {"ok": attention_id is not None, "attention_id": attention_id}


# Drafting makes the Mac file a message to any contact and pings the approvals channel,
# so it needs an authenticated caller and a ceiling: at most this many drafts per
# window, across all callers.
_IM_DRAFT_RATE_MAX = 10
_IM_DRAFT_RATE_WINDOW_S = 60.0
_IM_DRAFT_TIMES: deque[float] = deque()
_IM_DRAFT_RATE_LOCK = threading.Lock()


def _imessage_draft_retry_after() -> int:
    """0 when a draft may proceed now (and record it), else seconds until one may."""
    now = time.monotonic()
    with _IM_DRAFT_RATE_LOCK:
        while _IM_DRAFT_TIMES and now - _IM_DRAFT_TIMES[0] >= _IM_DRAFT_RATE_WINDOW_S:
            _IM_DRAFT_TIMES.popleft()
        if len(_IM_DRAFT_TIMES) >= _IM_DRAFT_RATE_MAX:
            return max(1, int(_IM_DRAFT_RATE_WINDOW_S - (now - _IM_DRAFT_TIMES[0])) + 1)
        _IM_DRAFT_TIMES.append(now)
        return 0


@app.post("/api/chat/imessage/draft")
async def imessage_draft(request: Request) -> Response:
    """Create a draft on the Mac from a compose form. Two callers, two credentials:

    * the briefing's server-rendered compose pages — a no-JS same-origin form, so a
      browser can only send a cookie. The route lives under /api/chat because that is
      the path the `hub_chat_session` cookie (Path=/api/chat) is sent to: the form
      works for a user who has unlocked chat with Face ID within the session's hour.
    * a server-side caller (the gateway's Hub adapter, a script) with the platform key
      as a bearer token.

    Anything else is refused before the body is read or the Mac is touched.
    Rate-limited after auth."""
    # This endpoint is the POST target of the server-rendered iMessage pages, so a
    # browser form submit (which always advertises text/html) gets the HTML result
    # page. Any other client — `Accept: application/json`, or none naming HTML — must
    # get the SAME structured error shape every other endpoint uses
    # (`{"detail": {"code", "detail"}}`), not an HTML document that breaks `res.json()`.
    as_page = "text/html" in request.headers.get("accept", "").lower()

    def _invalid(status: int, code: str, detail: str, *, title: str, icon: str,
                 heading: str, body: str, headers: dict[str, str] | None = None) -> Response:
        if as_page:
            page = _compose_page(title, icon, heading, body, status)
            page.headers.update(headers or {})
            return page
        raise HTTPException(status_code=status, detail={"code": code, "detail": detail}, headers=headers)

    authenticated = (chat_session_valid(request.cookies.get("hub_chat_session"))
                     or platform_key_valid(request.headers.get("authorization")))
    if not authenticated:
        return _invalid(401, "unauthenticated",
                        "Unlock chat in the app first, or send the platform key as a bearer token.",
                        title="Locked", icon="🔒", heading="Unlock chat first",
                        body='<p class="sub">Drafting a message needs an unlocked chat session. '
                             'Unlock chat in the app (Face ID), then come back and send again. '
                             'Nothing was drafted.</p>')
    retry_after = _imessage_draft_retry_after()
    if retry_after:
        return _invalid(429, "rate_limited",
                        f"Too many drafts; try again in {retry_after} s.",
                        title="Slow down", icon="⏳", heading="Too many drafts",
                        body=f'<p class="sub">Try again in {retry_after} seconds. Nothing was drafted.</p>',
                        headers={"Retry-After": str(retry_after)})

    form = await _form_fields(request)
    chat_id = form.get("chat_id", "").strip()
    contact = form.get("contact", "").strip()[:120]
    text = form.get("text", "").strip()
    # Optional: the chat thread the draft request came from. When given, the
    # approval card renders in THAT thread; without it (an automation's draft)
    # the needs-you row on the home page is the only Hub-side surface.
    thread_id = form.get("thread_id", "").strip() or None

    if not text:
        return _invalid(400, "empty_message", "The message text was empty.",
                        title="Empty message", icon="✏️", heading="Nothing to send",
                        body='<p class="sub">The message text was empty. Go back and type something.</p>')
    if len(text) > _IM_TEXT_MAX:
        return _invalid(400, "message_too_long",
                        f"The message is {len(text)} characters; the limit is {_IM_TEXT_MAX}.",
                        title="Too long", icon="✂️", heading="Message too long",
                        body=f'<p class="sub">{len(text)} characters — the limit is {_IM_TEXT_MAX}. '
                             'Go back and trim it.</p>')
    if not _CHAT_ID_RE.match(chat_id):
        return _invalid(400, "bad_chat_id", "The conversation id was malformed.",
                        title="Bad request", icon="⚠️", heading="Invalid conversation id",
                        body='<p class="sub">This page posted a malformed chat id. Re-open the '
                             'conversation from the briefing and try again.</p>')
    # Optional: the requesting chat thread. Absent = an automation's draft —
    # attention row only. Present, it must obey the chat routes' thread-id rules.
    if thread_id is not None and not _IM_THREAD_ID_RE.match(thread_id):
        return _invalid(400, "bad_thread_id", "The thread id was malformed.",
                        title="Bad request", icon="⚠️", heading="Invalid thread id",
                        body='<p class="sub">This page posted a malformed thread id. Re-open the '
                             'conversation and try again.</p>')
    if not contact:
        return _invalid(400, "missing_contact", "The request carried no contact name.",
                        title="Bad request", icon="⚠️", heading="Missing contact",
                        body='<p class="sub">This page posted no contact name, and the Mac needs one '
                             'to file the draft. Re-open the conversation from the briefing.</p>')

    preview = html.escape(text[:160] + ("…" if len(text) > 160 else ""))
    try:
        result = await asyncio.to_thread(_imessage_tool_call, "draft_imessage",
                                         {"to": contact, "text": text})
    except MacUnreachable:
        qname = _queue_draft(chat_id, contact, text)
        return _compose_page(
            "Queued", "🌙", "Queued — your Mac is asleep",
            f'<p class="sub">To <b>{html.escape(contact)}</b>: “{preview}”</p>'
            '<p class="sub">It was saved in the hub\'s queue folder. Send it again once '
            'the Mac is awake; drafting queued messages automatically takes a job of your own.</p>'
            f'<div class="meta">queued as {html.escape(qname)}</div>', 202)
    except ImessageMcpError as e:
        return _compose_page(
            "Draft failed", "❌", "Draft failed",
            '<p class="sub">Your Mac was reachable but refused the draft — nothing was created.</p>'
            f'<div class="meta">{html.escape(e.message[:400])}</div>', 502)

    if result.get("isError"):
        return _compose_page(
            "Draft failed", "❌", "Draft failed",
            '<p class="sub">The Mac\'s iMessage server reported an error — nothing was created.</p>'
            f'<div class="meta">{html.escape(_tool_result_text(result)[:400])}</div>', 502)

    draft_id = _extract_draft_id(result)
    if draft_id is None:
        # Drafted (no error), but the server's reply shape hid the id — be truthful.
        return _compose_page(
            "Draft created", "📝", "Draft created on your Mac",
            f'<p class="sub">To <b>{html.escape(contact)}</b>: “{preview}”</p>'
            '<p class="sub">Approve it in Messages on your Mac (or from the #approvals '
            'notice). No web approval link is available for this draft — the server did not '
            'return a draft id.</p>'
            f'<div class="meta">{html.escape(_tool_result_text(result)[:300])}</div>')

    approve_path = f"/api/imessage/approve/{draft_id}?t={_draft_token(draft_id)}"
    # Mirror into the Hub FIRST so the needs-you row and thread exist by the time
    # the Discord notice links to the web approval page.
    _mirror_draft_to_hub(draft_id, contact, text, thread_id)
    await asyncio.to_thread(
        _notify_approvals,
        f"**iMessage draft #{draft_id}** — to **{contact}**\n> {text[:400]}\n"
        f"Approve below, or open it: {HUB_PUBLIC_BASE}{approve_path}\n"
        "_Nothing sends until you press Approve. Drafts expire ~15 min._",
        draft_id)
    return _compose_page(
        "Draft created", "📝", "Draft created on your Mac",
        f'<p class="sub">To <b>{html.escape(contact)}</b>: “{preview}”</p>'
        '<p class="sub">Approve it in Messages on your Mac, or use the approval link below. '
        'Drafts expire ~15 minutes after creation.</p>'
        f'<p><a class="btn" href="{approve_path}">Review &amp; approve</a></p>'
        f'<div class="meta">draft_id {draft_id}</div>')


@app.get("/api/imessage/approve/{draft_id}")
def imessage_approve(draft_id: int, t: str = "") -> Response:
    """Side-effect-free confirm page (chat apps prefetch GET links — nothing may
    send here). Its only action is an explicit POST to the send route."""
    if not _verify_draft_token(draft_id, t):
        return _compose_page("Invalid link", "🔒", "Invalid approval link",
                             '<p class="sub">This approval link is missing or has a bad token. '
                             'Use the link from the draft confirmation page or the approvals notice.</p>', 403)
    return _compose_page(
        "Approve draft", "📨", f"Send draft #{draft_id}?",
        '<p class="sub">This sends the draft as your own iMessage identity. '
        'Nothing has been sent yet — drafts expire ~15 minutes after creation.</p>'
        f'<form method="POST" action="/api/imessage/send/{draft_id}">'
        f'<input type="hidden" name="t" value="{html.escape(t)}">'
        '<button class="btn" type="submit">Send message</button>'
        '</form>')


async def _approval_press(inter: dict[str, Any]) -> None:
    """One Approve/Deny press. Ack within Discord's 3s window, do the slow Mac
    call after, then rewrite the message with the outcome and NO buttons — a
    draft can never be sent twice, and the card always states what really
    happened rather than what was requested."""
    cid = ((inter.get("data") or {}).get("custom_id") or "")
    if not cid.startswith("im:"):
        return
    try:
        _, action, raw_id, tok = cid.split(":", 3)
        draft_id = int(raw_id)
    except ValueError:
        return

    presser = (((inter.get("member") or {}).get("user") or {}) or inter.get("user") or {})
    who = str(presser.get("id") or "")
    app_id, itoken = inter.get("application_id"), inter.get("token")

    async def ack(kind: int) -> None:
        await asyncio.to_thread(_discord_api, "POST",
                                f"/interactions/{inter['id']}/{itoken}/callback",
                                {"type": kind}, "")

    async def finish(text: str) -> None:
        await asyncio.to_thread(
            _discord_api, "PATCH", f"/webhooks/{app_id}/{itoken}/messages/@original",
            {"content": text[:1900], "components": [],
             "allowed_mentions": {"parse": []}})

    if who != DISCORD_APPROVER_ID:
        # someone else's press: tell only them, leave the card untouched
        await asyncio.to_thread(
            _discord_api, "POST", f"/interactions/{inter['id']}/{itoken}/callback",
            {"type": 4, "data": {"content": "Not your approval to give.", "flags": 64}}, "")
        return
    if not hmac.compare_digest(_draft_token(draft_id)[:32], tok):
        await ack(6)
        await finish(f"🔒 Draft #{draft_id} — approval token invalid. Nothing was sent.")
        return

    await ack(6)   # DEFERRED_UPDATE_MESSAGE: buttons stop spinning, we keep working

    if action == "no":
        res = await asyncio.to_thread(chat_imessage_draft.resolve_imessage_draft, draft_id, "deny")
        if res is not None and res["status"] == "already_answered":
            await finish(_imessage_already_answered_text(draft_id, res))
            return
        await finish(f"🚫 Draft #{draft_id} denied — not sent. It expires on the Mac by itself.")
        return

    res = await asyncio.to_thread(chat_imessage_draft.resolve_imessage_draft, draft_id, "approve")
    if res is None:
        # A draft this Hub never mirrored (written before the shared record
        # existed) — send it directly, once, the legacy way.
        try:
            result = await asyncio.to_thread(_imessage_tool_call, "send_draft", {"draft_id": draft_id})
        except MacUnreachable:
            await finish(f"🌙 Draft #{draft_id} — Mac unreachable. **Not sent.** "
                         "Drafts expire ~15 min after creation.")
            return
        except ImessageMcpError as e:
            await finish(f"❌ Draft #{draft_id} — the Mac refused the send. **Not sent.**\n`{e.message[:250]}`")
            return
        text_out = _tool_result_text(result)
        sc = result.get("structuredContent") if isinstance(result.get("structuredContent"), dict) else {}
        blob = f"{str(sc.get('status', '')).lower()} {text_out}".lower()
        if result.get("isError"):
            await finish(f"❌ Draft #{draft_id} — send failed. **Not sent.**\n`{text_out[:250]}`")
        elif "pending" in blob or "not yet approved" in blob or "awaiting" in blob:
            await finish(f"⏳ Draft #{draft_id} — the Mac is still holding it for approval there. "
                         f"**Not sent yet.**\n`{text_out[:200]}`")
        elif str(sc.get("status", "")).lower() == "sent" or re.search(r"\bsent\b", blob):
            await finish(f"✅ Draft #{draft_id} sent.")
        else:
            # never claim a send the Mac did not confirm
            await finish(f"ℹ️ Draft #{draft_id} — unrecognised reply from the Mac; treat as "
                         f"**NOT confirmed sent.**\n`{(text_out or json.dumps(sc))[:250]}`")
        return

    if res["status"] == "already_answered":
        await finish(_imessage_already_answered_text(draft_id, res))
        return
    await finish(_imessage_outcome_text(draft_id, res))


def _imessage_already_answered_text(draft_id: int, res: dict[str, Any]) -> str:
    """The card's own words when another surface (or an earlier tap) answered
    first — states what was recorded, never a second send."""
    decision = res.get("decision") or "answered"
    outcome = res.get("outcome")
    tail = f" Its outcome: **{outcome}**." if outcome else ""
    return (f"ℹ️ Draft #{draft_id} was already answered ({decision}) on another surface. "
            f"Nothing was sent again.{tail}")


def _imessage_outcome_text(draft_id: int, res: dict[str, Any]) -> str:
    """Map the normalized Mac outcome (chat/imessage_draft.py) to the card's line."""
    outcome = res.get("outcome")
    detail = str(res.get("detail") or "")[:200]
    if outcome == "sent":
        return f"✅ Draft #{draft_id} sent."
    if outcome == "pending":
        return (f"⏳ Draft #{draft_id} — the Mac is still holding it for approval there. "
                f"**Not sent yet.**\n`{detail}`")
    if outcome == "unreachable":
        return (f"🌙 Draft #{draft_id} — Mac unreachable. **Not sent.** "
                "Drafts expire ~15 min after creation.")
    if outcome == "error":
        return f"❌ Draft #{draft_id} — the Mac refused the send. **Not sent.**\n`{detail}`"
    return (f"ℹ️ Draft #{draft_id} — unrecognised reply from the Mac; treat as "
            f"**NOT confirmed sent.**\n`{detail}`")


async def _approvals_gateway() -> None:
    """Hold the approvals bot's gateway socket so button presses arrive without
    any inbound exposure. intents=0 — INTERACTION_CREATE is delivered regardless,
    and we deliberately cannot read messages."""
    backoff = 5
    while True:
        token = _discord_approvals_token()
        if not token:
            await asyncio.sleep(60)      # dormant until the secret is dropped in
            continue
        try:
            async with websockets.connect(
                    "wss://gateway.discord.gg/?v=10&encoding=json",
                    max_size=2 ** 22, ping_interval=None) as ws:
                hello = json.loads(await ws.recv())
                interval = hello["d"]["heartbeat_interval"] / 1000
                seq: int | None = None

                async def beat() -> None:
                    while True:
                        await asyncio.sleep(interval)
                        await ws.send(json.dumps({"op": 1, "d": seq}))

                await ws.send(json.dumps({"op": 2, "d": {
                    "token": token, "intents": 0,
                    "properties": {"os": "linux", "browser": "hub-api", "device": "hub-api"}}}))
                hb = asyncio.create_task(beat())
                backoff = 5
                try:
                    async for raw in ws:
                        msg = json.loads(raw)
                        if msg.get("s") is not None:
                            seq = msg["s"]
                        if msg.get("op") == 0 and msg.get("t") == "INTERACTION_CREATE":
                            asyncio.create_task(_approval_press(msg["d"]))
                        elif msg.get("op") in (7, 9):
                            break        # reconnect / invalid session
                finally:
                    hb.cancel()
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 300)


@app.on_event("startup")
async def _start_approvals_gateway() -> None:
    asyncio.create_task(_approvals_gateway())


@app.on_event("startup")
async def _start_local_pair_socket() -> None:
    """Serve the local (non-web) enrol-code mint socket. AF_UNIX only, so it is
    never reachable over the network; the code it mints is the same
    devicekeys.mint_enroll_code() the WebAuthn action uses. A bind failure
    disables local minting and is logged — it never blocks API startup."""
    await asyncio.to_thread(pair_local.start_local_pair_server)


@app.post("/api/imessage/send/{draft_id}")
async def imessage_send(draft_id: int, request: Request) -> Response:
    form = await _form_fields(request)
    token = form.get("t", "")
    if not _verify_draft_token(draft_id, token):
        return _compose_page("Invalid token", "🔒", "Send refused",
                             '<p class="sub">The approval token was missing or invalid — nothing was sent.</p>', 403)
    # The shared first-answer-wins record, when the Hub mirrored this draft: a
    # second surface (or a second tap) never reaches a second send. `retry_unsent`
    # re-attempts only a send that never reached the Mac — that is not a second
    # ANSWER, and it is the "try the link again" this page has always offered.
    resolved = await asyncio.to_thread(
        chat_imessage_draft.resolve_imessage_draft, draft_id, "approve", retry_unsent=True
    )
    if resolved is not None:
        return _imessage_send_page(draft_id, resolved, token)
    # Legacy: a draft written before the Hub mirrored drafts has no shared record,
    # so it is sent directly, once.
    try:
        result = await asyncio.to_thread(_imessage_tool_call, "send_draft", {"draft_id": draft_id})
    except MacUnreachable:
        return _compose_page(
            "Mac unreachable", "🌙", "Not sent — Mac unreachable",
            '<p class="sub">Your Mac went unreachable before the send could happen. The message was '
            '<b>not</b> sent. Try the approval link again when the Mac is awake '
            '(drafts expire ~15 minutes after creation).</p>', 502)
    except ImessageMcpError as e:
        return _compose_page(
            "Send failed", "❌", "Not sent",
            '<p class="sub">The Mac refused the send — the message was <b>not</b> sent.</p>'
            f'<div class="meta">{html.escape(e.message[:400])}</div>', 502)

    text_out = _tool_result_text(result)
    sc = result.get("structuredContent") if isinstance(result.get("structuredContent"), dict) else {}
    status_field = str(sc.get("status", "")).lower()
    blob = f"{status_field} {text_out}".lower()
    if result.get("isError"):
        return _compose_page(
            "Send failed", "❌", "Not sent",
            '<p class="sub">The Mac\'s iMessage server reported an error — the message was '
            '<b>not</b> sent.</p>'
            f'<div class="meta">{html.escape(text_out[:400])}</div>', 502)
    if "pending" in blob or "not yet approved" in blob or "awaiting" in blob:
        return _compose_page(
            "Pending approval", "⏳", "Not sent yet — approval pending",
            '<p class="sub">The Mac is holding this draft until you approve it there (the #approvals '
            'button or ❤️-tapback on the Messages notice). Approve it, then tap send again.</p>'
            f'<form method="POST" action="/api/imessage/send/{draft_id}">'
            f'<input type="hidden" name="t" value="{html.escape(token)}">'
            '<button class="btn" type="submit">Retry send</button>'
            '</form>'
            f'<div class="meta">{html.escape(text_out[:300])}</div>')
    if status_field == "sent" or re.search(r"\bsent\b", blob):
        return _compose_page(
            "Sent", "✅", "Message sent",
            f'<p class="sub">Draft #{draft_id} was sent from your own iMessage identity.</p>'
            f'<div class="meta">{html.escape(text_out[:300])}</div>')
    # Unrecognized result shape: show it verbatim, claim nothing.
    return _compose_page(
        "Result", "ℹ️", "Send result unclear",
        '<p class="sub">The Mac returned a result this page does not recognize — '
        'treat it as NOT confirmed sent. Its exact reply:</p>'
        f'<div class="meta">{html.escape(text_out[:500] or json.dumps(sc)[:500])}</div>')


def _imessage_send_page(draft_id: int, res: dict[str, Any], token: str) -> Response:
    """The no-JS result page for one send attempt, read off the shared record's
    status/outcome. States only what was recorded — never a claimed send."""
    outcome = res.get("outcome")
    detail = html.escape(str(res.get("detail") or "")[:400])
    if res["status"] == "already_answered":
        if res.get("decision") == "deny":
            return _compose_page(
                "Denied", "🚫", "Already denied",
                '<p class="sub">This draft was already denied elsewhere — the message was '
                '<b>not</b> sent.</p>')
        return _compose_page(
            "Already answered", "ℹ️", "Already answered elsewhere",
            '<p class="sub">This draft was already approved from another surface, so it was '
            '<b>not</b> sent again.</p>'
            f'<div class="meta">last outcome: {html.escape(str(outcome or "unknown"))}</div>')
    if res["status"] == "denied":
        return _compose_page(
            "Denied", "🚫", "Not sent — draft denied",
            '<p class="sub">This draft was denied, so nothing was sent. It expires on the Mac '
            'by itself.</p>')
    # status == "approved": the Mac call just ran
    if outcome == "sent":
        return _compose_page(
            "Sent", "✅", "Message sent",
            f'<p class="sub">Draft #{draft_id} was sent from your own iMessage identity.</p>'
            + (f'<div class="meta">{detail}</div>' if detail else ""))
    if outcome == "pending":
        return _compose_page(
            "Pending approval", "⏳", "Not sent yet — approval pending",
            '<p class="sub">The Mac is holding this draft until you approve it there (the #approvals '
            'button or ❤️-tapback on the Messages notice). Approve it, then tap send again.</p>'
            f'<form method="POST" action="/api/imessage/send/{draft_id}">'
            f'<input type="hidden" name="t" value="{html.escape(token)}">'
            '<button class="btn" type="submit">Retry send</button>'
            '</form>'
            + (f'<div class="meta">{detail}</div>' if detail else ""))
    if outcome == "unreachable":
        return _compose_page(
            "Mac unreachable", "🌙", "Not sent — Mac unreachable",
            '<p class="sub">Your Mac went unreachable before the send could happen. The message was '
            '<b>not</b> sent. Try the approval link again when the Mac is awake '
            '(drafts expire ~15 minutes after creation).</p>', 502)
    if outcome == "error":
        return _compose_page(
            "Send failed", "❌", "Not sent",
            '<p class="sub">The Mac refused the send — the message was <b>not</b> sent.</p>'
            + (f'<div class="meta">{detail}</div>' if detail else ""), 502)
    # unconfirmed / anything else: show it verbatim, claim nothing.
    return _compose_page(
        "Result", "ℹ️", "Send result unclear",
        '<p class="sub">The Mac returned a result this page does not recognize — '
        'treat it as NOT confirmed sent. Its exact reply:</p>'
        f'<div class="meta">{detail}</div>')


# --- Telegram topic routing (config-driven delivery) --------------------------
# Canonical config: /data/hub/config/telegram-topics.json. The Hub edits it through
# the SAME gate the action writes use — a challenge bound to the sha256 of the exact
# payload (purpose "topics"), then a verified assertion — and the write only marks
# pending_sync. Applying the routes to the scheduler's jobs is left to an applier you
# run beside the gateway (this repo does not ship one); hub-api never touches the
# scheduler's job store.
TOPICS_CONFIG_FILE = Path(os.environ.get("HUB_TOPICS_CONFIG", "/data/hub/config/telegram-topics.json"))
# Live deliver snapshot ({"jobs": {name: deliver}, "approvals_topic": {...}, "ts": ...})
# written by that applier — hub-api cannot read the scheduler itself, so this file is
# its only honest view of live deliver values (drives the drift display).
TOPICS_LIVE_FILE = Path(os.environ.get("HUB_TOPICS_LIVE", "/data/hub/config/telegram-topics.live.json"))
_TOPIC_KEY_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
# Routes that are not scheduler jobs: a healthcheck reads the config file directly at
# send time, and the approvals route names where draft notices go.
TOPICS_PSEUDO_ROUTES = {"healthcheck", "imessage-approvals"}


class TopicsConfig(BaseModel):
    chat_id: str
    topics: dict[str, int]
    routes: dict[str, str]


class TopicsChallengeRequest(BaseModel):
    config: TopicsConfig


class TopicsApplyRequest(GatedRequest):
    config: TopicsConfig


def _topics_live() -> dict[str, Any] | None:
    try:
        data = json.loads(TOPICS_LIVE_FILE.read_text())
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def _validate_topics_config(cfg: TopicsConfig) -> None:
    """Shape-validate BEFORE a challenge is issued or a write lands (honest 400s,
    same posture as build_write_argv): numeric chat/thread ids, sane topic keys,
    and every route targeting a known topic key or local/dm. Route names are
    checked against the live job snapshot when one exists (pseudo-routes exempt)."""
    def bad(msg: str) -> HTTPException:
        return HTTPException(status_code=400, detail={"code": "bad_request", "detail": msg})

    if not _CHAT_ID_RE.match(cfg.chat_id):
        raise bad("chat_id must be numeric")
    if not cfg.topics:
        raise bad("at least one topic is required")
    for key, thread in cfg.topics.items():
        if not _TOPIC_KEY_RE.match(key):
            raise bad(f"invalid topic key {key!r}")
        if not (0 < thread < 2**31):
            raise bad(f"topic {key!r}: thread id must be a positive integer")
    allowed = set(cfg.topics) | {"local", "dm"}
    live = _topics_live()
    live_jobs = live.get("jobs") if live and isinstance(live.get("jobs"), dict) else None
    for name, target in cfg.routes.items():
        if not name or len(name) > 120:
            raise bad("route names must be 1-120 chars")
        if target not in allowed:
            raise bad(f"route {name!r}: unknown target {target!r} (topic key, 'local' or 'dm')")
        if live_jobs is not None and name not in live_jobs and name not in TOPICS_PSEUDO_ROUTES:
            raise bad(f"route {name!r} matches no known cron job")


def _topics_expected_deliver(cfg: dict[str, Any], target: str) -> str:
    if target == "local":
        return "local"
    if target == "dm":
        return f"telegram:{cfg.get('chat_id')}"
    return f"telegram:{cfg.get('chat_id')}:{(cfg.get('topics') or {}).get(target)}"


def _canonical_topics_hash(cfg: TopicsConfig) -> str:
    """Same challenge-binding scheme as _canonical_write_hash: sha256 over the
    canonical JSON, so an assertion for one config can't apply another."""
    payload = json.dumps(cfg.model_dump(), separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()


@app.get("/api/config/topics")
def topics_get() -> dict[str, Any]:
    """The canonical routing config + per-route drift against the live snapshot.
    live_deliver/drift are null when the snapshot hasn't covered a route yet —
    honest unknown, never fake-green."""
    try:
        cfg = json.loads(TOPICS_CONFIG_FILE.read_text())
    except OSError:
        raise HTTPException(status_code=503, detail="telegram-topics config not yet written")
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail=f"telegram-topics config unparseable: {exc}")
    live = _topics_live()
    live_jobs = live.get("jobs") if live and isinstance(live.get("jobs"), dict) else None
    rows: list[dict[str, Any]] = []
    for name, target in (cfg.get("routes") or {}).items():
        expected = _topics_expected_deliver(cfg, target)
        row: dict[str, Any] = {
            "name": name,
            "target": target,
            "expected_deliver": expected,
            "pseudo": name in TOPICS_PSEUDO_ROUTES,
            "live_deliver": None,
            "drift": None,
        }
        if name == "imessage-approvals":
            ap = (live or {}).get("approvals_topic")
            if isinstance(ap, dict) and ap.get("chat_id"):
                thread = ap.get("message_thread_id")
                row["live_deliver"] = f"telegram:{ap.get('chat_id')}" + (f":{thread}" if thread else "")
                row["drift"] = row["live_deliver"] != expected
        elif name == "healthcheck":
            # the healthcheck reads THIS config file at send time — no separate live state.
            row["live_deliver"] = expected
            row["drift"] = False
        elif live_jobs is not None and name in live_jobs:
            ld = live_jobs[name]
            row["live_deliver"] = ld
            # A bare "telegram" deliver is the default chat = DM; don't flag it as drift.
            row["drift"] = not (ld == expected or (target == "dm" and ld == "telegram"))
        rows.append(row)
    return {
        "config": cfg,
        "routes": rows,
        "pending_sync": bool(cfg.get("pending_sync")),
        "live_snapshot_at": (live or {}).get("ts"),
    }


@app.post("/api/config/topics/challenge")
def topics_challenge(req: TopicsChallengeRequest) -> dict[str, Any]:
    """Hash+cache the proposed config and return an assertion challenge bound to it
    (mirrors /api/action/challenge exactly)."""
    _validate_topics_config(req.config)
    try:
        return wa.assertion_options_any("topics", _canonical_topics_hash(req.config))
    except wa.NoPasskeyError:
        raise HTTPException(
            status_code=412,
            detail={"code": "no_passkey", "detail": "No passkey registered. Enrol in Settings first."},
        )


@app.post("/api/config/topics")
def topics_apply(req: TopicsApplyRequest) -> dict[str, Any]:
    """Verify the assertion (bound to THIS exact config), then atomically write the
    config file with pending_sync=true for the host applier. Mirrors /api/action/apply."""
    _require_enrolled(req.devicekey_assertion)
    _validate_topics_config(req.config)  # re-derive/validate; 400s on tamper
    _verify_proof(req, "topics", _canonical_topics_hash(req.config))
    out = req.config.model_dump()
    out["pending_sync"] = True
    out["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    TOPICS_CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = TOPICS_CONFIG_FILE.with_name(TOPICS_CONFIG_FILE.name + ".tmp")
    tmp.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    tmp.replace(TOPICS_CONFIG_FILE)
    return {"status": "saved", "pending_sync": True, "applied_at": out["updated_at"]}


# --- Decision Inbox ----------------------------------------------------------
# Filesystem-as-API: /data/hub/decisions/, one JSON file per decision. Agents write
# cards; the user answers them in the app through the SAME gate as topics (challenge
# bound to the sha256 of {id, option_key, note}, purpose "decisions", then a verified
# passkey or device-key assertion). Every answer ALSO appends to
# decisions/responses.jsonl — an append-only ledger, nothing deleted. Reserved
# option_key "dismiss" marks the card dismissed. A card carrying an integer
# `draft_id` is an iMessage draft awaiting approval: its answer also resolves the
# draft (see decision_answer).
DECISIONS_DIR = Path(os.environ.get("HUB_DECISIONS_DIR", "/data/hub/decisions"))
DECISIONS_LEDGER = DECISIONS_DIR / "responses.jsonl"
_DECISION_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_DECISION_ANSWERED_KEEP_DAYS = 14


class DecisionAnswerBody(BaseModel):
    option_key: str | None = None
    note: str | None = None


class DecisionApplyRequest(DecisionAnswerBody, GatedRequest):
    pass


def _decision_read(decision_id: str) -> dict[str, Any]:
    if not _DECISION_ID_RE.match(decision_id):
        raise HTTPException(status_code=400, detail={"code": "bad_request", "detail": "invalid decision id"})
    path = DECISIONS_DIR / f"{decision_id}.json"
    try:
        data = json.loads(path.read_text())
    except OSError:
        raise HTTPException(status_code=404, detail={"code": "not_found", "detail": f"no decision {decision_id!r}"})
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail=f"decision {decision_id!r} unparseable: {exc}")
    if not isinstance(data, dict):
        raise HTTPException(status_code=500, detail=f"decision {decision_id!r} is not an object")
    return data


def _decision_draft_id(decision: dict[str, Any]) -> int | None:
    """The iMessage draft a decision card stands for, or None for an ordinary card."""
    draft_id = decision.get("draft_id")
    return draft_id if isinstance(draft_id, int) and not isinstance(draft_id, bool) else None


def _validate_decision_answer(decision: dict[str, Any], body: DecisionAnswerBody) -> None:
    """Shape-validate BEFORE a challenge is issued or a write lands (same posture
    as _validate_topics_config): the card must be open, and the answer must be a
    valid option key, the reserved 'dismiss', or note-only. A draft card needs an
    option: a note alone neither approves nor discards it."""
    def bad(msg: str) -> HTTPException:
        return HTTPException(status_code=400, detail={"code": "bad_request", "detail": msg})

    if decision.get("status") != "open":
        raise bad(f"decision is {decision.get('status')!r}, not open")
    note = (body.note or "").strip()
    if len(note) > 2000:
        raise bad("note too long (2000 chars max)")
    if body.option_key is None and _decision_draft_id(decision) is not None:
        raise bad("an option_key is required for a draft")
    if body.option_key is None:
        if not note:
            raise bad("an option_key or a non-empty note is required")
        return
    if body.option_key == "dismiss":
        return
    keys = {o.get("key") for o in decision.get("options") or [] if isinstance(o, dict)}
    if body.option_key not in keys:
        raise bad(f"unknown option_key {body.option_key!r}")


def _decision_answer_hash(decision_id: str, body: DecisionAnswerBody) -> str:
    """Same challenge-binding scheme as _canonical_topics_hash: the assertion for
    one answer can't apply a different one."""
    payload = json.dumps(
        {"id": decision_id, "note": (body.note or "").strip() or None, "option_key": body.option_key},
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()


@app.get("/api/decisions")
def decisions_list() -> dict[str, Any]:
    """Open cards (oldest first — the queue) + recently answered/dismissed
    (newest first, last 14 days). Unparseable files are surfaced as errors,
    never silently dropped."""
    open_cards: list[dict[str, Any]] = []
    done_cards: list[dict[str, Any]] = []
    errors: list[str] = []
    try:
        paths = sorted(DECISIONS_DIR.glob("*.json"))
    except OSError:
        paths = []
    cutoff = time.time() - _DECISION_ANSWERED_KEEP_DAYS * 86400
    for path in paths:
        try:
            card = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            errors.append(path.name)
            continue
        if not isinstance(card, dict) or not card.get("id"):
            errors.append(path.name)
            continue
        status = card.get("status")
        if status == "open":
            open_cards.append(card)
        elif status in ("answered", "dismissed"):
            ts = (card.get("answer") or {}).get("ts")
            try:
                answered_at = datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
            except (ValueError, TypeError):
                answered_at = 0.0
            if answered_at >= cutoff:
                done_cards.append(card)
    open_cards.sort(key=lambda c: str(c.get("created") or ""))
    done_cards.sort(key=lambda c: str((c.get("answer") or {}).get("ts") or ""), reverse=True)
    return {
        "open": open_cards,
        "answered": done_cards,
        "errors": errors,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


@app.post("/api/decisions/{decision_id}/challenge")
def decision_challenge(decision_id: str, body: DecisionAnswerBody) -> dict[str, Any]:
    """Validate + hash the proposed answer and return an assertion challenge bound to
    it — a passkey challenge when one is enrolled, else one the paired device key signs
    (the native app's only credential). 412 only when nothing is enrolled."""
    decision = _decision_read(decision_id)
    _validate_decision_answer(decision, body)
    try:
        return wa.assertion_options_any("decisions", _decision_answer_hash(decision_id, body))
    except wa.NoPasskeyError:
        raise HTTPException(
            status_code=412,
            detail={"code": "no_passkey", "detail": "No passkey registered. Enrol in Settings first."},
        )


@app.post("/api/decisions/{decision_id}/answer")
def decision_answer(decision_id: str, req: DecisionApplyRequest) -> dict[str, Any]:
    """Verify the assertion (bound to THIS exact answer), then atomically rewrite
    the decision file and append to the responses.jsonl ledger.

    A draft card (an integer `draft_id`) is also resolved through the draft's own
    first-answer-wins record, `chat_imessage_draft.resolve_imessage_draft` — `once`
    sends, `deny`/`dismiss` discard — and only AFTER the proof verifies, so nothing
    reaches the Mac on an unproven answer. If another surface answered the draft
    first, nothing is sent again and the response says so."""
    _require_enrolled(req.devicekey_assertion)
    decision = _decision_read(decision_id)
    body = DecisionAnswerBody(option_key=req.option_key, note=req.note)
    _validate_decision_answer(decision, body)  # re-derive/validate; 400s on tamper
    _verify_proof(req, "decisions", _decision_answer_hash(decision_id, body))
    draft_id = _decision_draft_id(decision)
    resolved: dict[str, Any] | None = None
    if draft_id is not None:
        choice = "approve" if body.option_key == "once" else "deny"
        resolved = chat_imessage_draft.resolve_imessage_draft(draft_id, choice)
        if resolved is None:
            raise HTTPException(status_code=404, detail={"code": "not_found", "detail": f"draft {draft_id} is not on record"})
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    note = (body.note or "").strip() or None
    decision["status"] = "dismissed" if body.option_key == "dismiss" else "answered"
    decision["answer"] = {"option_key": body.option_key, "note": note, "ts": ts}
    path = DECISIONS_DIR / f"{decision_id}.json"
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(decision, indent=2, ensure_ascii=False) + "\n")
    tmp.replace(path)
    ledger_line = json.dumps(
        {
            "id": decision_id,
            "title": decision.get("title"),
            "source": decision.get("source"),
            "status": decision["status"],
            "option_key": body.option_key,
            "note": note,
            "ts": ts,
        },
        ensure_ascii=False,
    )
    with DECISIONS_LEDGER.open("a") as fh:
        fh.write(ledger_line + "\n")
    out: dict[str, Any] = {"status": decision["status"], "answered_at": ts}
    if resolved is not None:
        out["draft"] = {"draft_id": draft_id, "status": resolved.get("status"), "outcome": resolved.get("outcome")}
    return out


def _draft_decision_id(draft_id: int) -> str:
    return f"imessage-draft-{draft_id}"


def _write_draft_decision(draft_id: int, contact: str, text: str) -> str | None:
    """An automation's draft (no chat thread) surfaces on the app's HOME page as
    a Decision-Inbox card — the banner already pins open decisions above the
    fold — instead of as a chat thread. The card carries `draft_id`; it is
    answered through the gated `/api/decisions/{id}/answer` like every other
    card, which applies the SAME first-answer-wins approval CAS the thread card
    answers through. Idempotent: an existing card is left untouched so a retry
    never reopens a decided one."""
    did = _draft_decision_id(draft_id)
    path = DECISIONS_DIR / f"{did}.json"
    if path.exists():
        return did
    try:
        DECISIONS_DIR.mkdir(parents=True, exist_ok=True)
        card = {
            "id": did,
            "title": "Approve iMessage draft",
            "summary": f"To {contact}: {text[:280]}" if text else f"To {contact}",
            "source": "imessage",
            "category": "required",
            "domain": "ops",
            "blocking": "Blocks: nothing sends until you answer. The draft expires ~15 min after creation.",
            "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "expires": _imessage_draft_expiry_iso(),
            "status": "open",
            "options": [
                {"key": "once", "label": "Approve & send", "detail": f"Sends the iMessage to {contact}"},
                {"key": "deny", "label": "Discard", "detail": "Drops the draft without sending"},
                {"key": "dismiss", "label": "Dismiss", "detail": "Also discards the draft"},
            ],
            "draft_id": draft_id,
        }
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(card, indent=1, ensure_ascii=False) + "\n")
        tmp.replace(path)
        return did
    except OSError:
        import sys, traceback as _tb
        print("DECISION-WRITE-FAIL:", file=sys.stderr); _tb.print_exc()
        return None


# --- Feed (Home timeline) ----------------------------------------------------
# Merges three sources newest-first: published briefs (my-pages), cron run
# outputs (bridge /cron-logs) and agent-dropped inbox cards (INBOX_DIR *.json).
# Each source degrades on its own — a dead bridge still leaves briefs + cards.
# 30s cache: Home polls, and the cron read is a docker exec away.

_RUN_TIME_FMT = "%Y-%m-%d %H:%M:%S"  # run files' "**Run Time:**" header (gateway-local)
_INBOX_KINDS = {"report", "alert", "status"}
_FEED_TTL_S = 30.0
_FEED_CACHE: tuple[float, dict[str, Any]] | None = None
_FEED_LOCK = threading.Lock()


def _feed_briefs() -> list[dict[str, Any]]:
    return [
        {
            "id": f"brief-{p['slug']}",
            "ts": p["mtime"],
            "kind": "brief",
            "title": p["title"],
            "link": f"/my-pages/{p['slug']}/",
            "page_slug": p["slug"],
        }
        for p in _scan_my_pages()
        if p["kind"] == "brief"
    ]


def _feed_runs() -> list[dict[str, Any]]:
    try:
        runs = _bridge_cron_logs(40).get("runs") or []
    except BridgeError:
        return []
    items: list[dict[str, Any]] = []
    for r in runs:
        try:
            ts = int(datetime.strptime(r.get("run_time") or "", _RUN_TIME_FMT).replace(tzinfo=HUB_TZ).timestamp())
        except ValueError:
            continue  # headerless/odd run file — no honest timestamp, no item
        items.append({
            "id": f"run-{r.get('job_id')}-{r.get('run_time')}",
            "ts": ts,
            "kind": "run",
            "title": r.get("name") or r.get("job_id"),
            "status": r.get("status"),
            "summary": (r.get("output") or "")[:2000],
        })
    return items


def _feed_inbox() -> list[dict[str, Any]]:
    """Cards any agent can drop as INBOX_DIR/*.json (status.json is the status
    line, not a card). Malformed files are skipped silently — the inbox is a
    convenience surface, not a contract worth 500ing the feed over."""
    items: list[dict[str, Any]] = []
    if not INBOX_DIR.is_dir():
        return items
    for f in INBOX_DIR.glob("*.json"):
        if f.name == "status.json":
            continue
        try:
            card = json.loads(f.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(card, dict) or not isinstance(card.get("ts"), (int, float)):
            continue
        if card.get("kind") not in _INBOX_KINDS or not card.get("title"):
            continue
        item = {
            "id": card.get("id") or f.name,
            "ts": int(card["ts"]),
            "kind": card["kind"],
            "title": card["title"],
        }
        for opt in ("summary", "link", "page_slug", "priority"):
            if card.get(opt) is not None:
                item[opt] = card[opt]
        items.append(item)
    return items


def _feed_status_line() -> dict[str, Any] | None:
    try:
        status = json.loads((INBOX_DIR / "status.json").read_text())
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(status, dict) or not isinstance(status.get("ts"), (int, float)):
        return None
    ttl = status.get("ttl_s")
    if not isinstance(ttl, (int, float)):
        ttl = 86400
    if status["ts"] + ttl <= time.time():
        return None  # expired — a stale status line is worse than none
    return status


@app.get("/api/feed")
def feed() -> dict[str, Any]:
    """Home feed: briefs + cron runs + inbox cards merged newest-first (cap 100),
    plus the agent's status line while it is still within its TTL."""
    global _FEED_CACHE
    with _FEED_LOCK:
        if _FEED_CACHE and _FEED_CACHE[0] > time.time():
            return _FEED_CACHE[1]
    items = _feed_briefs() + _feed_runs() + _feed_inbox()
    items.sort(key=lambda i: i["ts"], reverse=True)
    payload = {
        "items": items[:100],
        "status_line": _feed_status_line(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    with _FEED_LOCK:
        _FEED_CACHE = (time.time() + _FEED_TTL_S, payload)
    return payload


# ---------------------------------------------------------------------------
# Config read surface (Slice 2a) — CLI-bridge backed.
#
# `hermes config show` is hermes-CLI-only (no HTTP source), so this reads it
# through the privileged hub-bridge sidecar via _bridge_run and parses the
# fixed-width table into structured groups the Config tab renders as iOS rows.
# READ-ONLY this slice: every row carries a `writable` flag the PWA uses to
# show a Face-ID lock glyph (Slice 2b wires `hermes config set` behind WebAuthn).
# ---------------------------------------------------------------------------

# Each `◆ Section` in `config show` maps onto one display group. Sections we
# don't recognise fall through to "other" so real config is never silently
# dropped; group order below is the render order.
_CONFIG_GROUP_ORDER = ["model", "chat", "compression", "channels", "security", "paths", "other"]
_CONFIG_GROUP_LABELS = {
    "model": "Model & Routing",
    "chat": "Chat Behaviour",
    "compression": "Context Compression",
    "channels": "Messaging Platforms",
    "security": "API Keys",
    "paths": "Paths",
    "other": "Other",
}
_CONFIG_SECTION_GROUP = {
    "Model": "model",
    "Auxiliary Models (overrides)": "model",
    "Display": "chat",
    "Terminal": "chat",
    "Timezone": "chat",
    "Context Compression": "compression",
    "Messaging Platforms": "channels",
    "API Keys": "security",
    "Paths": "paths",
}


def _config_row(section: str, stripped: str) -> tuple[str, str] | None:
    """Split one indented `config show` line into (key, value). Handles the
    three shapes the table uses: `Key:   value` (colon), `Label   (not set)` /
    `Label   masked` (padded columns), and `Name   provider=..., model=...`
    (auxiliary overrides). Returns None for lines that carry no value."""
    stripped = stripped.strip()
    if not stripped:
        return None
    m = re.match(r"^([^:]+?):\s+(.+)$", stripped)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    if stripped.endswith("(not set)"):
        return stripped[: -len("(not set)")].strip(), "(not set)"
    idx = stripped.find("provider=")
    if idx > 0:
        return stripped[:idx].strip(), stripped[idx:].strip()
    parts = re.split(r"\s{2,}", stripped, maxsplit=1)
    if len(parts) == 2:
        return parts[0].strip(), parts[1].strip()
    return None


def _expand_model_row(key: str, value: str) -> list[tuple[str, str]]:
    """The `Model:` value is a Python dict repr; expand it into readable rows
    (Default / Provider / Base URL) instead of dumping the raw literal."""
    if key == "Model" and value.startswith("{"):
        try:
            data = ast.literal_eval(value)
        except (ValueError, SyntaxError):
            data = None
        if isinstance(data, dict):
            rows: list[tuple[str, str]] = []
            if data.get("default"):
                rows.append(("Default model", str(data["default"])))
            if data.get("provider"):
                rows.append(("Provider", str(data["provider"])))
            if data.get("base_url"):
                rows.append(("Base URL", str(data["base_url"])))
            if rows:
                return rows
    return [(key, value)]


def _parse_config_show(text: str) -> list[dict[str, Any]]:
    """Parse `hermes config show` output into ordered display groups. Sections
    are `◆ Name` headers; rows are the indented lines under them. The trailing
    hint block (after the horizontal rule) is skipped."""
    buckets: dict[str, list[dict[str, Any]]] = {}
    section: str | None = None
    for raw in text.splitlines():
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped:
            continue
        # A rule of box-drawing chars ends the sections region (footer follows).
        if set(stripped) <= {"─", "—", "-"} and len(stripped) >= 8:
            section = None
            continue
        if stripped.startswith("◆"):
            section = stripped.lstrip("◆").strip()
            continue
        if section is None:
            continue
        parsed = _config_row(section, stripped)
        if parsed is None:
            continue
        group = _CONFIG_SECTION_GROUP.get(section, "other")
        writable = group != "paths"
        sensitive = group == "security"
        for key, value in _expand_model_row(*parsed):
            buckets.setdefault(group, []).append(
                {"key": key, "value": value, "writable": writable, "sensitive": sensitive}
            )
    groups: list[dict[str, Any]] = []
    for gid in _CONFIG_GROUP_ORDER:
        rows = buckets.get(gid)
        if rows:
            groups.append({"id": gid, "label": _CONFIG_GROUP_LABELS[gid], "rows": rows})
    return groups


@app.get("/api/config")
def config() -> dict[str, Any]:
    """Structured `hermes config show` for the Config tab, via the CLI-bridge.
    Honest failures: 503 when the bridge is down, 502 when hermes itself errors,
    503 when the output has no parseable sections — never a faked-empty config."""
    try:
        result = _bridge_run(["config", "show"])
    except BridgeError as exc:
        raise HTTPException(status_code=503, detail=f"config unavailable — {exc}")
    if result.get("code") != 0:
        stderr = (result.get("stderr") or "").strip()[:200]
        raise HTTPException(status_code=502, detail=f"hermes config show failed: {stderr or 'non-zero exit'}")
    groups = _parse_config_show(result.get("stdout") or "")
    if not groups:
        raise HTTPException(status_code=503, detail="config show returned no parseable sections")
    return {
        "source": "hermes config show",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "groups": groups,
    }


# ---------------------------------------------------------------------------
# Full config tree (Config tab: every section/leaf, not just the curated ~10).
#
# `hermes config show` is a CURATED summary (~6 groups / ~10 keys). The REAL
# config is 27 top-level sections / ~140 leaves in the agent's config.yaml. This
# endpoint reads the WHOLE file via the bridge's /config-raw dump (secrets
# already redacted there — the real bytes never reach hub-api) and walks it into
# a UI-friendly shape: an ordered list of sections, each with its scalar leaves
# flattened to dotted keys (list indices as dot segments, e.g.
# `fallback_providers.0.model`, exactly the form `config set` accepts). The
# curated GET /api/config stays intact for back-compat.
# ---------------------------------------------------------------------------

# Same rule the bridge's dump applies, re-applied here so hub-api independently
# knows which leaves are secret (and must never be shown or made writable).
_CONFIG_SENSITIVE_RE = re.compile(r"key|token|secret|password|hash", re.IGNORECASE)
# The sentinel the bridge substitutes for a SET secret value (empty/None stays as-is).
_CONFIG_REDACT = "__redacted__"

# Nice section titles for the 27 top-level keys; anything unmapped is humanised
# from its key so a new section is never dropped or shown as a raw token.
_CONFIG_FULL_SECTION_LABELS = {
    "model": "Model",
    "agent": "Agent",
    "terminal": "Terminal",
    "browser": "Browser",
    "tool_loop_guardrails": "Tool-Loop Guardrails",
    "compression": "Context Compression",
    "prompt_caching": "Prompt Caching",
    "auxiliary": "Auxiliary Models",
    "display": "Display",
    "dashboard": "Dashboard",
    "stt": "Speech-to-Text",
    "memory": "Memory",
    "delegation": "Delegation",
    "skills": "Skills",
    "timezone": "Timezone",
    "code_execution": "Code Execution",
    "streaming": "Streaming",
    "updates": "Updates",
    "_config_version": "Config Version",
    "session_reset": "Session Reset",
    "group_sessions_per_user": "Group Sessions Per User",
    "platform_toolsets": "Platform Toolsets",
    "plugins": "Plugins",
    "TELEGRAM_HOME_CHANNEL": "Telegram Home Channel",
    "mcp_servers": "MCP Servers",
    "onboarding": "Onboarding",
    "fallback_providers": "Fallback Providers",
}


def _config_section_label(key: str) -> str:
    label = _CONFIG_FULL_SECTION_LABELS.get(key)
    if label:
        return label
    return key.replace("_", " ").strip().title() or key


def _config_leaf_type(value: Any) -> str:
    """Map a Python value to the UI type tag. bool BEFORE int (bool subclasses int).
    Empty/None reads as 'str' (an editable blank); list/dict are structural."""
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "float"
    if isinstance(value, dict):
        return "dict"
    if isinstance(value, list):
        return "list"
    return "str"


def _config_leaf(dotted: str, section: str, value: Any) -> dict[str, Any]:
    """Build one leaf row. writable = simple scalar & not sensitive & not a structural
    container; sensitive = the dotted key matched the mask rule; `set` lets the UI show
    '(set)'/'(not set)' for a redacted secret whose real value it never receives."""
    sensitive = bool(_CONFIG_SENSITIVE_RE.search(dotted))
    typ = _config_leaf_type(value)
    structural = typ in ("list", "dict")
    writable = not structural and not sensitive
    # Label is the path RELATIVE to the section (e.g. "basic_auth.password_hash"); for a
    # top-level scalar section the relative path is empty, so fall back to the key itself.
    if dotted == section:
        label = section
    elif dotted.startswith(section + "."):
        label = dotted[len(section) + 1:]
    else:
        label = dotted
    return {
        "key": dotted,
        "label": label,
        "value": value,
        "type": typ,
        "writable": writable,
        "sensitive": sensitive,
        "set": value not in (None, "", [], {}),
    }


def _flatten_config(node: Any, prefix: str, section: str, out: list[dict[str, Any]]) -> None:
    """Recurse a section's value into flat leaf rows. Non-empty dict/list containers are
    walked (so nested scalars like `fallback_providers.0.model` become editable leaves);
    scalars — and EMPTY containers, which have nothing to recurse — become leaves so real
    config is never silently dropped."""
    if isinstance(node, dict) and node:
        for k, v in node.items():
            key = f"{prefix}.{k}" if prefix else str(k)
            _flatten_config(v, key, section, out)
    elif isinstance(node, list) and node:
        for i, v in enumerate(node):
            _flatten_config(v, f"{prefix}.{i}", section, out)
    else:
        out.append(_config_leaf(prefix, section, node))


@app.get("/api/config/full")
def config_full() -> dict[str, Any]:
    """The FULL config tree (every section/leaf) for the Config tab, via the CLI-bridge's
    /config-raw dump. Secrets arrive already redacted from the bridge. Honest failures:
    503 when the bridge is down or the payload is unusable — never a faked-empty config."""
    try:
        raw = _bridge_config_raw()
    except BridgeError as exc:
        raise HTTPException(status_code=503, detail=f"config unavailable — {exc}")
    tree = raw.get("config")
    if not isinstance(tree, dict) or not tree:
        raise HTTPException(status_code=503, detail="config dump returned no sections")
    sections: list[dict[str, Any]] = []
    leaf_count = 0
    for key, value in tree.items():
        leaves: list[dict[str, Any]] = []
        _flatten_config(value, key, key, leaves)
        sections.append({"id": key, "label": _config_section_label(key), "leaves": leaves})
        leaf_count += len(leaves)
    return {
        "source": "config.yaml",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "section_count": len(sections),
        "leaf_count": leaf_count,
        "sections": sections,
    }


@app.get("/api/advisor")
def advisor() -> dict[str, Any]:
    """Live advisor posture for the Advisor preset toggle. Reads the CURRENT config
    (model.default + advisor.{enabled,model}) via the SAME bridge /config-raw dump the
    Config tab uses, and derives which preset is live (off|quality|cost|custom). READ-ONLY
    — never mutates config. Honest 503 when the bridge is down or the dump is unusable."""
    try:
        raw = _bridge_config_raw()
    except BridgeError as exc:
        raise HTTPException(status_code=503, detail=f"advisor config unavailable — {exc}")
    tree = raw.get("config")
    if not isinstance(tree, dict) or not tree:
        raise HTTPException(status_code=503, detail="config dump returned no sections")
    model = tree.get("model") if isinstance(tree.get("model"), dict) else {}
    adv = tree.get("advisor") if isinstance(tree.get("advisor"), dict) else {}
    executor = model.get("default")
    advisor_enabled = adv.get("enabled")
    advisor_model = adv.get("model")
    return {
        "preset": _derive_advisor_preset(executor, advisor_enabled, advisor_model),
        "executor": executor,
        "advisor_enabled": advisor_enabled,
        "advisor_model": advisor_model,
    }


# ---------------------------------------------------------------------------
# Slice-1 cockpit surface (Assistant reorientation) — STUBS.
#
# These are the endpoints the reoriented 5-tab cockpit reads: Home vitals,
# the Cost tab's LiteLLM spend dataviz, Ops sessions, and the elevated Chat
# tab (gateway /v1/chat/completions SSE). The foundation slice only reserves
# the routes with HONEST 503s so the shell compiles + deploys; each real
# implementation lands in its own Feature slice against LIVE Hermes/LiteLLM
# (never mocked). No fake-green: an un-implemented surface says 503, loudly.
# ---------------------------------------------------------------------------

_SLICE1_PENDING = "implemented in its Slice-1 Feature; foundation reserves the route only"


# --- Home tab (Slice-1 Feature: cockpit vitals) ----------------------------
# One aggregate the Home glance reads: agent liveness (gateway /health/detailed),
# service health derived purely from each service's HTTP endpoint (no docker
# socket — honest 'unknown' for what can't be probed), today+MTD spend (native
# Hermes state.db via the hub-bridge /spend capability), and a session activity glance
# (gateway /api/sessions). Every section degrades independently: one dead source
# never fake-greens the rest, and cron has no HTTP source in Slice 1 so it stays
# an honest null (the Hermes cron store lands in Slice 2).

def _probe_ms(base: str, path: str, key: str, timeout: float = 3.0) -> tuple[bool, int | None]:
    """Reachability + round-trip latency for a service's own HTTP health endpoint.
    Returns (up, latency_ms); any transport/HTTP error is a real (False, ms)."""
    if not base:
        return False, None
    req = urllib.request.Request(base + path, headers={"Authorization": f"Bearer {key}"})
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read())
        ms = int((time.monotonic() - t0) * 1000)
        return True, ms
    except (urllib.error.URLError, OSError, ValueError):
        ms = int((time.monotonic() - t0) * 1000)
        return False, ms


@app.get("/api/vitals")
def vitals() -> dict[str, Any]:
    """Home glance: agent vitals + container/gateway health + spend + cron.
    Aggregates gateway /health/detailed, the cached spend windows, the cached
    bridge cron list, and gateway /api/sessions — each section degrades on its
    own."""
    # --- agent liveness (gateway /health/detailed) --------------------------
    detailed: dict[str, Any] = {}
    try:
        detailed = _hermes_get("/health/detailed") or {}
    except (OSError, ValueError):
        detailed = {}
    platforms = detailed.get("platforms") or {}
    gateway_state = detailed.get("gateway_state")
    discord_state = (platforms.get("discord") or {}).get("state")
    # Status is the GATEWAY alone; discord_state rides along so the client
    # renders its own "Discord disconnected" state instead of the hub calling
    # the whole agent down over one platform.
    agent_up = gateway_state == "running"

    # --- service health strip (HTTP-derived; no docker access) --------------
    gw_up, gw_ms = _probe_ms(HERMES_API_BASE, "/health", HERMES_API_KEY)

    def _status(up: bool, base: str) -> str:
        return "up" if up else ("down" if base else "unknown")

    containers = [
        {"id": "gateway", "label": "Gateway", "status": _status(gw_up, HERMES_API_BASE), "latency_ms": gw_ms},
        # hub-api is answering this very request — it is definitionally up.
        {"id": "hub-api", "label": "hub-api", "status": "up", "latency_ms": None},
    ]

    # --- spend (the same cached windows the Cost tab reads) -----------------
    # Any bridge/shape failure stays an honest null — never a fake zero.
    today_usd: float | None = None
    mtd_usd: float | None = None
    try:
        today_usd = float(_spend_fetch("today")["data"]["summary"]["total_usd"])
        mtd_usd = float(_spend_fetch("mtd")["data"]["summary"]["total_usd"])
    except (BridgeError, KeyError, TypeError, ValueError):
        today_usd = None
        mtd_usd = None

    # --- activity glance (gateway /api/sessions, TODAY only) ----------------
    # Counts cover sessions active since local midnight — the glance said
    # "today" while aggregating the gateway's whole 100-row backlog before.
    model: str | None = None
    sessions_count: int | None = None
    turns: int | None = None
    tool_calls: int | None = None
    try:
        sess = _hermes_get("/api/sessions?limit=100")
        rows = (sess.get("data") if isinstance(sess, dict) else None) or []
        if rows:
            model = rows[0].get("model")  # newest row — "current model" ignores the today-filter
        midnight_ts = datetime.now(HUB_TZ).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        rows = [r for r in rows if isinstance(r.get("last_active"), (int, float)) and r["last_active"] >= midnight_ts]
        sessions_count = len(rows)
        turns = sum(int(r.get("message_count") or 0) for r in rows)
        tool_calls = sum(int(r.get("tool_call_count") or 0) for r in rows)
    except (OSError, ValueError):
        sessions_count = turns = tool_calls = None

    # --- cron glance (cached bridge cron list — vitals polls per-minute) ----
    cron_total: int | None = None
    cron_next: str | None = None
    try:
        jobs = _cron_jobs_cached()
        cron_total = len(jobs)
        cron_next = _cron_next_label(jobs)
    except BridgeError:
        pass  # honest nulls — never a fabricated schedule

    return {
        "agent": {
            "id": HERMES_AGENT_ID,
            "name": HERMES_AGENT_NAME,
            "status": "up" if agent_up else ("down" if HERMES_API_BASE else "unknown"),
            "model": model,
            "gateway_state": gateway_state,
            "discord_state": discord_state,
            "busy": bool(detailed.get("gateway_busy")),
        },
        "containers": containers,
        "activity": {
            "sessions": sessions_count,
            "turns": turns,
            "tool_calls": tool_calls,
            # No honest MCP-call source over HTTP in Slice 1 (spend logs don't
            # populate mcp_namespaced_tool_name) — stay null rather than fake a 0.
            "mcp_calls": None,
        },
        "spend": {
            "today_usd": today_usd,
            "mtd_usd": mtd_usd,
            # No spend-cap source is configured; a fabricated cap would mislead.
            "cap_usd": None,
        },
        "cron": {"total": cron_total, "next_label": cron_next},
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


# --- Cost tab, native-spend pivot (reads Hermes state.db via hub-bridge) ----
# The bridge /spend contract is calendar-window based: one call carries a
# [cutoff, split) baseline period (feeding only prev_total_usd) and a
# [split, now] live period (feeding everything else), pre-bucketed at the
# requested granularity. hub-api resolves a window pill (today|7d|30d|mtd, on
# HUB_TZ calendar boundaries) to those epochs and caches the bridge
# payload 60s per window — summary, timeseries and the vitals glance all share
# ONE bridge call per window per minute.

_SPEND_WINDOWS = {"today", "7d", "30d", "mtd"}
_SPEND_TTL_S = 60.0
_SPEND_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_SPEND_LOCK = threading.Lock()


def _spend_window(window: str) -> tuple[int, int, str]:
    """Resolve a window pill to (cutoff_epoch, split_epoch, granularity). The prior
    period [cutoff, split) always equals the live period's length, so delta_pct
    compares like with like: yesterday, the 7d/30d before, or the previous month."""
    now = datetime.now(HUB_TZ)
    if window == "today":
        midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return int((midnight - timedelta(days=1)).timestamp()), int(midnight.timestamp()), "hour"
    # Day-bucketed windows start at a local midnight. A rolling now-7*86400 start cuts
    # a day in half, and the per-model side (OpenRouter activity, published per whole
    # day) then counts that whole boundary day — an over-count of up to a full day's
    # spend against the billing meters. Whole local days make both sides tile the same
    # span: "7d" is the last 7 calendar days, today included.
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if window == "7d":
        split = midnight - timedelta(days=6)
        return int((split - timedelta(days=7)).timestamp()), int(split.timestamp()), "day"
    if window == "30d":
        split = midnight - timedelta(days=29)
        return int((split - timedelta(days=30)).timestamp()), int(split.timestamp()), "day"
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    prev_month_start = (month_start - timedelta(days=1)).replace(day=1)
    return int(prev_month_start.timestamp()), int(month_start.timestamp()), "day"


def _or_canonical(model: str) -> str:
    m = model.split("/", 1)[1] if "/" in model else model
    m = m.split(":", 1)[0]
    return m.replace(".", "-") if "claude" in m else m


_OR_ACTIVITY_CACHE: tuple[float, list[dict[str, Any]]] | None = None


def _or_activity_rows() -> list[dict[str, Any]]:
    """OpenRouter per-day per-model account activity (management key), cached 300s.
    Empty list when no key or upstream failure — callers fall back to the ledger."""
    global _OR_ACTIVITY_CACHE
    mgmt = os.environ.get("OPENROUTER_MGMT_KEY")
    if not mgmt:
        return []
    if _OR_ACTIVITY_CACHE and _OR_ACTIVITY_CACHE[0] > time.time():
        return _OR_ACTIVITY_CACHE[1]
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/activity",
        headers={"Authorization": f"Bearer {mgmt}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            raw = json.loads(resp.read()).get("data", [])
        rows = [
            {
                "date": (r.get("date") or "")[:10],
                "model_raw": r.get("model") or "unknown",
                "model": _or_canonical(r.get("model") or "unknown"),
                "usage": float(r.get("usage") or 0),
                "prompt": int(r.get("prompt_tokens") or 0),
                "completion": int(r.get("completion_tokens") or 0),
            }
            for r in raw
        ]
    except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError):
        return []
    _OR_ACTIVITY_CACHE = (time.time() + 300, rows)
    return rows


def _day_labels(start_epoch: int, end_epoch: int) -> set[str]:
    days: set[str] = set()
    d = datetime.fromtimestamp(start_epoch, HUB_TZ).date()
    end = datetime.fromtimestamp(end_epoch, HUB_TZ).date()
    while d <= end:
        days.add(d.isoformat())
        d += timedelta(days=1)
    return days


def _or_proxy_rows() -> list[dict[str, Any]]:
    """Per-call rows from or-proxy: the only sub-daily per-model source for keys that do
    not pass through the gateway. OpenRouter itself publishes whole completed UTC days."""
    return [r for r in tail_jsonl(OR_PROXY_JSONL, 5000) if r.get("ts") and r.get("model")]


def _cw_ts(row: dict[str, Any]) -> float:
    return datetime.fromisoformat(row["ts"].replace("Z", "+00:00")).timestamp()


def _cost_watch_by_key() -> dict[str, list[dict[str, Any]]]:
    """The cost-watch snapshot trail, grouped per key and oldest-first."""
    by_key: dict[str, list[dict[str, Any]]] = {}
    for r in tail_jsonl(COST_WATCH_JSONL, 5000):
        if isinstance(r.get("usage"), (int, float)) and r.get("ts"):
            by_key.setdefault(r.get("key") or "hermes", []).append(r)
    for rows in by_key.values():
        rows.sort(key=lambda r: r["ts"])
    return by_key


def _key_spend_since(rows_k: list[dict[str, Any]], start_ts: float, now_ts: float | None = None) -> float:
    """Spend on one key since start_ts, summed over the snapshot-to-snapshot intervals
    overlapping it, prorated by the share of each interval inside the window. A key's
    first-ever snapshot (delta_since_last null) carries everything it spent before the
    watch began; born inside the window, that spend is the window's."""
    now_ts = now_ts if now_ts is not None else time.time()
    usd = 0.0
    prev = None
    for r in rows_k:
        if prev is not None:
            t0, t1 = _cw_ts(prev), _cw_ts(r)
            overlap = min(t1, now_ts) - max(t0, start_ts)
            if overlap > 0 and t1 > t0:
                # An interval straddling the boundary counts for the share of its span
                # that falls inside the window. Dropping it whole undercounts by up to a
                # full interval — a whole day, back when snapshots were daily.
                delta = max(float(r["usage"]) - float(prev["usage"]), 0.0)
                usd += delta * min(overlap / (t1 - t0), 1.0)
        prev = r
    first = rows_k[0]
    if first.get("delta_since_last") is None and _cw_ts(first) >= start_ts:
        usd += float(first["usage"])
    return usd


def _or_billed_since(start_ts: float) -> float | None:
    """Total OpenRouter spend since start_ts per OpenRouter's own per-key meters.
    This is the billing number; the activity feed lags it by hours, so the hero and
    provider split use this and leave activity to supply the per-model breakdown."""
    by_key = _cost_watch_by_key()
    if not by_key:
        return None
    return sum(_key_spend_since(rows, start_ts) for rows in by_key.values())


def _apply_or_hourly(data: dict[str, Any], rows: list[dict[str, Any]]) -> None:
    """The hourly 'today' view. OR publishes daily totals with no hourly detail, so
    the per-hour ledger bars stay exactly as they are — but spend on models the
    gateway never logs (a key calling OpenRouter directly) would otherwise vanish
    from the default view entirely. Add only those models, as their own series on
    the newest bucket, and flag or_source so the UI can say the placement is a day
    total, not an hour's. Models the ledger already has are left alone: OR's daily
    figure cannot be split across hours without inventing detail."""
    today = datetime.now(HUB_TZ).date().isoformat()
    ledger_models = {m["model"] for m in data["models"]}

    # or-proxy logs one timestamped row per call, so its models get REAL hourly bars
    # rather than a day total parked in one bucket. Per model it supersedes the daily
    # figure entirely — both describe the same spend, and adding both double-counts.
    hourly: dict[str, dict[str, Any]] = {}
    for r in _or_proxy_rows():
        t = datetime.fromisoformat(r["ts"].replace("Z", "+00:00")).astimezone(HUB_TZ)
        model = _or_canonical(r.get("model") or "unknown")
        if t.date().isoformat() != today or model in ledger_models:
            continue
        a = hourly.setdefault(model, {"usd": 0.0, "prompt": 0, "completion": 0, "buckets": {}})
        usd = float(r.get("cost") or 0.0)
        a["usd"] += usd
        a["prompt"] += int(r.get("prompt_tokens") or 0)
        a["completion"] += int(r.get("completion_tokens") or 0)
        key = t.strftime("%Y-%m-%dT%H:00")
        a["buckets"][key] = a["buckets"].get(key, 0.0) + usd

    extra: dict[str, dict[str, float]] = {}
    for r in rows:
        if r["date"] != today or r["model"] in ledger_models or r["model"] in hourly:
            continue
        a = extra.setdefault(r["model"], {"usd": 0.0, "prompt": 0, "completion": 0})
        a["usd"] += r["usage"]
        a["prompt"] += r["prompt"]
        a["completion"] += r["completion"]
    # Sub-tenth-of-a-cent models round to $0.000 in the UI and only add noise rows.
    extra = {m: a for m, a in extra.items() if round(a["usd"], 3) > 0}
    hourly = {m: a for m, a in hourly.items() if round(a["usd"], 3) > 0}
    if not extra and not hourly:
        data["or_source"] = "ledger"
        return

    added = sum(a["usd"] for a in extra.values()) + sum(a["usd"] for a in hourly.values())
    s = data["summary"]
    s["total_usd"] = round(float(s["total_usd"]) + added, 6)
    s["by_provider"]["openrouter"] = round(float(s["by_provider"].get("openrouter", 0.0)) + added, 6)
    for model, a in {**extra, **hourly}.items():
        data["models"].append({"model": model, "provider": "openrouter", "input": a["prompt"],
                               "output": a["completion"], "cache_read": 0, "cache_write": 0,
                               "sessions": None, "cost": round(a["usd"], 6), "aliases": []})
    data["models"].sort(key=lambda m: -m["cost"])

    buckets = {b["bucket"]: b for b in data["timeseries"]}
    newest = data["timeseries"][-1] if data["timeseries"] else None

    def add_to(b, model, usd):
        b["total"] = round(float(b["total"]) + usd, 6)
        b["per_provider"]["openrouter"] = round(float(b["per_provider"].get("openrouter", 0.0)) + usd, 6)
        b["per_model"][model] = round(b["per_model"].get(model, 0.0) + usd, 6)

    for model, a in hourly.items():
        for key, usd in a["buckets"].items():
            # Every hour of the window has a bucket; anything unplaceable goes to the
            # newest rather than being dropped, because losing spend is the worse error.
            b = buckets.get(key) or newest
            if b is not None:
                add_to(b, model, usd)
    if newest is not None:
        for model, a in extra.items():
            add_to(newest, model, a["usd"])
    data["or_source"] = "openrouter-proxy" if hourly else "openrouter-daily"


def _apply_or_truth(data: dict[str, Any], cutoff: int, split: int, gran: str) -> None:
    """Replace ledger ESTIMATES of OpenRouter-billed spend with OpenRouter's own
    per-day account activity (their bill: cache discounts + aux models like kimi
    vision / gemini extract that never write session rows). OR days are UTC but
    are counted under the same calendar label as the local (NY) day they overlap
    20/24 hours — labels in the UI stay local; nothing renders in UTC. Ledger
    keeps: anthropic-direct/custom rows, session counts, token totals, and the
    hourly 'today' chart (OR data is daily-only). Mutates in place."""
    rows = _or_activity_rows()
    # OR publishes activity with up to ~a day of lag, and daily-only — so the
    # swap applies ONLY to days OR has published; unpublished days (usually
    # today) keep the ledger estimate, and the hourly today view stays ledger
    # end to end so its hero and chart always agree.
    if not rows:
        data["or_source"] = "ledger"
        return
    if gran != "day":
        _apply_or_hourly(data, rows)
        return
    s = data["summary"]
    published = {r["date"] for r in rows}
    cur_days = _day_labels(split, int(time.time()))
    prev_days = _day_labels(cutoff, split) - cur_days
    cur_pub = cur_days & published

    cur = [r for r in rows if r["date"] in cur_pub]
    or_cur = sum(r["usage"] for r in cur)

    # Per-day ledger OR comes from the buckets, so only published days swap out.
    led_or_by_day = {b["bucket"]: float(b["per_provider"].get("openrouter", 0.0)) for b in data["timeseries"]}
    led_or_pub = sum(v for d, v in led_or_by_day.items() if d in cur_pub)
    led_or_unpub = sum(v for d, v in led_or_by_day.items() if d not in cur_pub)

    s["total_usd"] = round(float(s["total_usd"]) - led_or_pub + or_cur, 6)
    new_or_total = or_cur + led_or_unpub
    if new_or_total > 0 or "openrouter" in s["by_provider"]:
        s["by_provider"]["openrouter"] = round(new_or_total, 6)
    # Prev window: whole-window swap is only honest when every prev day is
    # published (they're past days, so normally yes); otherwise leave ledger.
    if prev_days and prev_days <= published:
        or_prev = sum(r["usage"] for r in rows if r["date"] in prev_days)
        led_prev_or = float((s.get("prev_by_provider") or {}).get("openrouter", 0.0))
        s["prev_total_usd"] = round(float(s["prev_total_usd"]) - led_prev_or + or_prev, 6)

    or_model_names = {m["model"] for m in data["models"] if m["provider"] == "openrouter"}
    kept = [m for m in data["models"] if m["provider"] != "openrouter"]
    agg: dict[str, dict[str, Any]] = {}

    def _row(model: str) -> dict[str, Any]:
        return agg.setdefault(model, {"model": model, "provider": "openrouter",
                                      "input": 0, "output": 0, "cache_read": 0,
                                      "cache_write": 0, "sessions": None, "cost": 0.0,
                                      "aliases": []})

    for r in cur:
        a = _row(r["model"])
        a["cost"] += r["usage"]
        a["input"] += r["prompt"]
        a["output"] += r["completion"]
        if r["model_raw"] not in a["aliases"]:
            a["aliases"].append(r["model_raw"])
    # Unpublished days: fold the ledger's per-model OR estimates back in so
    # today's activity isn't dropped while OR's row for it hasn't landed.
    for b in data["timeseries"]:
        if b["bucket"] in cur_pub:
            continue
        for name, v in b["per_model"].items():
            if name in or_model_names and v > 0:
                _row(name)["cost"] += v
    or_models = [{**a, "cost": round(a["cost"], 6)} for a in agg.values() if a["cost"] > 0]
    data["models"] = sorted(kept + or_models, key=lambda m: -m["cost"])

    by_day: dict[str, list[dict[str, Any]]] = {}
    for r in cur:
        by_day.setdefault(r["date"], []).append(r)
    for b in data["timeseries"]:
        if b["bucket"] not in cur_pub:
            continue  # unpublished days keep their ledger bucket untouched
        day_rows = by_day.get(b["bucket"], [])
        or_day = sum(r["usage"] for r in day_rows)
        led_day = float(b["per_provider"].pop("openrouter", 0.0))
        b["total"] = round(float(b["total"]) - led_day + or_day, 6)
        if or_day > 0:
            b["per_provider"]["openrouter"] = round(or_day, 6)
        for name in or_model_names:
            b["per_model"].pop(name, None)
        for r in day_rows:
            if r["usage"] > 0:
                b["per_model"][r["model"]] = round(b["per_model"].get(r["model"], 0.0) + r["usage"], 6)
    data["or_source"] = "openrouter"


def _reconcile_or_billed(data: dict[str, Any], split: int) -> None:
    """Swap the OpenRouter slice of the window total for OpenRouter's own per-key
    billing meters. The activity feed that supplies the per-model breakdown lags those
    meters by hours, so the hero would otherwise understate the bill and disagree with
    the per-key card. Consequence, deliberate: the model bars can sum to slightly less
    than the hero until activity catches up."""
    billed = _or_billed_since(split)
    if billed is None:
        return
    s = data["summary"]
    led_or = float(s["by_provider"].get("openrouter", 0.0))
    s["by_provider"]["openrouter"] = round(billed, 6)
    s["total_usd"] = round(float(s["total_usd"]) - led_or + billed, 6)


def _spend_fetch(window: str) -> dict[str, Any]:
    """Bridge /spend for one window (+ OpenRouter account-truth overlay), cached
    60s. Returns {data, cutoff, split, granularity, fetched_at}; failures raise
    BridgeError and are never cached."""
    if window not in _SPEND_WINDOWS:
        raise HTTPException(status_code=400, detail=f"window must be one of {sorted(_SPEND_WINDOWS)}")
    with _SPEND_LOCK:
        hit = _SPEND_CACHE.get(window)
        if hit and hit[0] > time.time():
            return hit[1]
    cutoff, split, gran = _spend_window(window)
    data = _bridge_spend(cutoff, split, gran)
    _apply_or_truth(data, cutoff, split, gran)
    _reconcile_or_billed(data, split)
    payload = {
        "data": data,
        "cutoff": cutoff,
        "split": split,
        "granularity": gran,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }
    with _SPEND_LOCK:
        _SPEND_CACHE[window] = (time.time() + _SPEND_TTL_S, payload)
    return payload


def _iso_local(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, HUB_TZ).isoformat()


@app.get("/api/spend/summary")
def spend_summary(window: str = "mtd") -> dict[str, Any]:
    """Cost hero: windowed total spend + delta vs the equal-length prior period,
    the full by-model table (tokens, sessions, share), the provider split, cache
    savings and any unpriced models — all from ONE cached bridge /spend call."""
    try:
        p = _spend_fetch(window)
    except BridgeError as exc:
        raise HTTPException(status_code=503, detail=f"Hermes spend source unavailable — {exc}")
    data = p["data"]
    s = data["summary"]
    total = float(s["total_usd"])
    prev_total = float(s["prev_total_usd"])
    models = [
        {
            "model": m["model"],
            "provider": m["provider"],
            "total_spend": m["cost"],
            "input": m["input"],
            "output": m["output"],
            "cache_read": m["cache_read"],
            "cache_write": m["cache_write"],
            "sessions": m["sessions"],
            "share_pct": round(m["cost"] / total * 100, 1) if total > 0 else 0.0,
            "aliases": m["aliases"],
        }
        for m in data["models"]
    ]
    return {
        "total_usd": total,
        "window": window,
        "range": {"start": _iso_local(p["split"]), "end": datetime.now(HUB_TZ).isoformat()},
        "prev_range": {"start": _iso_local(p["cutoff"]), "end": _iso_local(p["split"])},
        "delta_pct": ((total - prev_total) / prev_total * 100.0) if prev_total > 0 else None,
        "prev_total_usd": prev_total,
        "models": models,
        "by_provider": s["by_provider"],
        "tokens": s["tokens"],
        "sessions": s["sessions"],
        "cache": data["cache"],
        "unpriced": data["unpriced"],
        "updated_at": p["fetched_at"],
    }


@app.get("/api/spend/timeseries")
def spend_timeseries(window: str = "mtd") -> dict[str, Any]:
    """Cost area chart: the cached window's bridge buckets passed through under
    the PWA's field names — per-model AND per-provider splits + tokens/sessions."""
    try:
        p = _spend_fetch(window)
    except BridgeError as exc:
        raise HTTPException(status_code=503, detail=f"Hermes spend source unavailable — {exc}")
    points = [
        {
            "date": b["bucket"],
            "spend_usd": b["total"],
            "per_model": b["per_model"],
            "per_provider": b["per_provider"],
            "tokens": b["tokens"],
            "sessions": b["sessions"],
        }
        for b in p["data"]["timeseries"]
    ]
    return {"window": window, "granularity": p["granularity"], "points": points}


# --- OpenRouter credits (prepaid balance, straight from the provider) --------
_OPENROUTER_TTL_S = 300.0
_OPENROUTER_CACHE: tuple[float, dict[str, Any]] | None = None
_OPENROUTER_LOCK = threading.Lock()


@app.get("/api/cost/openrouter")
def cost_openrouter() -> dict[str, Any]:
    """OpenRouter account truth, cached 300s. Credits from GET /api/v1/credits
    (inference key). Per-model activity from GET /api/v1/activity — that endpoint
    only answers to a MANAGEMENT key (OPENROUTER_MGMT_KEY); without one, activity
    is null and the UI shows credits alone. Activity exists to catch spend that
    never reaches state.db (aux models like kimi vision don't write session rows).
    404 when no key at all (card hides); credits failure is an honest 502;
    activity failure degrades to null (credits still render)."""
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise HTTPException(status_code=404, detail="OPENROUTER_API_KEY not configured")
    global _OPENROUTER_CACHE
    with _OPENROUTER_LOCK:
        if _OPENROUTER_CACHE and _OPENROUTER_CACHE[0] > time.time():
            return _OPENROUTER_CACHE[1]
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/credits",
        headers={"Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            d = json.loads(resp.read())["data"]
        credits = float(d["total_credits"])
        usage = float(d["total_usage"])
    except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=502, detail=f"openrouter credits unavailable: {exc}")

    # /key answers to the inference key and carries OpenRouter's own calendar
    # meters — the honest cross-check against ledger-derived estimates (aux
    # models like kimi vision bill here but never write session rows).
    usage_daily = usage_monthly = None
    kreq = urllib.request.Request(
        "https://openrouter.ai/api/v1/key",
        headers={"Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(kreq, timeout=5) as resp:
            kd = json.loads(resp.read())["data"]
        usage_daily = float(kd.get("usage_daily") or 0)
        usage_monthly = float(kd.get("usage_monthly") or 0)
    except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError):
        pass  # meters are enrichment; credits alone still render

    activity: list[dict[str, Any]] | None = None
    mgmt = os.environ.get("OPENROUTER_MGMT_KEY")
    if mgmt:
        areq = urllib.request.Request(
            "https://openrouter.ai/api/v1/activity",
            headers={"Authorization": f"Bearer {mgmt}"},
        )
        try:
            with urllib.request.urlopen(areq, timeout=8) as resp:
                rows = json.loads(resp.read()).get("data", [])
            agg: dict[str, dict[str, Any]] = {}
            for r in rows:
                m = r.get("model") or "unknown"
                a = agg.setdefault(m, {"model": m, "usage": 0.0, "requests": 0,
                                       "prompt_tokens": 0, "completion_tokens": 0})
                a["usage"] += float(r.get("usage") or 0)
                a["requests"] += int(r.get("requests") or 0)
                a["prompt_tokens"] += int(r.get("prompt_tokens") or 0)
                a["completion_tokens"] += int(r.get("completion_tokens") or 0)
            activity = sorted(
                ({**a, "usage": round(a["usage"], 6)} for a in agg.values()),
                key=lambda a: -a["usage"],
            )
        except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError):
            activity = None  # credits still render; the card notes activity is off

    # Per-key spend from the cost-watch snapshot trail (COST_WATCH_JSONL), written by an
    # optional host job this repo does not ship. That job holds the keys and writes only
    # totals here, so tracking another key never puts its secret in hub-api's
    # environment. Rows predating multi-key support carry no "key" and are all the
    # assistant's key.
    by_key = _cost_watch_by_key()
    now_local = datetime.now(HUB_TZ)
    midnight = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    bounds = {  # same spans _spend_window resolves, so card and hero cannot diverge
        "today": midnight.timestamp(),
        "7d": (midnight - timedelta(days=6)).timestamp(),
        "30d": (midnight - timedelta(days=29)).timestamp(),
        "mtd": midnight.replace(day=1).timestamp(),
    }
    keys = []
    for name, rows_k in sorted(by_key.items()):
        latest = rows_k[-1]
        keys.append({
            "name": name, "label": latest.get("label"), "usage": latest.get("usage"),
            "windows": {w: {"usd": round(_key_spend_since(rows_k, b), 6), "since": rows_k[0]["ts"]}
                        for w, b in bounds.items()},
            "ts": latest.get("ts"),
        })

    payload = {
        "total_credits": credits,
        "total_usage": usage,
        "balance": round(credits - usage, 6),
        "usage_daily": usage_daily,
        "usage_monthly": usage_monthly,
        "keys": keys,
        "activity": activity,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    with _OPENROUTER_LOCK:
        _OPENROUTER_CACHE = (time.time() + _OPENROUTER_TTL_S, payload)
    return payload


# --- Cost tab, recurring spend (flat subscriptions) ---------------------------
# Read from a plain file (HUB_RECURRING_COSTS below), so a price correction is an
# edit — no image rebuild and no container recreate.
RECURRING_COSTS = Path(os.environ.get(
    "HUB_RECURRING_COSTS", "/data/finance/recurring-costs.json"))

_DAYS_PER_YEAR = 365.25
_CADENCE_DAYS = {"monthly": _DAYS_PER_YEAR / 12, "annual": _DAYS_PER_YEAR}


@app.get("/api/cost/recurring")
def cost_recurring(window: str = "mtd") -> dict[str, Any]:
    """The flat subscriptions behind the assistant, prorated onto the same window the
    spend hero resolves.

    This is deliberately its own endpoint with its own total. The money here is
    NEVER folded into /api/spend/summary: the hero counts metered token usage,
    these charges are not metered at all, and a page that silently adds the two
    is a page that lies about both. The UI shows them side by side instead.

    Proration runs off an annualised daily rate rather than days-in-this-month,
    so a $100/mo line reads the same $3.29/day in February as in August and a
    window straddling a month boundary needs no special case."""
    if window not in _SPEND_WINDOWS:
        raise HTTPException(status_code=400, detail=f"window must be one of {sorted(_SPEND_WINDOWS)}")
    try:
        ledger = json.loads(RECURRING_COSTS.read_text())
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=f"Recurring-costs ledger unreadable — {exc}")

    _, split, _ = _spend_window(window)
    now = datetime.now(HUB_TZ)
    elapsed_days = max((now.timestamp() - split) / 86400.0, 0.0)

    items = []
    for row in ledger.get("items", []):
        if not row.get("active", True):
            continue
        cadence_days = _CADENCE_DAYS.get(row.get("cadence"))
        if cadence_days is None:
            continue
        daily = float(row["amount_usd"]) / cadence_days
        items.append({
            "id": row["id"],
            "label": row["label"],
            "vendor": row.get("vendor"),
            "category": row.get("category"),
            "cadence": row["cadence"],
            "amount_usd": float(row["amount_usd"]),
            "daily_usd": round(daily, 6),
            "monthly_usd": round(daily * _CADENCE_DAYS["monthly"], 6),
            "window_usd": round(daily * elapsed_days, 6),
            "note": row.get("note"),
        })
    items.sort(key=lambda i: -i["window_usd"])

    return {
        "window": window,
        "range": {"start": _iso_local(int(split)), "end": now.isoformat()},
        "elapsed_days": round(elapsed_days, 4),
        "items": items,
        "total_window_usd": round(sum(i["window_usd"] for i in items), 6),
        "total_monthly_usd": round(sum(i["monthly_usd"] for i in items), 6),
        "excludes": [k for k in ledger.get("_excluded", {}) if not k.startswith("_")],
        "updated_on": ledger.get("updated_on"),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


# --- Ops tab (Slice-1 Feature: sessions read surface) ----------------------
# The gateway /api/sessions is the single source of truth for live agent
# conversations (telegram / cli / api_server), carrying per-session model,
# counts, tokens and cost. We map its rows to the cockpit AgentSession shape
# and sort newest-active first. /api/sessions/{id} fetches one authoritative
# record for the row→detail view. Any transport/HTTP/JSON failure is an honest
# 503 — never a fabricated empty list. Cron + the ops kanban are CLI-backed and
# read through the hub-bridge below (GET /api/cron, GET /api/kanban).

def _session_row(r: dict[str, Any]) -> dict[str, Any]:
    """Map one gateway session record to the cockpit AgentSession shape.
    Prefers actual (billed) cost over the estimate; tokens sum input+output."""
    inp = int(r.get("input_tokens") or 0)
    out = int(r.get("output_tokens") or 0)
    cost = r.get("actual_cost_usd")
    if cost is None:
        cost = r.get("estimated_cost_usd")
    return {
        "id": r.get("id"),
        "source": r.get("source") or "unknown",
        "model": r.get("model"),
        "title": r.get("title"),
        "message_count": int(r.get("message_count") or 0),
        "tool_call_count": int(r.get("tool_call_count") or 0),
        "total_tokens": (inp + out) if (inp or out) else None,
        "estimated_cost_usd": float(cost) if cost is not None else None,
        "started_at": r.get("started_at"),
        "last_active": r.get("last_active"),
        "preview": r.get("preview"),
    }


@app.get("/api/sessions")
def sessions() -> dict[str, Any]:
    """Ops tab: live agent sessions from the gateway /api/sessions, mapped to
    the cockpit AgentSession shape and sorted newest-active first."""
    if not HERMES_API_BASE:
        raise HTTPException(status_code=503, detail="gateway not configured")
    try:
        raw = _hermes_get("/api/sessions?limit=100")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=f"gateway sessions unavailable: {exc}")
    rows = raw.get("data") if isinstance(raw, dict) else None
    data = [_session_row(r) for r in (rows or []) if isinstance(r, dict) and r.get("id")]
    data.sort(key=lambda s: (s["last_active"] or s["started_at"] or 0), reverse=True)
    return {"data": data}


@app.get("/api/sessions/{session_id}")
def session_detail(session_id: str) -> dict[str, Any]:
    """Ops row→detail: one authoritative session record from the gateway
    /api/sessions/{id}. 404 passes through; other failures become honest 503s."""
    if not HERMES_API_BASE:
        raise HTTPException(status_code=503, detail="gateway not configured")
    try:
        raw = _hermes_get(f"/api/sessions/{urllib.parse.quote(session_id, safe='')}")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise HTTPException(status_code=404, detail="session not found")
        raise HTTPException(status_code=503, detail=f"gateway session unavailable: {exc}")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=f"gateway session unavailable: {exc}")
    sess = raw.get("session") if isinstance(raw, dict) else None
    if not isinstance(sess, dict):
        raise HTTPException(status_code=404, detail="session not found")
    return {"session": _session_row(sess)}


def _transcript_row(m: dict[str, Any]) -> dict[str, Any]:
    """Map one gateway transcript message to the cockpit shape. Tool calls are
    flattened to {name, arguments}; reasoning falls back to reasoning_content."""
    calls: list[dict[str, Any]] = []
    for c in (m.get("tool_calls") or []):
        if not isinstance(c, dict):
            continue
        fn = c.get("function") if isinstance(c.get("function"), dict) else {}
        calls.append({"name": fn.get("name"), "arguments": fn.get("arguments")})
    return {
        "id": m.get("id"),
        "role": m.get("role"),
        "content": m.get("content"),
        "tool_name": m.get("tool_name"),
        "tool_calls": calls,
        "timestamp": m.get("timestamp"),
        "finish_reason": m.get("finish_reason"),
        "reasoning": m.get("reasoning") or m.get("reasoning_content"),
    }


@app.get("/api/sessions/{session_id}/messages")
def session_messages(session_id: str) -> dict[str, Any]:
    """Ops row→transcript: the full message list for one session, proxied from the
    gateway's own /api/sessions/{id}/messages (Bearer HERMES_API_KEY).
    404 passes through; other failures become honest 503s — never a faked-empty thread."""
    if not HERMES_API_BASE:
        raise HTTPException(status_code=503, detail="gateway not configured")
    try:
        raw = _hermes_get(f"/api/sessions/{urllib.parse.quote(session_id, safe='')}/messages")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise HTTPException(status_code=404, detail="session not found")
        raise HTTPException(status_code=503, detail=f"gateway transcript unavailable: {exc}")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=f"gateway transcript unavailable: {exc}")
    rows = raw.get("data") if isinstance(raw, dict) else None
    data = [_transcript_row(m) for m in (rows or []) if isinstance(m, dict)]
    return {"session_id": session_id, "data": data, "count": len(data)}


# --- Ops tab (Slice 2a: cron + kanban read surfaces via CLI-bridge) ---------
# Cron jobs and the kanban board are hermes-CLI-only (no HTTP source), so both
# read through the privileged hub-bridge sidecar via _bridge_run. `hermes cron
# list` has no --json (its structured text block is parsed here); `hermes kanban
# list/stats` support --json and are parsed as structured data. READ-ONLY this
# slice — pause/resume/create are WRITE ops that land in Slice 2b behind the
# WebAuthn gate. Honest failures: 503 when the bridge is down, 502 when hermes
# itself errors, and an empty board is an honest empty list (never fake data).

# `hermes cron list [--all]` block format (see hermes_cli/cron.py cron_list):
#   "  <id> [<state>]"        header — state ∈ active|paused|completed|disabled
#   "    Name:      <v>"      indented "Key:  value" fields (Next/Last run have
#   "    Schedule:  <v>"      a space in the key). A "Mode: no-agent (...)" line
#   ...                       is present only for script (no-agent) jobs.
_CRON_HEADER_RE = re.compile(r"^\s{2}(\S+)\s+\[(\w+)\]\s*$")
_CRON_FIELD_RE = re.compile(r"^\s{4}([A-Za-z][A-Za-z ]*?):\s+(.*)$")
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def _cron_job_shape(raw: dict[str, str]) -> dict[str, Any]:
    """Map one parsed cron block into the Ops cron-row shape the PWA renders."""
    state = raw.get("_state", "")
    mode_line = raw.get("mode") or ""
    return {
        "id": raw.get("id"),
        "name": raw.get("name"),
        "schedule": raw.get("schedule"),
        "repeat": raw.get("repeat"),
        "next_run_at": raw.get("next_run") or None,
        "deliver": raw.get("deliver"),
        # Mode line only prints for no-agent (script) jobs; its absence = agent job.
        "mode": "script" if "no-agent" in mode_line else "agent",
        "script": raw.get("script"),
        "last_run": raw.get("last_run"),
        "state": state,
        "active": state == "active",
    }


def _parse_cron_list(text: str) -> list[dict[str, Any]]:
    """Parse `hermes cron list` text into cron-row dicts. Job blocks start at a
    "  <id> [state]" header; the box-drawing frame + footer lines are ignored."""
    jobs: list[dict[str, str]] = []
    cur: dict[str, str] | None = None
    for raw_line in text.splitlines():
        line = _ANSI_RE.sub("", raw_line)
        header = _CRON_HEADER_RE.match(line)
        if header:
            cur = {"id": header.group(1), "_state": header.group(2)}
            jobs.append(cur)
            continue
        if cur is None:
            continue
        field = _CRON_FIELD_RE.match(line)
        if field:
            key = field.group(1).strip().lower().replace(" ", "_")
            cur[key] = field.group(2).strip()
    return [_cron_job_shape(j) for j in jobs]


_CRON_TTL_S = 120.0
_CRON_CACHE: tuple[float, list[dict[str, Any]]] | None = None
_CRON_LOCK = threading.Lock()


def _cron_jobs_cached() -> list[dict[str, Any]]:
    """The /api/cron read, cached 120s for the vitals glance — vitals polls
    per-minute and must not add a `docker exec` each time. /api/cron itself
    stays uncached so the board reflects a pause/resume write immediately."""
    global _CRON_CACHE
    with _CRON_LOCK:
        if _CRON_CACHE and _CRON_CACHE[0] > time.time():
            return _CRON_CACHE[1]
    result = _bridge_run(["cron", "list", "--all"])
    if result.get("code") != 0:
        stderr = (result.get("stderr") or "").strip()[:200]
        raise BridgeError(stderr or "non-zero exit")
    jobs = _parse_cron_list(result.get("stdout") or "")
    with _CRON_LOCK:
        _CRON_CACHE = (time.time() + _CRON_TTL_S, jobs)
    return jobs


_CRON_COSTS_TTL_S = 120.0
_CRON_COSTS_CACHE: tuple[float, dict[str, Any]] | None = None
_CRON_COSTS_LOCK = threading.Lock()


def _cron_costs_cached() -> dict[str, Any]:
    """The bridge /cron-costs read, cached 120s — /api/cron and /api/cron/costs
    both consume it and each render is a docker exec away. Failures raise
    BridgeError and are never cached (same posture as the spend cache)."""
    global _CRON_COSTS_CACHE
    with _CRON_COSTS_LOCK:
        if _CRON_COSTS_CACHE and _CRON_COSTS_CACHE[0] > time.time():
            return _CRON_COSTS_CACHE[1]
    data = _bridge_cron_costs()
    with _CRON_COSTS_LOCK:
        _CRON_COSTS_CACHE = (time.time() + _CRON_COSTS_TTL_S, data)
    return data


def _cron_attach_costs(jobs: list[dict[str, Any]]) -> None:
    """Merge per-job cost onto Ops cron rows in place. Cost is an enrichment:
    when the bridge read fails the rows still render (cost stays absent), the
    board itself never 503s over a cost hiccup."""
    try:
        by_id = {c.get("id"): c for c in _cron_costs_cached().get("jobs", [])}
    except BridgeError:
        return
    for j in jobs:
        c = by_id.get(j.get("id"))
        if c:
            j["cost"] = {"last_run": c.get("last_run"), "week": c.get("week")}


def _cron_next_label(jobs: list[dict[str, Any]]) -> str | None:
    """'21:00 ops-watch' for the soonest active job's next_run_at (day-prefixed
    when it isn't today), None when nothing is scheduled."""
    best: tuple[datetime, str] | None = None
    for j in jobs:
        if not j.get("active"):
            continue
        try:
            t = datetime.fromisoformat(j.get("next_run_at") or "")
        except ValueError:
            continue
        if t.tzinfo is None:
            t = t.replace(tzinfo=HUB_TZ)
        if best is None or t < best[0]:
            best = (t, j.get("name") or j.get("id") or "?")
    if best is None:
        return None
    t = best[0].astimezone(HUB_TZ)
    when = t.strftime("%H:%M") if t.date() == datetime.now(HUB_TZ).date() else t.strftime("%a %H:%M")
    return f"{when} {best[1]}"


@app.get("/api/cron")
def cron() -> dict[str, Any]:
    """Ops cron board: scheduled jobs from `hermes cron list --all` via the
    CLI-bridge (includes paused/disabled). Honest failures: 503 when the bridge
    is down, 502 when hermes errors; an empty schedule is an honest empty list."""
    try:
        result = _bridge_run(["cron", "list", "--all"])
    except BridgeError as exc:
        raise HTTPException(status_code=503, detail=f"cron unavailable — {exc}")
    if result.get("code") != 0:
        stderr = (result.get("stderr") or "").strip()[:200]
        raise HTTPException(status_code=502, detail=f"hermes cron list failed: {stderr or 'non-zero exit'}")
    jobs = _parse_cron_list(result.get("stdout") or "")
    _cron_attach_costs(jobs)
    return {
        "source": "hermes cron list --all",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "jobs": jobs,
        "count": len(jobs),
    }


@app.get("/api/cron/costs")
def cron_costs() -> dict[str, Any]:
    """Cost tab per-job rollup: each cron job's last-run cost + trailing-7d
    cost/tokens/runs with a per-day breakdown, from the bridge /cron-costs
    capability (state.db sessions joined to cron job names). Runs whose ledger
    cost_status is 'unknown' carry cost_usd null and count in unknown_runs —
    rendered as 'cost unknown', never $0. Honest failures: 503 when the bridge
    is down or the query errors."""
    try:
        data = _cron_costs_cached()
    except BridgeError as exc:
        raise HTTPException(status_code=503, detail=f"cron costs unavailable — {exc}")
    return {
        "source": "hermes state.db sessions (source=cron) via CLI-bridge",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window_days": data.get("window_days", 7),
        "jobs": data.get("jobs", []),
        "count": len(data.get("jobs", [])),
    }


@app.get("/api/cron/logs")
def cron_logs(limit: int = 30) -> dict[str, Any]:
    """Ops Logs view: the most-recent scheduled-job run outputs, archived by Hermes at
    its `cron/output/<job_id>/<timestamp>.md` archive and read via the hub-bridge /cron-logs
    capability. `limit` (default 30) is clamped to [1, 200] before the bridge call. Honest
    failures: 503 when the bridge is down or the query errors (mirrors the spend surfaces);
    no runs is an honest empty list, never faked."""
    n = max(1, min(200, limit))
    try:
        data = _bridge_cron_logs(n)
    except BridgeError as exc:
        raise HTTPException(status_code=503, detail=f"cron logs unavailable — {exc}")
    runs = data.get("runs") if isinstance(data.get("runs"), list) else []
    return {
        "source": "hermes cron output archive",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "runs": runs,
        "count": len(runs),
    }


# Board summary column order; unknown statuses fall through appended in-order so
# a new hermes status is never silently dropped. `archived` is excluded from the
# board total (it is not active work) but still surfaced as its own column.
_KANBAN_STATUS_ORDER = [
    "triage", "todo", "ready", "scheduled", "running", "review", "blocked", "done", "archived",
]


def _bridge_json(argv: list[str]) -> Any:
    """Run a `--json` bridge command and parse stdout. Raises BridgeError on a
    non-zero hermes exit or unparseable output so callers translate to a 5xx."""
    result = _bridge_run(argv)
    if result.get("code") != 0:
        stderr = (result.get("stderr") or "").strip()[:200]
        raise BridgeError(stderr or f"non-zero exit ({result.get('code')})")
    try:
        return json.loads(result.get("stdout") or "")
    except (json.JSONDecodeError, ValueError) as exc:
        raise BridgeError(f"unparseable JSON output: {exc}")


_KANBAN_CACHE: dict[str, Any] = {"at": 0.0, "payload": None}
_KANBAN_TTL_SECONDS = 60.0


def _kanban_snapshot_uncached() -> dict[str, Any]:
    """One board snapshot: both CLI calls in parallel (each is ~5s of CLI)."""
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=2) as pool:
        stats_f = pool.submit(_bridge_json, ["kanban", "stats", "--json"])
        tasks_f = pool.submit(_bridge_json, ["kanban", "list", "--json"])
        stats = stats_f.result()
        tasks_raw = tasks_f.result()
    by_status = (stats.get("by_status") if isinstance(stats, dict) else None) or {}
    ordered = [s for s in _KANBAN_STATUS_ORDER if s in by_status]
    extra = [s for s in by_status if s not in _KANBAN_STATUS_ORDER]
    columns = [{"status": s, "count": int(by_status.get(s) or 0)} for s in (ordered + extra)]
    total = sum(c["count"] for c in columns if c["status"] != "archived")
    tasks: list[dict[str, Any]] = []
    for t in (tasks_raw if isinstance(tasks_raw, list) else []):
        if not isinstance(t, dict):
            continue
        tasks.append({
            "id": t.get("id"),
            "title": t.get("title"),
            "status": t.get("status"),
            "assignee": t.get("assignee"),
            "priority": t.get("priority"),
            "created_at": t.get("created_at"),
        })
    return {
        "source": "hermes kanban stats/list --json",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "columns": columns,
        "total": total,
        "by_assignee": (stats.get("by_assignee") if isinstance(stats, dict) else None) or {},
        "oldest_ready_age_seconds": stats.get("oldest_ready_age_seconds") if isinstance(stats, dict) else None,
        "tasks": tasks[:50],
        "cached": False,
    }


@app.get("/api/kanban")
def kanban() -> dict[str, Any]:
    """Ops kanban summary, served instantly from cache; a background thread
    refreshes it. The underlying CLI calls take 5-13s, so the endpoint never
    blocks on them: a fresh cache answers immediately, a stale one answers
    immediately with `stale: true` while a refresh runs."""
    now = time.time()
    if _KANBAN_CACHE["payload"] is not None and now - _KANBAN_CACHE["at"] < _KANBAN_TTL_SECONDS:
        payload = dict(_KANBAN_CACHE["payload"])
        payload["cached"] = True
        return payload
    _kick_kanban_refresh()
    if _KANBAN_CACHE["payload"] is not None:
        payload = dict(_KANBAN_CACHE["payload"])
        payload["cached"] = True
        payload["stale"] = True
        return payload
    # first ever request: no board to show yet, so this one call does block
    try:
        payload = _kanban_snapshot_uncached()
    except BridgeError as exc:
        raise HTTPException(status_code=503, detail=f"kanban unavailable — {exc}")
    _KANBAN_CACHE["at"] = time.time()
    _KANBAN_CACHE["payload"] = payload
    return payload


_KANBAN_REFRESHING = threading.Lock()


def _kick_kanban_refresh() -> None:
    """Refresh the board snapshot off the request path (one at a time)."""
    if not _KANBAN_REFRESHING.acquire(blocking=False):
        return

    def _run() -> None:
        try:
            payload = _kanban_snapshot_uncached()
            _KANBAN_CACHE["at"] = time.time()
            _KANBAN_CACHE["payload"] = payload
        except Exception:
            pass  # keep serving the last good board
        finally:
            _KANBAN_REFRESHING.release()

    threading.Thread(target=_run, daemon=True).start()


# ---------------------------------------------------------------------------
# System read surface (Slice 2a) — CLI-bridge backed. The "understand the
# system" tab: what capabilities the agent has (skills / plugins / MCP
# connectors) and whether it is healthy (`hermes doctor`). All four are
# hermes-CLI-only (no HTTP source), so hub-api reads them through the
# privileged hub-bridge sidecar via _bridge_run and parses the CLI output.
# READ-ONLY this slice: no install/enable/doctor --fix reaches the bridge.
#
# `--json` availability (probed against the live gateway): only `plugins list`
# supports it, so plugins is parsed as JSON and the other three parse the
# rich/plain tables. Honest failures throughout: 503 when the bridge is down,
# 502 when hermes itself errors; an empty result is an honest empty, not faked.
# ---------------------------------------------------------------------------

# Footer of `skills list`: "N hub-installed, N builtin, N local — N enabled, N disabled".
# Authoritative counts (row names truncate at 80 cols; totals here never do).
_SKILLS_FOOTER_RE = re.compile(
    r"(\d+)\s+hub-installed,\s+(\d+)\s+builtin,\s+(\d+)\s+local\s+[—-]+\s+(\d+)\s+enabled,\s+(\d+)\s+disabled"
)


def _parse_skills_list(text: str) -> dict[str, Any]:
    """Parse the `hermes skills list` rich table into counts + category tallies.

    Body rows use the light box char '│' (the header row uses the heavy '┃', so
    it is skipped automatically); columns are Name · Category · Source · Trust ·
    Status. Long names truncate at the default 80-col width — cosmetic only; the
    footer line carries the authoritative totals which we prefer for counts."""
    rows: list[dict[str, Any]] = []
    categories: dict[str, int] = {}
    total = enabled = disabled = builtin = hub = local = None
    for raw in text.splitlines():
        m = _SKILLS_FOOTER_RE.search(raw)
        if m:
            hub, builtin, local, enabled, disabled = (int(m.group(i)) for i in range(1, 6))
            total = hub + builtin + local
            continue
        if "│" not in raw:
            continue
        cells = [c.strip() for c in raw.split("│")]
        # Outer borders yield leading/trailing empties: ['', name, cat, src, trust, status, ''].
        if len(cells) < 7:
            continue
        name, category, source, trust, status = cells[1], cells[2], cells[3], cells[4], cells[5]
        if not name or name == "Name":
            continue
        rows.append({
            "name": name, "category": category or None,
            "source": source, "trust": trust, "status": status,
        })
        cat = category or "uncategorized"
        categories[cat] = categories.get(cat, 0) + 1
    cat_list = sorted(
        ({"name": k, "count": v} for k, v in categories.items()),
        key=lambda c: (-c["count"], c["name"]),
    )
    if total is None:
        total = len(rows)
    return {
        "total": total, "enabled": enabled, "disabled": disabled,
        "builtin": builtin, "hub": hub, "local": local,
        "categories": cat_list, "skills": rows,
    }


@app.get("/api/skills")
def skills() -> dict[str, Any]:
    """Installed skills from `hermes skills list` via the CLI-bridge: total +
    enabled/disabled counts, per-category tallies, and the row list. 503 when the
    bridge is down, 502 when hermes errors; an empty catalogue is an honest empty."""
    try:
        result = _bridge_run(["skills", "list"])
    except BridgeError as exc:
        raise HTTPException(status_code=503, detail=f"skills unavailable — {exc}")
    if result.get("code") != 0:
        stderr = (result.get("stderr") or "").strip()[:200]
        raise HTTPException(status_code=502, detail=f"hermes skills list failed: {stderr or 'non-zero exit'}")
    parsed = _parse_skills_list(result.get("stdout") or "")
    return {
        "source": "hermes skills list",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        **parsed,
    }


@app.get("/api/plugins")
def plugins() -> dict[str, Any]:
    """Plugins from `hermes plugins list --json` via the CLI-bridge (the one
    system command with a --json mode). Returns total + enabled counts and the
    plugin list with an `enabled` flag. 503 bridge-down, 502 on hermes error."""
    try:
        data = _bridge_json(["plugins", "list", "--json"])
    except BridgeError as exc:
        raise HTTPException(status_code=503, detail=f"plugins unavailable — {exc}")
    items: list[dict[str, Any]] = []
    for p in (data if isinstance(data, list) else []):
        if not isinstance(p, dict):
            continue
        status = str(p.get("status") or "")
        is_enabled = status.strip().lower() == "enabled"
        items.append({
            "name": p.get("name"),
            "status": status or None,
            "version": p.get("version"),
            "description": p.get("description"),
            "source": p.get("source"),
            "enabled": is_enabled,
        })
    return {
        "source": "hermes plugins list --json",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total": len(items),
        "enabled": sum(1 for p in items if p["enabled"]),
        "plugins": items,
    }


def _parse_mcp_list(text: str) -> list[dict[str, Any]]:
    """Parse the fixed-width `hermes mcp list` table into connector rows.

    The '────' divider under the header defines the column spans; each data row
    below it is sliced by those spans (the final Status column runs to line end
    so its '✓ enabled' glyph is never clipped)."""
    lines = text.splitlines()
    div_idx = None
    for i, ln in enumerate(lines):
        stripped = ln.strip()
        if stripped and set(stripped) <= {"─", " "}:
            div_idx = i
            break
    if div_idx is None:
        return []
    divider = lines[div_idx]
    spans: list[tuple[int, int]] = []
    start: int | None = None
    for i, ch in enumerate(divider):
        if ch == "─":
            if start is None:
                start = i
        elif start is not None:
            spans.append((start, i))
            start = None
    if start is not None:
        spans.append((start, len(divider)))
    if not spans:
        return []
    servers: list[dict[str, Any]] = []
    for ln in lines[div_idx + 1:]:
        if not ln.strip():
            continue
        cols: list[str] = []
        for idx, (a, b) in enumerate(spans):
            # Last column extends to end of line (status text can overrun its span).
            seg = ln[a:] if idx == len(spans) - 1 else ln[a:b]
            cols.append(seg.strip())
        name = cols[0] if cols else ""
        if not name:
            continue
        status = cols[3] if len(cols) > 3 else ""
        low = status.lower()
        is_enabled = "enabled" in low and "not enabled" not in low and "disabled" not in low
        servers.append({
            "name": name,
            "transport": cols[1] if len(cols) > 1 else None,
            "tools": cols[2] if len(cols) > 2 else None,
            "status": status.replace("✓", "").replace("✗", "").strip() or None,
            "enabled": is_enabled,
        })
    return servers


@app.get("/api/mcp")
def mcp() -> dict[str, Any]:
    """MCP connectors from `hermes mcp list` via the CLI-bridge: name, transport,
    tool scope, and enabled state. 503 bridge-down, 502 on hermes error; no
    connectors configured is an honest empty list."""
    try:
        result = _bridge_run(["mcp", "list"])
    except BridgeError as exc:
        raise HTTPException(status_code=503, detail=f"mcp unavailable — {exc}")
    if result.get("code") != 0:
        stderr = (result.get("stderr") or "").strip()[:200]
        raise HTTPException(status_code=502, detail=f"hermes mcp list failed: {stderr or 'non-zero exit'}")
    servers = _parse_mcp_list(result.get("stdout") or "")
    return {
        "source": "hermes mcp list",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "count": len(servers),
        "enabled": sum(1 for s in servers if s["enabled"]),
        "servers": servers,
    }


# --- Connectors (providers + MCP) — the Hub-side OAuth/credential status view --------------
# WHY THIS EXISTS. The Hermes dashboard's OAuth routes (/api/providers/oauth/*) are
# localhost + session-token gated and 404 over the tailnet (verified against the live
# gateway), so provider connect CANNOT be proxied and CANNOT run from the dashboard remotely.
# The Hub routes around that: it reads connector STATE through the CLI-bridge and drives the
# actual CONNECT through the Hub's Terminal (the interactive PTY the dashboard lacks).
#
# CONNECT MECHANISM (investigated against hermes 0.18.0 source + live runs — see the PHASE-1
# report): every provider OAuth flow (`hermes auth add <provider>`) and every MCP reauth
# (`hermes mcp reauth <name>`) is a SINGLE INTERACTIVE process:
#   • device-code providers (nous, openai-codex, minimax-oauth) print a user_code + URL then
#     poll the token endpoint IN-PROCESS for up to 15 min and persist ONLY at the end;
#   • loopback-PKCE providers (anthropic, xai-oauth) spin up a 127.0.0.1 callback listener.
# `hermes auth add` has NO start-then-poll split, and `hermes auth status` only REPORTS
# logged-in/out — it does not drive/complete a flow. So a native in-Hub start/poll is NOT
# feasible; there are deliberately NO oauth.start / oauth.poll / mcp.reauth write actions.
# The honest, working path is Terminal-launch: the Connectors page deep-links the Hub
# Terminal with the connect command pre-filled. This endpoint is therefore READ-ONLY.

# Providers the Hub surfaces a connect affordance for. `flow` tells the frontend what the
# connect command does (all are Terminal-driven); `connect_cmd` is what to run in the PTY.
#   "device-code"    → prints a user_code + URL, polls in-process (open URL on any device)
#   "oauth-loopback" → browser + 127.0.0.1 callback (needs a browser on the gateway host)
#   "api-key"        → `hermes auth add <id> --api-key …`, the one non-interactive path
_CONNECTOR_CATALOG: list[dict[str, str]] = [
    {"id": "anthropic", "name": "Anthropic (Claude)", "flow": "oauth-loopback"},
    {"id": "openrouter", "name": "OpenRouter", "flow": "api-key"},
    {"id": "nous", "name": "Nous Portal", "flow": "device-code"},
    {"id": "openai-codex", "name": "OpenAI Codex", "flow": "device-code"},
    {"id": "xai-oauth", "name": "xAI Grok", "flow": "oauth-loopback"},
    {"id": "minimax-oauth", "name": "MiniMax", "flow": "device-code"},
]

# Header of an `auth list` provider group: "anthropic (1 credentials):".
_AUTH_GROUP_RE = re.compile(r"^(\S+)\s+\((\d+)\s+credential")


def _parse_auth_list(text: str) -> dict[str, dict[str, Any]]:
    """Parse `hermes auth list` into {provider: {count, credentials:[…]}}.

    Group headers are flush-left ("anthropic (1 credentials):"); credential rows are
    indented and start with "#<idx>  <label>  <type>  <source> [←]" where the trailing
    ← marks the active credential. Robust to spacing; unparsed lines are ignored."""
    providers: dict[str, dict[str, Any]] = {}
    cur: str | None = None
    for raw in text.splitlines():
        if not raw.strip():
            continue
        indented = raw[:1].isspace()
        s = raw.strip()
        if not indented:
            m = _AUTH_GROUP_RE.match(s)
            if m:
                cur = m.group(1)
                providers[cur] = {"count": int(m.group(2)), "credentials": []}
            else:
                cur = None
            continue
        if cur is None or not s.startswith("#"):
            continue
        active = "←" in s
        toks = s.replace("←", "").split()
        providers[cur]["credentials"].append({
            "index": toks[0].lstrip("#") if toks else None,
            "label": toks[1] if len(toks) > 1 else None,
            "type": toks[2] if len(toks) > 2 else None,
            "active": active,
        })
    return providers


def _parse_auth_status(text: str) -> dict[str, Any]:
    """Parse `hermes auth status <provider>` ("<p>: logged in" / "logged out (…)").

    Returns {connected: bool|None, detail: str|None}. `connected` is None when the line
    doesn't match either state (kept honest rather than guessed)."""
    s = (text or "").strip()
    if not s:
        return {"connected": None, "detail": None}
    line = s.splitlines()[0].strip()
    low = line.lower()
    if "logged in" in low:
        connected: bool | None = True
    elif "logged out" in low:
        connected = False
    else:
        connected = None
    detail = line.split(":", 1)[1].strip() if ":" in line else line
    return {"connected": connected, "detail": detail or None}


@app.get("/api/connectors")
def connectors() -> dict[str, Any]:
    """Connector status for the Connectors page: pooled provider credentials
    (`hermes auth list`) + per-provider OAuth state (`hermes auth status`) +
    MCP servers (`hermes mcp list`), all via the CLI-bridge.

    READ-ONLY. The connect itself is Terminal-driven (see the module note above):
    `connect: "terminal"` tells the frontend to deep-link the Hub Terminal with each
    row's `connect_cmd` / `reauth_cmd`. 503 when the bridge is down; a provider whose
    status probe fails degrades to a null detail rather than failing the whole view."""
    try:
        listing = _bridge_run(["auth", "list"])
    except BridgeError as exc:
        raise HTTPException(status_code=503, detail=f"connectors unavailable — {exc}")
    auth_map = _parse_auth_list(listing.get("stdout") or "") if listing.get("code") == 0 else {}

    catalog_by_id = {c["id"]: c for c in _CONNECTOR_CATALOG}
    # Catalog order first, then any extra provider that actually has credentials.
    provider_ids = [c["id"] for c in _CONNECTOR_CATALOG]
    provider_ids += [p for p in auth_map if p not in catalog_by_id]

    providers: list[dict[str, Any]] = []
    for pid in provider_ids:
        creds_info = auth_map.get(pid, {})
        credentials = creds_info.get("credentials", [])
        count = creds_info.get("count", len(credentials))
        meta = catalog_by_id.get(pid)
        has_api_key = any((c.get("type") or "").startswith("api") for c in credentials)
        flow = meta["flow"] if meta else ("api-key" if has_api_key else "oauth")
        # How the frontend should drive "Connect" for THIS provider:
        #   "native"   → device-code: POST /api/connectors/{id}/connect then poll
        #                /api/connectors/{id}/oauth-status (no Terminal needed).
        #   "terminal" → loopback-PKCE: needs a 127.0.0.1 callback, run in the Terminal.
        #   "api-key"  → paste a key (the key form / Terminal), not an OAuth flow.
        if pid in _DEVICE_CODE_PROVIDERS:
            connect = "native"
        elif flow == "api-key":
            connect = "api-key"
        else:
            connect = "terminal"
        # `connected` is derived from the `auth list` credential count — we dropped the
        # per-provider `auth status` probe (6 sequential docker-execs cost ~16s/page-load).
        providers.append({
            "id": pid,
            "name": meta["name"] if meta else pid,
            "flow": flow,
            "connect": connect,
            "connected": count > 0,
            "credentials": credentials,
            "detail": None,
            "connect_cmd": f"hermes auth add {pid}",
        })

    mcp_rows: list[dict[str, Any]] = []
    try:
        ml = _bridge_run(["mcp", "list"])
        if ml.get("code") == 0:
            for s in _parse_mcp_list(ml.get("stdout") or ""):
                mcp_rows.append({
                    "name": s["name"],
                    "connected": s["enabled"],
                    "transport": s["transport"],
                    "status": s["status"],
                    "reauth_cmd": f"hermes mcp reauth {s['name']}",
                })
    except BridgeError:
        pass  # MCP view degrades to empty rather than failing the provider view

    return {
        "source": "hermes auth list + mcp list",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        # Per-provider `connect` (native|terminal|api-key) supersedes this; kept for
        # back-compat with clients that read a single top-level connect hint.
        "connect": "terminal",
        "providers": providers,
        "mcp": mcp_rows,
    }


# --- Native device-code OAuth (Phase 1) — connect a provider WITHOUT the Terminal ----------
# The Terminal-launch connect path is dead (ttyd cannot be pasted into), so for the three
# device-code providers the Hub drives the login itself: POST .../connect launches
# `hermes auth add <provider> --no-browser` detached inside the gateway (via the privileged
# bridge), and the client polls .../oauth-status until a verification URL + user_code appear,
# then until the provider reports the credential persisted (or the flow fails/expires).
#
# GATING. Whoever approves a device code on the provider's site decides whose account the
# agent is logged into, and the agent then sends that account its prompts. So starting a
# login takes a proof bound to the provider (Face ID, like any other write), and only the
# client that started it gets the poll token that reads its code back: another device on
# the network can neither start a login nor read a code to race the user.

_CONNECT_POLL_TTL_S = 15 * 60
_connect_poll_tokens: dict[str, tuple[str, float]] = {}


class ConnectorStatusRequest(BaseModel):
    poll_token: str


def _require_device_code_provider(provider: str) -> None:
    if provider not in _DEVICE_CODE_PROVIDERS:
        raise HTTPException(status_code=400, detail={
            "code": "unsupported_flow",
            "detail": "native connect is only for device-code providers "
                      "(nous, openai-codex, minimax-oauth); others use the Terminal or API-key form",
        })


def _connector_hash(provider: str) -> str:
    return hashlib.sha256(f"connector:{provider}".encode()).hexdigest()


@app.post("/api/connectors/{provider}/challenge")
def connector_challenge(provider: str) -> dict[str, Any]:
    """A challenge bound to this provider, for the proof that starts its login."""
    _require_device_code_provider(provider)
    try:
        return wa.assertion_options_any("connector", _connector_hash(provider))
    except wa.NoPasskeyError:
        raise HTTPException(
            status_code=412,
            detail={"code": "no_passkey", "detail": "No passkey registered. Enrol in Settings first."},
        )


@app.post("/api/connectors/{provider}/connect")
def connector_connect(provider: str, req: GatedRequest) -> dict[str, Any]:
    """Start a native device-code OAuth login for `provider` (device-code providers only).

    Returns {"stage": "pending", "poll_token"}; the client then polls /oauth-status with
    that token. 400 for a provider that is not device-code (loopback/api-key use the
    Terminal or key form); 403 for a bad proof; 503 when the bridge is down; 502 if the
    login could not be launched."""
    _require_device_code_provider(provider)
    _require_enrolled(req.devicekey_assertion)
    _verify_proof(req, "connector", _connector_hash(provider))
    try:
        result = _bridge_oauth_start(provider)
    except BridgeError as exc:
        raise HTTPException(status_code=503, detail=f"connect unavailable — {exc}")
    if result.get("stage") == "failed":
        raise HTTPException(status_code=502, detail={
            "code": "oauth_start_failed", "detail": result.get("error") or "could not start login",
        })
    token = secrets_mod.token_urlsafe(24)
    _connect_poll_tokens[provider] = (token, time.monotonic() + _CONNECT_POLL_TTL_S)
    return {"stage": result.get("stage", "pending"), "poll_token": token}


@app.post("/api/connectors/{provider}/oauth-status")
def connector_oauth_status(provider: str, req: ConnectorStatusRequest) -> dict[str, Any]:
    """Poll a native device-code login's progress (device-code providers only).

    Returns {"stage": "pending"|"connected"|"failed", "url", "code", "error"}. `url`/`code`
    are the verification link + user_code to open on any device; they are null until Hermes
    prints them (~1s). 403 unless `poll_token` is the one /connect returned for this
    provider, within 15 minutes; 400 for a non-device-code provider; 503 when the bridge
    is down."""
    _require_device_code_provider(provider)
    held = _connect_poll_tokens.get(provider)
    if held is None or time.monotonic() > held[1] or not hmac.compare_digest(
        held[0].encode(), req.poll_token.encode()
    ):
        raise HTTPException(status_code=403, detail={
            "code": "poll_token_invalid", "detail": "Start the login again from this device.",
        })
    try:
        result = _bridge_oauth_status(provider)
    except BridgeError as exc:
        raise HTTPException(status_code=503, detail=f"oauth-status unavailable — {exc}")
    return {
        "stage": result.get("stage", "pending"),
        "url": result.get("url"),
        "code": result.get("code"),
        "error": result.get("error"),
    }


# Doctor check glyphs → normalised status. ✗/✖/× all mean fail.
_DOCTOR_PASS = "✓"
_DOCTOR_WARN = "⚠"
_DOCTOR_FAIL = {"✗", "✖", "×"}


def _parse_doctor(text: str) -> dict[str, Any]:
    """Parse the `hermes doctor` checklist into sections of pass/warn/fail checks.

    '◆ Heading' opens a section; each subsequent line whose first glyph is ✓/⚠/✗
    is a check. Box-border, title, and summary-footer lines have no leading glyph
    and are skipped. A leading variation-selector (⚠️) is stripped off labels."""
    sections: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    for raw in text.splitlines():
        s = raw.strip()
        if not s:
            continue
        if s.startswith("◆"):
            cur = {"name": s[1:].strip(), "checks": []}
            sections.append(cur)
            continue
        ch = s[0]
        if ch == _DOCTOR_PASS:
            status = "pass"
        elif ch == _DOCTOR_WARN:
            status = "warn"
        elif ch in _DOCTOR_FAIL:
            status = "fail"
        else:
            continue
        label = s[1:].lstrip(" ️")
        if cur is None:
            cur = {"name": "General", "checks": []}
            sections.append(cur)
        cur["checks"].append({"status": status, "label": label})
    checks = [c for sec in sections for c in sec["checks"]]
    p = sum(1 for c in checks if c["status"] == "pass")
    w = sum(1 for c in checks if c["status"] == "warn")
    f = sum(1 for c in checks if c["status"] == "fail")
    return {
        "sections": sections,
        "summary": {"pass": p, "warn": w, "fail": f, "total": p + w + f, "ok": f == 0},
    }


@app.get("/api/doctor")
def doctor() -> dict[str, Any]:
    """System health checklist from `hermes doctor` via the CLI-bridge: sections
    of pass/warn/fail checks plus a roll-up summary. READ-ONLY — never `--fix`.
    503 when the bridge is down, 502 when hermes errors; 503 if the output has no
    parseable checks (never a faked all-green)."""
    try:
        result = _bridge_run(["doctor"])
    except BridgeError as exc:
        raise HTTPException(status_code=503, detail=f"doctor unavailable — {exc}")
    # hermes doctor exits non-zero when checks fail; that is still a real report,
    # so we parse regardless and only 502 when there is no parseable output at all.
    parsed = _parse_doctor(result.get("stdout") or "")
    if parsed["summary"]["total"] == 0:
        stderr = (result.get("stderr") or "").strip()[:200]
        raise HTTPException(status_code=503, detail=f"doctor returned no parseable checks{': ' + stderr if stderr else ''}")
    return {
        "source": "hermes doctor",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        **parsed,
    }


# ---------------------------------------------------------------------------
# Control-plane read surfaces (Slice 3) — CLI-bridge backed. Memory provider
# status and DM pairing state are hermes-CLI-only, so both read through the
# hub-bridge via _bridge_run. Their WRITE counterparts (pairing approve/revoke,
# gateway restart/drain) go through the WebAuthn gate at /api/action/apply.
# Honest failures throughout: 503 bridge-down, 502 on a hermes error.
# ---------------------------------------------------------------------------

def _parse_memory_status(text: str) -> dict[str, Any]:
    """Parse `hermes memory status` into {built_in, provider, plugins[]}.

    Layout (see hermes memory status): a `Built-in:` line, a `Provider:` line, then
    an `Installed plugins:` block of `• name  (note)` bullets. Unrecognised lines are
    ignored; a missing block is an honest empty list, never faked."""
    built_in: str | None = None
    provider: str | None = None
    plugins: list[dict[str, Any]] = []
    in_plugins = False
    for raw in text.splitlines():
        s = raw.strip()
        if not s:
            continue
        low = s.lower()
        if low.startswith("built-in:"):
            built_in = s.split(":", 1)[1].strip()
            in_plugins = False
            continue
        if low.startswith("provider:"):
            provider = s.split(":", 1)[1].strip()
            in_plugins = False
            continue
        if low.startswith("installed plugins"):
            in_plugins = True
            continue
        if in_plugins and s.startswith(("•", "-", "*")):
            body = s.lstrip("•-* ").strip()
            m = re.match(r"^(.*?)\s*\((.*)\)\s*$", body)
            if m:
                plugins.append({"name": m.group(1).strip(), "note": m.group(2).strip()})
            elif body:
                plugins.append({"name": body, "note": None})
    return {"built_in": built_in, "provider": provider, "plugins": plugins}


@app.get("/api/memory")
def memory() -> dict[str, Any]:
    """Memory provider status from `hermes memory status` via the CLI-bridge: the
    active built-in/external provider plus the installed memory plugins. 503 when the
    bridge is down, 502 when hermes errors."""
    try:
        result = _bridge_run(["memory", "status"])
    except BridgeError as exc:
        raise HTTPException(status_code=503, detail=f"memory unavailable — {exc}")
    if result.get("code") != 0:
        stderr = (result.get("stderr") or "").strip()[:200]
        raise HTTPException(status_code=502, detail=f"hermes memory status failed: {stderr or 'non-zero exit'}")
    parsed = _parse_memory_status(result.get("stdout") or "")
    return {
        "source": "hermes memory status",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        **parsed,
    }


def _parse_pairing_list(text: str) -> dict[str, Any]:
    """Parse `hermes pairing list` into {pending[], approved[]}.

    Layout (see hermes_cli/pairing.py): section headers `Pending Pairing Requests (N):`
    and `Approved Users (N):`, each followed by a header row + `----` rule, then padded
    rows. Pending cols: Platform Code User-ID Name Age; Approved cols: Platform User-ID
    Name. Empty state ("No pairing data found…") yields two empty lists — honest, never faked."""
    pending: list[dict[str, Any]] = []
    approved: list[dict[str, Any]] = []
    section: str | None = None
    for raw in text.splitlines():
        s = raw.strip()
        if not s:
            continue
        low = s.lower()
        if low.startswith("pending pairing request"):
            section = "pending"
            continue
        if low.startswith("approved user"):
            section = "approved"
            continue
        if low.startswith("no pending") or low.startswith("no approved") or low.startswith("no pairing"):
            continue
        # Skip the column-header row and its dashed rule.
        if s.startswith("Platform") or set(s) <= {"-", " "}:
            continue
        cols = re.split(r"\s{2,}", s)
        if section == "pending" and len(cols) >= 3:
            pending.append({
                "platform": cols[0],
                "code": cols[1],
                "user_id": cols[2],
                "user_name": cols[3] if len(cols) > 3 else None,
                "age": cols[4] if len(cols) > 4 else None,
            })
        elif section == "approved" and len(cols) >= 2:
            approved.append({
                "platform": cols[0],
                "user_id": cols[1],
                "user_name": cols[2] if len(cols) > 2 else None,
            })
    return {"pending": pending, "approved": approved}


@app.get("/api/pairing")
def pairing() -> dict[str, Any]:
    """DM pairing state from `hermes pairing list` via the CLI-bridge: pending pairing
    requests + approved users. Drives the control-plane approve/revoke surface (writes go
    through the WebAuthn gate). 503 bridge-down, 502 on a hermes error; no pairing data is
    an honest empty board, never faked."""
    try:
        result = _bridge_run(["pairing", "list"])
    except BridgeError as exc:
        raise HTTPException(status_code=503, detail=f"pairing unavailable — {exc}")
    if result.get("code") != 0:
        stderr = (result.get("stderr") or "").strip()[:200]
        raise HTTPException(status_code=502, detail=f"hermes pairing list failed: {stderr or 'non-zero exit'}")
    parsed = _parse_pairing_list(result.get("stdout") or "")
    return {
        "source": "hermes pairing list",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "pending": parsed["pending"],
        "approved": parsed["approved"],
        "pending_count": len(parsed["pending"]),
        "approved_count": len(parsed["approved"]),
    }


# --- Chat models (Config model picker) --------------------------------------
# POST /api/chat (the SSE chat proxy) was removed with the Chat tab; this static
# tier list survives because the Config model picker still renders it.


@app.get("/api/chat/models")
def chat_models() -> dict[str, Any]:
    """Selectable agent tiers for the Config model picker. litellm is decommissioned,
    so this is the static direct-provider tier list the Hermes gateway honors
    (anthropic sonnet/opus/haiku + the openrouter worker)."""
    tiers = [
        {"id": "claude-sonnet-5", "label": "claude-sonnet-5"},
        {"id": "claude-opus-4-8", "label": "claude-opus-4-8"},
        {"id": "claude-haiku-4-5", "label": "claude-haiku-4-5"},
        {"id": "openai/gpt-oss-120b", "label": "openai/gpt-oss-120b"},
    ]
    return {"data": tiers}


@app.get("/api/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


# ===========================================================================
# Terminal proxy (Slice 2b). Forwards http + websocket for /terminal/* to the
# host ttyd's UNIX socket — but ONLY with a valid hub_term_session cookie (issued
# by a verified WebAuthn assertion). tailscale serve maps /terminal → hub-api;
# ttyd itself is not network-reachable, so this proxy is the sole path to the shell.
# ===========================================================================
class _UnixHTTPConnection(http.client.HTTPConnection):
    """http.client over a UNIX-domain socket (ttyd binds a socket, not a TCP port)."""

    def __init__(self, sock_path: str, timeout: float = 10.0) -> None:
        super().__init__("localhost", timeout=timeout)
        self._sock_path = sock_path

    def connect(self) -> None:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self._sock_path)
        self.sock = s


# ttyd assets we forward verbatim; only these content types are expected. We copy the
# upstream Content-Type through, defaulting to octet-stream.
def _proxy_ttyd_http(path_with_query: str) -> Response:
    conn = _UnixHTTPConnection(HUB_TTYD_SOCK)
    try:
        conn.request("GET", path_with_query, headers={"Host": "localhost", "Accept": "*/*"})
        resp = conn.getresponse()
        body = resp.read()
        ctype = resp.getheader("Content-Type", "application/octet-stream")
        status = resp.status
        location = resp.getheader("Location")
    except OSError as exc:
        raise HTTPException(status_code=502, detail=f"terminal backend unreachable: {exc}")
    finally:
        conn.close()
    # Forward ttyd's redirect target (dropped before → 302s dead-ended into a black screen).
    headers = {"Location": location} if location else None
    return Response(content=body, status_code=status, media_type=ctype, headers=headers)


@app.get("/terminal")
@app.get("/terminal/{rest:path}")
def terminal_proxy(rest: str = "", hub_term_session: str | None = Cookie(default=None)) -> Response:
    """Serve ttyd's UI/assets/token under /terminal — gated by the session cookie."""
    if not HUB_TTYD_SOCK:
        raise HTTPException(status_code=503, detail="terminal backend not configured")
    if not _term_session_valid(hub_term_session):
        # Same two-state distinction as the chat gate (see chat/session.py
        # `locked_gate_detail`): on a fresh install there is no passkey to
        # "unlock with", so tell the user to enrol rather than to unlock.
        status, detail = locked_gate_detail("terminal")
        raise HTTPException(status_code=status, detail=detail)
    # Preserve the full /terminal-prefixed path (ttyd runs with --base-path /terminal).
    # Request ttyd's index at "/terminal/" (with slash) so it serves 200 directly
    # instead of 302-redirecting "/terminal" → "/terminal/" (which dead-ended blank).
    path = "/terminal/" if not rest else f"/terminal/{rest}"
    return _proxy_ttyd_http(path)


def _origin_key(url: str) -> tuple[str, int | None] | None:
    """(host, port) of an origin or a '//host:port', default ports folded to None."""
    try:
        parts = urllib.parse.urlsplit(url)
        host, port = parts.hostname, parts.port
    except ValueError:
        return None
    if not host:
        return None
    return host.lower(), (None if port in (None, 80, 443) else port)


def _ws_origin_ok(headers) -> bool:
    """Cross-site WebSocket hijacking guard, for every cookie-authenticated socket that
    can act as the user: the terminal (`/terminal/ws`) and Live voice (`/api/live`,
    live_session.py). The same-origin policy does not cover WebSockets, and
    SameSite=Strict on the session cookies only stops cross-SITE pages: every port of
    this host, and every machine in the same tailnet (ts.net is a public suffix, so
    <tailnet>.ts.net is one site), is same-site. A page served from any of them could
    otherwise open these sockets with the user's cookie. Browsers always send Origin on
    a WebSocket handshake; it must name this hub, as the Host the request came in on or
    an entry of HUB_ORIGIN. The app's React Native socket sends the origin of the URL
    it dials, which passes; a client that sends no Origin is not a browser, so a
    hijacking page cannot be one."""
    origin = headers.get("origin")
    if origin is None:
        return True
    if not origin.lower().startswith(("http://", "https://")):
        return False  # "null" (sandboxed frames, file:), extensions, anything odd
    allowed = {_origin_key("//" + headers.get("host", ""))}
    allowed.update(_origin_key(o.strip()) for o in os.environ.get("HUB_ORIGIN", "").split(","))
    key = _origin_key(origin)
    return key is not None and key in allowed


live_session.origin_ok = _ws_origin_ok


@app.websocket("/terminal/ws")
async def terminal_ws(ws: WebSocket) -> None:
    """Bridge the browser <-> ttyd websocket (subprotocol 'tty') over the unix socket.
    Rejects the upgrade unless the hub_term_session cookie is valid and the Origin, when
    there is one, is this hub's."""
    token = ws.cookies.get("hub_term_session")
    if not HUB_TTYD_SOCK or not _term_session_valid(token) or not _ws_origin_ok(ws.headers):
        await ws.close(code=1008)  # policy violation
        return
    # Preserve ttyd's 'tty' subprotocol through the negotiation.
    offered = ws.scope.get("subprotocols") or []
    subprotocol = "tty" if "tty" in offered else None
    await ws.accept(subprotocol=subprotocol)

    try:
        upstream = await _ttyd_ws_connect()
    except Exception:  # noqa: BLE001 — backend down / handshake failed
        await ws.close(code=1011)  # internal error
        return

    async def client_to_upstream() -> None:
        try:
            while True:
                msg = await ws.receive()
                if msg.get("type") == "websocket.disconnect":
                    break
                if msg.get("text") is not None:
                    await upstream.send(msg["text"])
                elif msg.get("bytes") is not None:
                    await upstream.send(msg["bytes"])
        except (WebSocketDisconnect, RuntimeError, websockets.WebSocketException):
            pass

    async def upstream_to_client() -> None:
        try:
            async for frame in upstream:
                if isinstance(frame, (bytes, bytearray)):
                    await ws.send_bytes(bytes(frame))
                else:
                    await ws.send_text(frame)
        except (websockets.WebSocketException, RuntimeError):
            pass

    t1 = asyncio.create_task(client_to_upstream())
    t2 = asyncio.create_task(upstream_to_client())
    try:
        await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in (t1, t2):
            t.cancel()
        await upstream.close()
        try:
            await ws.close()
        except RuntimeError:
            pass


async def _ttyd_ws_connect():
    """Open the ttyd websocket over its unix socket with the 'tty' subprotocol."""
    return await websockets.unix_connect(
        HUB_TTYD_SOCK,
        f"ws://localhost{HUB_TTYD_BASE}/ws",
        subprotocols=["tty"],
        max_size=None,
    )


# --- Push notification devices ------------------------------------------------
# The brief pipeline (brief_notify.py) composes and sends the
# one notification a morning earns; hub-api's only job is holding the tokens it
# sends to. They live beside the other briefing state, written here as uid 1000
# and read by the pipeline as uid 1001 — the same crossing briefing_dismissals
# already makes.
#
# Registration is WebAuthn/device-key gated exactly like /api/config/topics, and
# the challenge is bound to the token itself, so a captured proof cannot be
# replayed to point the user's notifications at a different device. An Expo push
# token is a capability — anyone holding it can push to his phone — so it is
# never returned by the listing.
PUSH_TOKENS_FILE = Path(os.environ.get("HUB_PUSH_TOKENS", "/data/hub/data/push_tokens.json"))
_EXPO_TOKEN_RE = re.compile(r"^ExponentPushToken\[[A-Za-z0-9_-]{1,64}\]$")


class PushRegisterBody(BaseModel):
    token: str
    label: str | None = None


class PushChallengeRequest(PushRegisterBody):
    pass


class PushRegisterRequest(PushRegisterBody, GatedRequest):
    pass


def _push_hash(token: str, label: str | None) -> str:
    return hashlib.sha256(
        json.dumps({"token": token, "label": label or ""}, sort_keys=True).encode()
    ).hexdigest()


def _push_validate(body: PushRegisterBody) -> tuple[str, str]:
    token = body.token.strip()
    if not _EXPO_TOKEN_RE.match(token):
        raise HTTPException(status_code=400,
                            detail={"code": "bad_request", "detail": "not an Expo push token"})
    return token, (body.label or "iPhone").strip()[:40]


def _push_read() -> list[dict[str, Any]]:
    try:
        data = json.loads(PUSH_TOKENS_FILE.read_text())
    except (OSError, ValueError):
        return []
    tokens = data.get("tokens") if isinstance(data, dict) else None
    return [t for t in tokens if isinstance(t, dict)] if isinstance(tokens, list) else []


def _push_write(tokens: list[dict[str, Any]]) -> None:
    PUSH_TOKENS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = PUSH_TOKENS_FILE.with_name(PUSH_TOKENS_FILE.name + ".tmp")
    tmp.write_text(json.dumps({"tokens": tokens}, indent=2) + "\n")
    tmp.replace(PUSH_TOKENS_FILE)


@app.post("/api/push/challenge")
def push_challenge(req: PushChallengeRequest) -> dict[str, Any]:
    token, label = _push_validate(req)
    try:
        return wa.assertion_options_any("push", _push_hash(token, label))
    except wa.NoPasskeyError:
        raise HTTPException(
            status_code=412,
            detail={"code": "no_passkey", "detail": "No passkey registered. Enrol in Settings first."},
        )


@app.post("/api/push/register")
def push_register(req: PushRegisterRequest) -> dict[str, Any]:
    """Register this device for the morning brief. Re-registering the same token
    refreshes its timestamp rather than adding a duplicate — the app calls this
    on every launch, which is also how a token Expo has retired gets replaced."""
    _require_enrolled(req.devicekey_assertion)
    token, label = _push_validate(req)
    _verify_proof(req, "push", _push_hash(token, label))
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    tokens = [t for t in _push_read() if t.get("token") != token]
    tokens.append({"token": token, "label": label, "registered_at": now})
    _push_write(tokens)
    return {"status": "registered", "label": label, "devices": len(tokens)}


@app.get("/api/push/devices")
def push_devices() -> dict[str, Any]:
    """What would be notified tomorrow morning. The tokens themselves are a
    capability and are never returned — only what the user needs to recognise a
    device he no longer owns."""
    return {"devices": [{"label": t.get("label", ""),
                         "registered_at": t.get("registered_at", "")}
                        for t in _push_read()]}


# Reject anything else. ADR 011 amendment: POST allowlist extends to
# /api/ha/challenge and /api/ha/apply, both gated by per-action WebAuthn
# (ha_actions.py). Slice 2b adds /api/passkey/* (enrolment) and /api/action/*
# (the generalized write gate — assertion-verified before any bridge write).
# All other POSTs still fail closed with 405.
POST_ALLOWLIST_PREFIXES = (
    # Calendar "sync now" (2026-09-30): leaves a request file a host job picks up
    # within a minute; a repeat while one is pending is a no-op (hub_calendar.py).
    "/api/calendar/sync",
    "/api/terminal/",
    "/api/passkey/",
    # Native-app pairing (2026-09-10): /register is authorized by the one-time enrol
    # code a WebAuthn-gated action minted; /status is a GET.
    "/api/devicekey/",
    "/api/action/",
    "/api/ha/challenge",
    "/api/ha/apply",
    # Native device-code OAuth: /challenge, then /connect behind a proof bound to the
    # provider, then /oauth-status with the poll token only /connect hands out.
    "/api/connectors/",
    # iMessage: /drafts/mirror is the gateway recording a draft it made (platform
    # key, chat/platform.py); /send/{id} is gated by the per-draft HMAC token minted
    # at draft time. Creating a draft is /api/chat/imessage/draft (chat cookie or
    # platform key, covered by "/api/chat/" below).
    "/api/imessage/drafts/mirror",
    "/api/imessage/send/",
    # Telegram topic routing (2026-08-04): challenge + apply, both WebAuthn-gated
    # exactly like /api/action/* (challenge bound to the payload hash, purpose
    # "topics"); the apply only writes the pending_sync config file.
    "/api/config/topics",
    # Decision Inbox (2026-08-04): challenge + answer, both WebAuthn/device-key
    # gated exactly like /api/config/topics (challenge bound to the {id, option_key,
    # note} hash, purpose "decisions"); the answer rewrites one decision file
    # atomically and appends to the responses.jsonl ledger, and for an iMessage
    # draft card resolves the draft (sends or discards) after the proof verifies.
    "/api/decisions/",
    # Briefing dismiss/snooze (2026-08-08): ungated by design.
    # It writes one presentation preference — which cards the user has hidden on his
    # own briefing — and nothing else: no external call, no secret, no bridge
    # write, and every action is reversible via Undo. Both inputs are strictly
    # validated (item_id = 12 hex, return_to = an own-briefing path), so the
    # worst a poisoned briefing page could do with its relaxed allow-forms CSP
    # is hide one of the user's own cards, and only if he clicks it — script-src
    # stays 'none', so nothing can auto-submit.
    #
    # This is a PREFIX match, so it already covers the native app's
    # /api/briefing/dismiss.json (2026-09-16) — no second entry needed, and the
    # two endpoints write the same one file. The .json path additionally
    # requires the per-item HMAC the generator minted (Ruling 57).
    "/api/briefing/dismiss",
    # Briefing "useful" signal (2026-09-16): same store, same HMAC gate as
    # dismiss.json, but a different prefix, so it needs its own entry. Appends
    # one line to the feedback ledger; no other write.
    "/api/briefing/useful.json",
    # Briefing note ("tell the brief about this", Ruling 146): same HMAC gate,
    # its own prefix. Appends one line to the feedback ledger; never deduped.
    "/api/briefing/note.json",
    # Briefing standing rules (Ruling 146): read is ungated (tailnet-only,
    # like /api/brief); the add/remove apply below is device-key/WebAuthn
    # gated exactly like /api/config/topics — this prefix covers both
    # /api/briefing/rules.json (apply) and /api/briefing/rules.json/challenge.
    "/api/briefing/rules.json",
    # Hub chat, phase 2 (2026-09-16): the gateway's Hub adapter delivering a message,
    # media, or its live slash-command catalog. A shared bearer key (hmac.compare_digest),
    # not WebAuthn — this is container-to-container, not a human write. See
    # chat/platform.py. Nothing under /api/chat/approval/* is reachable with this key.
    "/api/platform/hub/",
    # Hub chat, phase 2, second slice (2026-09-16): the user's own side of the chat surface.
    # /api/chat/{challenge,session,logout} are the cookie gate — WebAuthn/device-key
    # exactly like /api/terminal/*, see chat/session.py for why the cookie is scoped to
    # this prefix instead. /api/chat/threads/{id}/read is a cheap Hub-owned-state write
    # gated only by that cookie (in-handler, chat/routes.py) — same posture as
    # /api/briefing/dismiss above, never WebAuthn. /api/chat/imessage/draft (app.py)
    # takes that cookie or the platform key, and is rate-limited.
    "/api/chat/",
    # Hub chat approvals (2026-09-16, VERDICT-V2 §4.3, T3 in §7): a FRESH signed
    # WriteRequest per decision batch, purpose "approval" — NEVER the hourly
    # hub_chat_session cookie above. Already covered by the broader "/api/chat/" entry
    # (startswith), but given its own line since it is the one write surface in this
    # package gated by WebAuthn/device-key rather than the cookie, same as /api/action/
    # and /api/decisions/ each getting their own line despite no other overlap. See
    # chat/approval.py for the choice-constraining re-derivation T3 requires.
    "/api/chat/approval/",
    # Brief push devices (2026-09-22): challenge + register, both gated exactly
    # like /api/config/topics with the challenge bound to the token itself.
    # Writes only the push-token file the brief pipeline reads.
    "/api/push/",
)


@app.middleware("http")
async def reject_non_get_outside_auth(request, call_next):
    if request.method not in ("GET", "POST"):
        return JSONResponse({"detail": "method not allowed"}, status_code=405)
    if request.method == "POST" and not any(request.url.path.startswith(p) for p in POST_ALLOWLIST_PREFIXES):
        return JSONResponse(
            {"detail": "method not allowed for this path"},
            status_code=405,
        )
    return await call_next(request)


# --- Host allowlist (DNS-rebinding defence) ------------------------------------
# The server binds loopback and most reads are unauthenticated, so the network is the
# boundary. DNS rebinding crosses it: a web page on an attacker's domain re-resolves
# that domain to 127.0.0.1, and the victim's browser then talks to this server as
# "same origin" — but still sends the attacker's hostname in Host. Refusing every Host
# this deployment did not name closes that hole, for HTTP and WebSocket alike.
#
# Allowed: the hostnames in HUB_ORIGIN (comma list), localhost / 127.0.0.1 / ::1 (local
# probes, the Docker healthcheck), and HUB_ALLOWED_HOSTS (comma list) — e.g. the
# https name a mesh or proxy serves this hub on, when HUB_ORIGIN is not set to it.
def _host_only(value: str) -> str:
    """'Hub.Example.com:8443' -> 'hub.example.com'; '[::1]:8090' -> '::1'. Empty on junk."""
    value = value.strip().lower()
    if value.startswith("["):
        end = value.find("]")
        return value[1:end] if end > 0 else ""
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value


def _allowed_hosts() -> frozenset[str]:
    hosts = {"localhost", "127.0.0.1", "::1"}
    for origin in os.environ.get("HUB_ORIGIN", "").split(","):
        try:
            host = urllib.parse.urlsplit(origin.strip()).hostname
        except ValueError:
            host = None
        if host:
            hosts.add(host.lower())
    for entry in os.environ.get("HUB_ALLOWED_HOSTS", "").split(","):
        host = _host_only(entry)
        if host:
            hosts.add(host)
    return frozenset(hosts)


ALLOWED_HOSTS = _allowed_hosts()
_REJECTED_HOSTS_LOGGED: set[str] = set()


class HostAllowlistMiddleware:
    """Pure ASGI (not @app.middleware("http")) so it also covers WebSocket upgrades.
    An unlisted Host gets 421 Misdirected Request; a WebSocket is closed (1008) before
    it is accepted."""

    def __init__(self, asgi_app) -> None:
        self.app = asgi_app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        raw = next((v for k, v in scope.get("headers") or () if k == b"host"), b"")
        host = _host_only(raw.decode("latin-1"))
        if host in ALLOWED_HOSTS:
            return await self.app(scope, receive, send)
        if host not in _REJECTED_HOSTS_LOGGED and len(_REJECTED_HOSTS_LOGGED) < 32:
            _REJECTED_HOSTS_LOGGED.add(host)
            logger.warning("refused a request for Host %r — add it to HUB_ALLOWED_HOSTS "
                           "(or HUB_ORIGIN) if this hub is meant to answer to it", host[:100])
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        response = JSONResponse(
            {"detail": {"code": "host_not_allowed",
                        "detail": "This hub does not answer to that hostname. Add it to "
                                  "HUB_ALLOWED_HOSTS (or HUB_ORIGIN) and start the server again so "
                                  "it reads the change (Docker: ./install.sh --restart)."}},
            status_code=421,
        )
        await response(scope, receive, send)


app.add_middleware(HostAllowlistMiddleware)
