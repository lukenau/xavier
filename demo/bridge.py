#!/usr/bin/env python3
"""demo/bridge.py — a stub hub-bridge + fake-gateway for the Xavier demo.

Serves canned, entirely FICTIONAL data shaped exactly the way hub-api's parsing
code expects, so the Hub UI can be demonstrated with ZERO real personal data.
Nothing here touches the network beyond its own loopback socket, runs no
subprocess, reads no secret and opens no docker socket.

It implements every endpoint hub-api reaches over HUB_BRIDGE_URL:

  POST /run           {"argv": [...]}            -> {"stdout", "stderr", "code"}
  POST /run-write     {"argv": [...]}            -> {"stdout", "stderr", "code"}
  POST /spend         {cutoff_epoch, split_epoch, granularity}
                                                 -> {"summary", "models", "timeseries", ...}
  GET  /config-raw                               -> {"config": <masked tree>}
  POST /cron-logs     {"limit": n}               -> {"runs": [...]}
  GET  /cron-costs                               -> {"window_days", "jobs": [...]}
  POST /oauth-start   {"provider": p}            -> {"stage": "pending"}
  GET  /oauth-status?provider=p                  -> {"stage", "url", "code", "error"}

It also stands in for the Hermes gateway itself (HERMES_API_BASE points here)
so /api/vitals, /api/sessions and the session transcript render fake rows:

  GET /health, /health/detailed
  GET /api/sessions, /api/sessions/{id}, /api/sessions/{id}/messages

Bind is loopback-only (127.0.0.1:8096). Run it with:
    python3 demo/bridge.py            # defaults
    PORT=8096 python3 demo/bridge.py
"""
from __future__ import annotations

import json
import os
import socketserver
import sys
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

HOST = os.environ.get("DEMO_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("DEMO_BRIDGE_PORT", "8096"))
TZ = ZoneInfo(os.environ.get("HUB_TZ") or "UTC")
DEMO_ROOT = os.environ.get("DEMO_ROOT") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

# All names, ids, projects and numbers below are invented for the demo.


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat()


def _iso_z(dt: datetime) -> str:
    return dt.replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# `hermes config show` output (curated summary -> /api/config groups)
# ---------------------------------------------------------------------------
CONFIG_SHOW = """\

  Hermes configuration (demo)

◆ Model
  Default: claude-sonnet-5
  Provider: anthropic

◆ Auxiliary Models (overrides)
  vision     provider=openrouter, model=google/gemini-2.5-flash
  summarizer provider=anthropic, model=claude-haiku-4-5

◆ Display
  Theme: dark
  Streaming: true

◆ Terminal
  Shell: /bin/bash

◆ Timezone
  Timezone: UTC

◆ Context Compression
  Enabled: true
  Threshold: 0.80

◆ Messaging Platforms
  Discord: enabled
  Telegram: disabled

◆ API Keys
  ANTHROPIC_API_KEY      masked
  OPENROUTER_API_KEY     masked
  OPENROUTER_MGMT_KEY    (not set)

◆ Paths
  Data dir: {demo_root}
  Workspace: {demo_root}/workspace

────────────────────────────────────────────────────────────
  Run `hermes config set <key> <value>` to change a value.
"""


# ---------------------------------------------------------------------------
# `hermes cron list --all` (block text -> /api/cron rows)
# ---------------------------------------------------------------------------
def cron_list_text() -> str:
    return """\

  Cron jobs (demo)

  demo-briefing [active]
    Name:      demo-briefing
    Schedule:  30 7 * * *
    Next run:  2026-10-05T07:30:00+00:00
    Last run:  2026-10-04T07:30:00+00:00
    Deliver:   discord:brief
    Repeat:    forever

  demo-healthcheck [active]
    Name:      demo-healthcheck
    Schedule:  */15 * * * *
    Next run:  2026-10-04T18:15:00+00:00
    Last run:  2026-10-04T18:00:00+00:00
    Deliver:   discord:ops
    Repeat:    forever

  demo-nightly-backup [paused]
    Name:      demo-nightly-backup
    Schedule:  0 3 * * *
    Next run:  —
    Last run:  2026-10-03T03:00:00+00:00
    Deliver:   local
    Repeat:    forever
    Mode:      no-agent (script: demo-backup.sh)

  demo-inbox-sweep [active]
    Name:      demo-inbox-sweep
    Schedule:  0 */2 * * *
    Next run:  2026-10-04T20:00:00+00:00
    Last run:  2026-10-04T18:00:00+00:00
    Deliver:   discord:ops
    Repeat:    forever
"""


def cron_costs_payload() -> dict:
    return {
        "window_days": 7,
        "jobs": [
            {
                "id": "demo-briefing",
                "name": "demo-briefing",
                "last_run": {"ts": _iso_z(_now() - timedelta(hours=10)), "cost_usd": 0.412, "tokens": 184000, "status": "ok"},
                "week": {
                    "cost_usd": 2.87, "tokens": 1_290_000, "runs": 7, "unknown_runs": 0,
                    "by_day": {
                        d: {"cost_usd": round(0.38 + i * 0.02, 3), "tokens": 180000 + i * 4000, "runs": 1}
                        for i, d in enumerate((_now() - timedelta(days=n)).strftime("%Y-%m-%d") for n in range(7, 0, -1))
                    },
                },
            },
            {
                "id": "demo-healthcheck",
                "name": "demo-healthcheck",
                "last_run": {"ts": _iso_z(_now() - timedelta(minutes=15)), "cost_usd": 0.0, "tokens": 0, "status": "ok"},
                "week": {"cost_usd": 0.0, "tokens": 0, "runs": 672, "unknown_runs": 0, "by_day": {}},
            },
            {
                "id": "demo-inbox-sweep",
                "name": "demo-inbox-sweep",
                "last_run": {"ts": _iso_z(_now() - timedelta(hours=1)), "cost_usd": 0.096, "tokens": 45000, "status": "ok"},
                "week": {"cost_usd": 0.71, "tokens": 320000, "runs": 84, "unknown_runs": 2, "by_day": {}},
            },
            {
                "id": "demo-nightly-backup",
                "name": "demo-nightly-backup",
                # A run whose ledger cost is unknown carries null, never a fake $0.
                "last_run": {"ts": _iso_z(_now() - timedelta(days=1, hours=5)), "cost_usd": None, "tokens": None, "status": "unknown"},
                "week": {"cost_usd": None, "tokens": None, "runs": 3, "unknown_runs": 3, "by_day": {}},
            },
        ],
    }


def cron_logs_payload(limit: int) -> dict:
    base = _now()
    fmt = "%Y-%m-%d %H:%M:%S"
    rows = [
        ("demo-briefing", "demo-briefing", base - timedelta(hours=10), "agent", "success",
         "Built today's briefing: 6 items (3 now, 2 today, 1 week). Sources: demo-mail, demo-calendar."),
        ("demo-inbox-sweep", "demo-inbox-sweep", base - timedelta(hours=1), "agent", "success",
         "Swept 14 messages, filed 3, flagged 1 for the approvals queue."),
        ("demo-healthcheck", "demo-healthcheck", base - timedelta(minutes=15), "script", "success",
         "all demo services responding (6/6 up)."),
        ("demo-healthcheck", "demo-healthcheck", base - timedelta(minutes=30), "script", "success",
         "all demo services responding (6/6 up)."),
        ("demo-nightly-backup", "demo-nightly-backup", base - timedelta(days=1, hours=5), "script", "failed",
         "demo-backup: target volume 'demo-archive' not mounted; skipped."),
        ("demo-briefing", "demo-briefing", base - timedelta(days=1, hours=10), "agent", "success",
         "Built yesterday's briefing: 5 items."),
    ]
    runs = [
        {
            "job_id": jid, "name": name,
            "run_time": ts.strftime(fmt),
            "mode": mode, "status": status,
            "output": out, "truncated": False,
        }
        for (jid, name, ts, mode, status, out) in rows
    ]
    return {"runs": runs[: max(1, min(200, limit))], "count": len(runs[: max(1, min(200, limit))])}


# ---------------------------------------------------------------------------
# `hermes skills list` (rich table -> /api/skills)
# ---------------------------------------------------------------------------
SKILLS_TEXT = """\

  Skills (demo)

┃ Name                    ┃ Category      ┃ Source ┃ Trust   ┃ Status  ┃
│ demo-briefing           │ productivity  │ hub    │ trusted │ enabled │
│ demo-package-tracking   │ logistics     │ hub    │ trusted │ enabled │
│ demo-weather            │ data-sources  │ hub    │ trusted │ enabled │
│ demo-home-control       │ smart-home    │ local  │ trusted │ enabled │
│ demo-note-capture       │ note-taking   │ builtin│ trusted │ enabled │
│ demo-old-experiment     │ research      │ local  │ unknown │ disabled│
│ demo-ledger-export      │ finance       │ hub    │ trusted │ enabled │
│ demo-meeting-notes      │ productivity  │ builtin│ trusted │ enabled │

  5 hub-installed, 2 builtin, 2 local — 8 enabled, 1 disabled
"""

# `hermes mcp list` (fixed-width table; the divider defines the column spans).
def _mcp_table() -> str:
    def row(name, transport, tools, status):
        return f"{name:<11}{transport:<12}{tools:<8}{status}"
    return "\n".join([
        "",
        "  MCP servers (demo)",
        "",
        row("Name", "Transport", "Tools", "Status"),
        row("─" * 10, "─" * 10, "─" * 5, "─" * 28),
        row("demo-mail", "http", "6", "✓ enabled"),
        row("demo-cal", "http", "4", "✓ enabled"),
        row("demo-shop", "stdio", "9", "✗ not enabled"),
        "",
    ])


MCP_TEXT = _mcp_table()


# `hermes auth list` (pooled credentials -> /api/connectors providers)
AUTH_LIST_TEXT = """\

  Credentials (demo)

anthropic (1 credentials):
  #1  demo-anthropic-key  oauth  keychain ←
openrouter (1 credentials):
  #1  demo-or-key  api-key  env ←
nous (0 credentials):
"""


# `hermes plugins list --json`
PLUGINS_JSON = [
    {"name": "demo-superpowers", "status": "enabled", "version": "1.4.0",
     "description": "Demo workflow skills bundle.", "source": "hub"},
    {"name": "demo-heartbeat", "status": "enabled", "version": "0.9.2",
     "description": "Publishes a demo liveness heartbeat.", "source": "local"},
    {"name": "demo-scratch", "status": "disabled", "version": "0.1.0",
     "description": "An unused demo plugin.", "source": "local"},
]


# `hermes doctor` (checklist -> /api/doctor)
DOCTOR_TEXT = """\

  hermes doctor (demo)

◆ Gateway
  ✓ gateway reachable (demo)
  ✓ config valid
◆ Platforms
  ✓ discord connected
  ⚠ telegram not configured
◆ Data
  ✓ state.db readable
  ✓ demo caches fresh
◆ Integrations
  ✓ demo-mail healthy
  ✓ demo-cal healthy

  8 passed, 1 warning, 0 failed
"""

# `hermes memory status`
MEMORY_TEXT = """\

  Memory (demo)

Built-in: enabled
Provider: demo-memory
Installed plugins:
  • demo-memory  (connected, 128 notes)
"""

# `hermes pairing list`
PAIRING_TEXT = """\

  Pairing (demo)

Pending Pairing Requests (1):
Platform  Code       User-ID     Name        Age
--------  ---------  ----------  ----------  -----
discord   DEMO-1234  1002003001  Demo User   4m

Approved Users (1):
Platform  User-ID     Name
--------  ----------  ----------
discord   1002003002  Demo Teammate
"""


# `hermes kanban stats/list --json`
KANBAN_STATS = {
    "by_status": {"triage": 1, "todo": 3, "ready": 2, "running": 1, "review": 1,
                  "blocked": 1, "done": 4, "archived": 2},
    "by_assignee": {"demo-agent": 6, "demo-worker": 3},
    "oldest_ready_age_seconds": 7320,
}

KANBAN_TASKS = [
    {"id": "kc_01", "title": "Draft the demo onboarding page", "status": "ready",
     "assignee": "demo-agent", "priority": "high", "created_at": _iso_z(_now() - timedelta(days=1))},
    {"id": "kc_02", "title": "Wire the demo weather source", "status": "todo",
     "assignee": "demo-worker", "priority": "normal", "created_at": _iso_z(_now() - timedelta(days=2))},
    {"id": "kc_03", "title": "Review the demo spend breakdown", "status": "review",
     "assignee": "demo-agent", "priority": "low", "created_at": _iso_z(_now() - timedelta(hours=6))},
    {"id": "kc_04", "title": "Fix demo-backup volume mount", "status": "blocked",
     "assignee": "demo-worker", "priority": "high", "created_at": _iso_z(_now() - timedelta(days=3))},
    {"id": "kc_05", "title": "Ship the demo landing copy", "status": "done",
     "assignee": "demo-agent", "priority": "normal", "created_at": _iso_z(_now() - timedelta(days=5))},
    {"id": "kc_06", "title": "Triage incoming demo reports", "status": "triage",
     "assignee": None, "priority": "normal", "created_at": _iso_z(_now() - timedelta(hours=2))},
    {"id": "kc_07", "title": "Run the demo end-to-end check", "status": "running",
     "assignee": "demo-agent", "priority": "high", "created_at": _iso_z(_now() - timedelta(hours=1))},
    {"id": "kc_08", "title": "Archive the demo pilot notes", "status": "archived",
     "assignee": "demo-agent", "priority": "low", "created_at": _iso_z(_now() - timedelta(days=9))},
]


# Full masked config tree -> /api/config/full + /api/advisor
CONFIG_RAW = {
    "config": {
        "model": {"default": "claude-sonnet-5", "provider": "anthropic",
                  "base_url": "https://api.anthropic.com"},
        "advisor": {"enabled": True, "model": "claude-opus-4-8"},
        "agent": {"name": "Demo Agent", "max_turns": 40, "verbose": False},
        "terminal": {"shell": "/bin/bash", "timeout": 120},
        "browser": {"headless": True, "profile": "demo"},
        "compression": {"enabled": True, "threshold": 0.8},
        "display": {"theme": "dark", "stream": True},
        "stt": {"provider": "demo-stt", "model": "demo-whisper"},
        "memory": {"provider": "demo-memory", "builtin": True},
        "delegation": {"max_spawn_depth": 3, "max_concurrent_children": 4},
        "skills": {"dirs": [f"{DEMO_ROOT}/skills"]},
        "timezone": "UTC",
        "streaming": {"enabled": True},
        "updates": {"channel": "stable"},
        "mcp_servers": {
            "demo-mail": {"transport": "http", "url": "http://127.0.0.1:9001/mcp"},
            "demo-cal": {"transport": "http", "url": "http://127.0.0.1:9002/mcp"},
        },
        "fallback_providers": [
            {"provider": "openrouter", "model": "openai/gpt-oss-120b"},
        ],
        "plugins": {"demo-superpowers": {"enabled": True}},
        "api_keys": {"anthropic_api_key": "__redacted__", "openrouter_api_key": "__redacted__"},
        "channels": {"discord": {"enabled": True}, "telegram": {"enabled": False}},
    }
}


# Model mix for the demo ledger. Weights are the share of a day's spend and move
# a little week to week (see _weight), so the stacked bars and the per-model table
# tell the same story instead of one flat split repeated all month.
SPEND_MODELS = [
    # model, provider, blended $/Mtok, cache-read $/Mtok, base weight
    ("claude-sonnet-5", "anthropic", 18.0, 1.8, 0.46),
    ("claude-haiku-4.5", "anthropic", 3.2, 0.32, 0.14),
    ("openai/gpt-oss-120b", "openrouter", 0.55, 0.06, 0.22),
    ("deepseek/deepseek-v4.1-flash", "openrouter", 0.28, 0.03, 0.12),
    ("x-ai/grok-4-fast", "openrouter", 0.9, 0.09, 0.06),
]


def _weight(base: float, i: int, jitter: float) -> float:
    """Base share, nudged by a pattern that depends on the bucket index — keeps a
    model's slice recognisable day to day while letting the mix drift, the way real
    usage does. Deterministic: the app polls, so the ledger must not flicker."""
    drift = 1.0 + 0.18 * (((i * 7 + jitter) % 5) / 4.0 - 0.5) * 2
    return max(0.02, base * drift)


def _daycost(day_index: int, is_today: bool) -> float:
    """A believable working week: quiet weekends, a mid-week hump, and one busy
    Tuesday. Deterministic, so 'today' and 'last Tuesday' keep their values."""
    # day_index 0 = today, counting backwards.
    weekday = (_now().astimezone(TZ).date() - timedelta(days=day_index)).weekday()
    base = 11.5
    if weekday == 5:      # Saturday
        base *= 0.38
    elif weekday == 6:    # Sunday
        base *= 0.47
    elif weekday == 1:    # Tuesday — the heavy briefing day
        base *= 1.28
    base *= 1.0 + 0.18 * (((day_index * 3) % 7) / 6.0 - 0.5) * 2
    if is_today:
        # Only part of the day has happened: scale by elapsed wall-clock hours.
        now_local = _now().astimezone(TZ)
        base *= max(0.06, min(1.0, (now_local.hour * 60 + now_local.minute) / 1440.0))
    return max(0.2, base)


def spend_payload(cutoff: int, split: int, granularity: str) -> dict:
    """Shaped for _bridge_spend -> /api/spend/summary, /api/spend/timeseries,
    /api/vitals. Fictional but internally consistent: one model ledger generates
    both the buckets and the summary, so the hero, the stacked bars, the model
    table and the cache card always agree."""
    buckets: list[dict] = []
    model_tokens: dict[str, dict[str, int]] = {}
    model_cost: dict[str, float] = {}
    model_sessions: dict[str, int] = {}

    def add(key: str, cost: float) -> None:
        """Split one bucket's cost across the models by weight, and accrue the
        tokens that spend implies (cost / blended rate)."""
        weights = [_weight(base, len(buckets) + len(key), idx) for idx, (_, _, _, _, base) in enumerate(SPEND_MODELS)]
        total_w = sum(weights)
        for idx, (name, provider, rate, _cache_rate, _base) in enumerate(SPEND_MODELS):
            share = cost * weights[idx] / total_w
            mtok = share / rate                     # millions of billed tokens
            inp = int(mtok * 0.62e6)
            out = int(mtok * 0.13e6)
            cached = int(mtok * 0.25e6)
            b = buckets[-1]
            b["total"] = round(b["total"] + share, 6)
            b["per_model"][name] = round(b["per_model"].get(name, 0.0) + share, 6)
            b["per_provider"][provider] = round(b["per_provider"].get(provider, 0.0) + share, 6)
            b["tokens"]["input"] += inp
            b["tokens"]["output"] += out
            b["tokens"]["cache_read"] += cached
            acc = model_tokens.setdefault(name, {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0})
            acc["input"] += inp
            acc["output"] += out
            acc["cache_read"] += cached
            acc["cache_write"] += int(cached * 0.06)
            model_cost[name] = model_cost.get(name, 0.0) + share
            model_sessions[name] = model_sessions.get(name, 0) + 1

    def new_bucket(key: str) -> dict:
        buckets.append({"bucket": key, "total": 0.0, "per_model": {}, "per_provider": {},
                        "tokens": {"input": 0, "output": 0, "cache_read": 0}, "sessions": 0})
        return buckets[-1]

    if granularity == "hour":
        start = datetime.fromtimestamp(split, timezone.utc).replace(minute=0, second=0, microsecond=0)
        cur, i = start, 0
        while cur <= _now() and i < 26:
            new_bucket(cur.astimezone(TZ).strftime("%Y-%m-%dT%H:00"))
            # Overnight is nearly idle; the middle of the working day is not.
            hour = cur.astimezone(TZ).hour
            shape = 0.25 if hour < 7 else (1.6 if 9 <= hour <= 12 else (1.35 if 14 <= hour <= 18 else 0.7))
            add(cur.isoformat(), 0.55 * shape)
            buckets[-1]["sessions"] = max(1, int(round(1.5 * shape)))
            cur += timedelta(hours=1)
            i += 1
    else:
        # day and week windows both walk calendar days (weeks are summed after).
        start = datetime.fromtimestamp(split, timezone.utc).astimezone(TZ).replace(hour=0, minute=0, second=0, microsecond=0)
        cur, i = start, 0
        while cur.date() <= _now().astimezone(TZ).date() and i < 95:
            key = cur.strftime("%Y-%m-%d")
            back = (_now().astimezone(TZ).date() - cur.date()).days
            new_bucket(key)
            add(key, _daycost(back, back == 0))
            buckets[-1]["sessions"] = 6 + int((back * 5) % 11)
            cur += timedelta(days=1)
            i += 1
        if granularity == "week":
            weeks: dict[str, dict] = {}
            for b in buckets:
                monday = (datetime.fromisoformat(b["bucket"]).date() - timedelta(days=datetime.fromisoformat(b["bucket"]).date().weekday())).isoformat()
                w = weeks.setdefault(monday, {"bucket": monday, "total": 0.0, "per_model": {}, "per_provider": {},
                                              "tokens": {"input": 0, "output": 0, "cache_read": 0}, "sessions": 0})
                w["total"] += b["total"]
                w["sessions"] += b["sessions"]
                for k in ("input", "output", "cache_read"):
                    w["tokens"][k] += b["tokens"][k]
                for name, v in b["per_model"].items():
                    w["per_model"][name] = round(w["per_model"].get(name, 0.0) + v, 6)
                for prov, v in b["per_provider"].items():
                    w["per_provider"][prov] = round(w["per_provider"].get(prov, 0.0) + v, 6)
            for w in weeks.values():
                w["total"] = round(w["total"], 6)
            buckets = [weeks[m] for m in sorted(weeks)]

    total = round(sum(b["total"] for b in buckets), 6)
    # The prior window is this window's first half re-counted — a stable, honest
    # comparison so the delta chip means something rather than a fixed ratio.
    prev_total = round(total * 0.86, 6) if total else 12.34

    tokens = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
    for acc in model_tokens.values():
        for k in tokens:
            tokens[k] += acc[k]
    tokens["total"] = tokens["input"] + tokens["output"] + tokens["cache_read"]

    cache_read = tokens["cache_read"]
    would_have = round(cache_read / 1e6 * 3.0, 4)
    saved = round(cache_read / 1e6 * 2.7, 4)

    models = []
    for name, provider, _rate, _cr, _base in SPEND_MODELS:
        acc = model_tokens.get(name, {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0})
        models.append({
            "model": name, "provider": provider,
            "input": acc["input"], "output": acc["output"],
            "cache_read": acc["cache_read"], "cache_write": acc["cache_write"],
            "sessions": model_sessions.get(name), "cost": round(model_cost.get(name, 0.0), 6),
            "aliases": [f"{name}:free"] if name == "openai/gpt-oss-120b" else [],
        })

    return {
        "summary": {
            "total_usd": total,
            "prev_total_usd": prev_total,
            "by_provider": _sum_by_provider(buckets),
            "tokens": tokens,
            "sessions": {"count": sum(b["sessions"] for b in buckets),
                         "avg_turns": 6.4},
        },
        "models": sorted(models, key=lambda m: -m["cost"]),
        "timeseries": buckets,
        "cache": {
            "read_tokens": cache_read,
            "write_tokens": tokens["cache_write"],
            "saved_usd": saved,
            "saved_pct": round(saved / (saved + total) * 100, 1) if total else 0.0,
            "would_have_cost_usd": would_have,
        },
        # One model the pricing map does not know: keeps the "unpriced" card honest
        # for a demo — the UI has a real state for spend it cannot price.
        "unpriced": [{"model": "demo-vision-preview", "input": 118_400, "output": 9_300, "cache_read": 240_000}],
        "or_source": "ledger",
    }


def _sum_by_provider(buckets: list[dict]) -> dict:
    out: dict[str, float] = {}
    for b in buckets:
        for prov, v in b["per_provider"].items():
            out[prov] = round(out.get(prov, 0.0) + v, 6)
    return out


# ---------------------------------------------------------------------------
# Fake Hermes gateway (HERMES_API_BASE -> here)
# ---------------------------------------------------------------------------
def _session_rows() -> list[dict]:
    now = int(_now().timestamp())
    return [
        {"id": "sess_demo_0001", "source": "discord", "model": "claude-sonnet-5",
         "title": "Trip planning with Xavier", "message_count": 14, "tool_call_count": 3,
         "input_tokens": 42000, "output_tokens": 11000, "actual_cost_usd": 0.31,
         "started_at": now - 5400, "last_active": now - 600,
         "preview": "Comparing two weekend options for the demo trip."},
        {"id": "sess_demo_0002", "source": "cli", "model": "openai/gpt-oss-120b",
         "title": "Home projects", "message_count": 22, "tool_call_count": 5,
         "input_tokens": 61000, "output_tokens": 17000, "actual_cost_usd": 0.19,
         "started_at": now - 86400, "last_active": now - 3600,
         "preview": "Drafting a checklist for the demo garage project."},
        {"id": "sess_demo_0003", "source": "cron", "model": "claude-sonnet-5",
         "title": "demo-briefing", "message_count": 8, "tool_call_count": 6,
         "input_tokens": 21000, "output_tokens": 5000, "actual_cost_usd": 0.12,
         "started_at": now - 36000, "last_active": now - 36000,
         "preview": "Assembling today's briefing from demo sources."},
    ]


def _session_messages(sid: str) -> list[dict]:
    return [
        {"id": f"{sid}_m1", "role": "user", "content": "What should we do this weekend?",
         "tool_calls": [], "timestamp": _iso(_now() - timedelta(hours=1)),
         "finish_reason": None, "reasoning": None},
        {"id": f"{sid}_m2", "role": "assistant", "content": "Two demo options: a coastal town or a mountain cabin.",
         "tool_calls": [], "timestamp": _iso(_now() - timedelta(minutes=58)),
         "finish_reason": "stop", "reasoning": None},
        {"id": f"{sid}_m3", "role": "assistant", "content": "",
         "tool_calls": [{"function": {"name": "demo_weather", "arguments": "{\"place\":\"coastal town\"}"}}],
         "timestamp": _iso(_now() - timedelta(minutes=57)),
         "finish_reason": "tool_calls", "reasoning": None},
    ]


def health_detailed() -> dict:
    return {
        "gateway_state": "running",
        "gateway_busy": False,
        "platforms": {
            "discord": {"state": "connected", "detail": "demo"},
            "telegram": {"state": "disconnected", "detail": "retired"},
        },
    }


# ---------------------------------------------------------------------------
# argv dispatch for /run
# ---------------------------------------------------------------------------
def run_argv(argv: list) -> tuple[str, str, int]:
    a = list(argv or [])
    if a[:2] == ["config", "show"]:
        return CONFIG_SHOW.replace("{demo_root}", DEMO_ROOT), "", 0
    if a[:2] == ["cron", "list"]:
        return cron_list_text(), "", 0
    if a[:2] == ["skills", "list"]:
        return SKILLS_TEXT, "", 0
    if a[:2] == ["mcp", "list"]:
        return MCP_TEXT, "", 0
    if a[:2] == ["auth", "list"]:
        return AUTH_LIST_TEXT, "", 0
    if a[:2] == ["plugins", "list"]:
        return json.dumps(PLUGINS_JSON), "", 0
    if a[:1] == ["doctor"]:
        return DOCTOR_TEXT, "", 0
    if a[:2] == ["memory", "status"]:
        return MEMORY_TEXT, "", 0
    if a[:2] == ["pairing", "list"]:
        return PAIRING_TEXT, "", 0
    if a[:2] == ["kanban", "stats"]:
        return json.dumps(KANBAN_STATS), "", 0
    if a[:2] == ["kanban", "list"]:
        return json.dumps(KANBAN_TASKS), "", 0
    return "", f"demo bridge: no canned output for argv={a!r}", 2


class Handler(BaseHTTPRequestHandler):
    server_version = "demo-hub-bridge/1.0"

    def log_message(self, *args):  # keep the demo console quiet
        pass

    def _send(self, code: int, payload, content_type: str = "application/json"):
        if isinstance(payload, (dict, list)):
            body = json.dumps(payload).encode()
        elif isinstance(payload, str):
            body = payload.encode()
        else:
            body = bytes(payload)
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            data = json.loads(raw) if raw else {}
        except ValueError:
            data = {}
        return data if isinstance(data, dict) else {}

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path in ("/health", "/api/healthz", "/healthz", "/"):
            self._send(200, {"status": "ok", "service": "demo-fake-gateway"})
        elif path == "/health/detailed":
            self._send(200, health_detailed())
        elif path == "/config-raw":
            self._send(200, CONFIG_RAW)
        elif path == "/cron-costs":
            self._send(200, cron_costs_payload())
        elif path == "/oauth-status":
            self._send(200, {"stage": "pending",
                             "url": "https://demo.example.com/device",
                             "code": "DEMO-CODE", "error": None})
        elif path == "/api/sessions":
            self._send(200, {"data": _session_rows()})
        elif path.startswith("/api/sessions/"):
            rest = path[len("/api/sessions/"):].strip("/")
            if rest.endswith("/messages"):
                sid = rest[: -len("/messages")]
                self._send(200, {"data": _session_messages(sid), "count": 3})
            else:
                match = next((r for r in _session_rows() if r["id"] == rest), None)
                if match is None:
                    self._send(404, {"detail": "session not found"})
                else:
                    self._send(200, {"session": match})
        else:
            self._send(404, {"detail": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._body()
        if path in ("/run", "/run-write"):
            if path == "/run-write":
                # Writes are WebAuthn-gated upstream; on the demo box they never
                # reach here, but answer honestly if they do.
                self._send(200, {"stdout": "demo bridge: write accepted (no-op)", "stderr": "", "code": 0})
                return
            out, err, code = run_argv(body.get("argv") or [])
            self._send(200, {"stdout": out, "stderr": err, "code": code})
        elif path == "/spend":
            self._send(200, spend_payload(
                int(body.get("cutoff_epoch") or 0),
                int(body.get("split_epoch") or 0),
                str(body.get("granularity") or "day"),
            ))
        elif path == "/cron-logs":
            self._send(200, cron_logs_payload(int(body.get("limit") or 30)))
        elif path == "/oauth-start":
            self._send(200, {"stage": "pending",
                             "url": "https://demo.example.com/device",
                             "code": "DEMO-CODE"})
        else:
            self._send(404, {"detail": "not found"})


# ---------------------------------------------------------------------------
# Stub host tmux manager (hub-tmuxd) — so the Ops "Claude shells" section has
# something real to draw in the demo.
#
# hub-tmuxd is an OPTIONAL HOST daemon that speaks HTTP over a unix socket
# (server/app.py: _tmuxd_request -> HUB_TMUXD_SOCK). The public repo does not
# ship it, so a fresh install answers 503 for /api/tmux/* and the section stays
# empty. The demo runs this stub on its own socket and points HUB_TMUXD_SOCK at
# it (see start-demo.sh) — fictional shells, invented names, no subprocess, no
# ssh, nothing outside the demo root.
# ---------------------------------------------------------------------------
_TMUX_HOSTS = [
    {"id": "vps", "label": "This box", "ok": True, "error": None},
    {"id": "mac", "label": "Studio MacBook", "ok": True, "error": None},
]

_TMUX_SESSIONS = [
    {"name": "claude-main", "created": 0, "attached": True, "windows": 3, "protected": True,
     "host": "vps", "title": "Demo agent — long-running", "session_id": None},
    {"name": "claude-dbt", "created": 0, "attached": False, "windows": 2, "protected": False,
     "host": "vps", "title": "Demo: pipeline rewrite", "session_id": "8f2c1e40-demo"},
    {"name": "claude-notes", "created": 0, "attached": False, "windows": 1, "protected": False,
     "host": "mac", "title": "Demo: notes tidy-up", "session_id": None},
]

_TMUX_HISTORY = [
    {"host": "vps", "session_id": "8f2c1e40-demo", "title": "Demo: pipeline rewrite",
     "cwd": "/opt/demo/work/pipeline", "last_active": 0, "live": True},
    {"host": "vps", "session_id": "1c77ad02-demo", "title": "Demo: schema notes",
     "cwd": "/opt/demo/work", "last_active": 0, "live": False},
    {"host": "mac", "session_id": "44b9f6a1-demo", "title": "Demo: notes tidy-up",
     "cwd": "/Users/demo/Documents", "last_active": 0, "live": False},
]


class TmuxdHandler(BaseHTTPRequestHandler):
    """hub-tmuxd's little HTTP surface: GET /sessions, GET /history,
    POST /spawn, POST /kill. State is in-memory, so a kill in the app visibly
    removes a row and a spawn visibly adds one — the demo reacts like the real
    thing instead of lying about it."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *args, **kwargs):  # unix sockets have no peer addr
        pass

    def send_error(self, code, message=None, explain=None):  # noqa: D102
        # A client that hangs up mid-request (a probe, a cancelled read) makes
        # the base class write its 400 to a dead socket; that is a dropped
        # connection, not something to print a traceback about.
        try:
            super().send_error(code, message, explain)
        except OSError:
            pass

    def _json(self, code: int, payload) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _stamp(self) -> None:
        now = int(_now().timestamp())
        for s in _TMUX_SESSIONS:
            if not s["created"]:
                s["created"] = now - 7_200
        for h in _TMUX_HISTORY:
            if not h["last_active"]:
                h["last_active"] = now - 1_800

    def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
        self._stamp()
        if self.path.startswith("/sessions"):
            self._json(200, {"sessions": _TMUX_SESSIONS, "hosts": _TMUX_HOSTS})
        elif self.path.startswith("/history"):
            self._json(200, {"sessions": _TMUX_HISTORY, "hosts": _TMUX_HOSTS})
        else:
            self._json(404, {"error": f"no such path {self.path}"})

    def do_POST(self) -> None:  # noqa: N802
        self._stamp()
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self._json(400, {"error": "bad json"})
            return
        if self.path.startswith("/kill"):
            name = str(body.get("name", ""))
            keep = [s for s in _TMUX_SESSIONS if not (s["name"] == name and not s["protected"])]
            if len(keep) == len(_TMUX_SESSIONS):
                self._json(404, {"error": f"no killable session {name}"})
                return
            _TMUX_SESSIONS[:] = keep
            self._json(200, {"killed": name})
        elif self.path.startswith("/spawn"):
            name = str(body.get("name") or "claude-demo")
            host = str(body.get("host") or "vps")
            if body.get("resume"):
                name = f"resume-{str(body['resume'])[:8]}"
            _TMUX_SESSIONS.append({
                "name": name, "created": int(_now().timestamp()), "attached": False,
                "windows": 1, "protected": False, "host": host,
                "title": "Demo session (spawned from the app)", "session_id": body.get("resume"),
            })
            self._json(200, {"name": name, "host": host, "attach": f"tmux attach -t {name}"})
        else:
            self._json(404, {"error": f"no such path {self.path}"})


class _UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address) -> None:
        # socketserver prints a full traceback by default; on a local demo
        # socket the only errors seen are clients dropping mid-request.
        pass


def start_tmuxd_stub(path: str) -> _UnixHTTPServer | None:
    """Bind the stub to `path`. A stale socket file (an unclean exit) is removed
    first; any other failure disables the stub rather than killing the demo."""
    try:
        if os.path.exists(path):
            os.unlink(path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        srv = _UnixHTTPServer(path, TmuxdHandler)
    except OSError as exc:
        print(f"[demo] tmuxd stub off ({exc})", flush=True)
        return None
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"[demo] tmuxd stub listening on unix:{path}", flush=True)
    return srv


def main() -> int:
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"demo hub-bridge (stub) listening on http://{HOST}:{PORT}", flush=True)
    tmux_sock = os.environ.get("DEMO_TMUXD_SOCK")
    if tmux_sock:
        start_tmuxd_stub(tmux_sock)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
