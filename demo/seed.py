#!/usr/bin/env python3
"""demo/seed.py — write every cache/store file the demo hub-api reads.

All content is entirely FICTIONAL. No real names, hosts, channels, accounts or
numbers appear anywhere in the output. Everything is written under demo/data
(override with DEMO_ROOT) at the exact paths hub-api's env-overridable defaults
point at; run demo/start-demo.sh, which exports the matching environment.

Usage:
    python3 demo/seed.py
    DEMO_ROOT=/path/to/hub-demo python3 demo/seed.py
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None  # type: ignore

DEMO_ROOT = Path(os.environ.get("DEMO_ROOT", str(Path(__file__).resolve().parent / "data")))
TZ = ZoneInfo(os.environ.get("HUB_TZ") or "UTC") if ZoneInfo else timezone.utc

# Env-overridable output paths — identical names + defaults to app.py.
LOG_DIR = Path(os.environ.get("HUB_LOG_DIR", str(DEMO_ROOT / "log")))
HUB_DIR = DEMO_ROOT / ".hub"
ACCESS_JSON = Path(os.environ.get("HUB_ACCESS_REPORT", str(HUB_DIR / "access-report.json")))
ROSTER_JSON = Path(os.environ.get("HUB_ROSTER", str(HUB_DIR / "agents.json")))
ACTIVITY_JSON = Path(os.environ.get("HUB_ACTIVITY", str(HUB_DIR / "activity.json")))
SCHEDULES_JSON = Path(os.environ.get("HUB_SCHEDULES", str(HUB_DIR / "schedules.json")))
SKILLS_JSON = Path(os.environ.get("HUB_SKILLS", str(HUB_DIR / "skills.json")))
MY_PAGES_ROOT = Path(os.environ.get("MY_PAGES_ROOT", str(DEMO_ROOT / "Sites/my-pages")))
INBOX_DIR = Path(os.environ.get("HUB_INBOX_DIR", str(DEMO_ROOT / "hub-inbox")))
DECISIONS_DIR = Path(os.environ.get("HUB_DECISIONS_DIR", str(DEMO_ROOT / "decisions")))
FINANCE_SNAPSHOT = Path(os.environ.get("HUB_FINANCE_SNAPSHOT", str(DEMO_ROOT / "sites/finance/snapshot.json")))
RECURRING_COSTS = Path(os.environ.get("HUB_RECURRING_COSTS", str(DEMO_ROOT / "finance/recurring-costs.json")))
MCP_WATCH_LOG = Path(os.environ.get("HUB_MCP_WATCH_LOG", str(LOG_DIR / "mcp-watch.jsonl")))
CHAT_DB = Path(os.environ.get("HUB_CHAT_DB", str(DEMO_ROOT / "chat/chat.db")))
CHAT_MEDIA = Path(os.environ.get("HUB_CHAT_MEDIA_DIR", str(DEMO_ROOT / "chat/media")))
CHAT_SESSIONS = Path(os.environ.get("HUB_CHAT_SESSIONS_FILE", str(DEMO_ROOT / "chat/sessions.json")))
BRIEF_DISMISSALS = Path(os.environ.get("HUB_BRIEFING_DISMISSALS", str(DEMO_ROOT / "data/briefing_dismissals.json")))
BRIEF_FEEDBACK = Path(os.environ.get("HUB_BRIEFING_FEEDBACK", str(DEMO_ROOT / "data/briefing_feedback.jsonl")))
BRIEF_RULES = Path(os.environ.get("HUB_BRIEFING_RULES", str(DEMO_ROOT / "data/briefing_rules.json")))
PUSH_TOKENS = Path(os.environ.get("HUB_PUSH_TOKENS", str(DEMO_ROOT / "data/push_tokens.json")))
TOPICS_CONFIG = Path(os.environ.get("HUB_TOPICS_CONFIG", str(DEMO_ROOT / "hub-config/telegram-topics.json")))
TOPICS_LIVE = Path(os.environ.get("HUB_TOPICS_LIVE", str(DEMO_ROOT / "hub-config/telegram-topics.live.json")))
CALENDAR_SNAPSHOT = Path(os.environ.get("HUB_CALENDAR", str(DEMO_ROOT / "hub-config/calendar.json")))

SERVER_DIR = Path(__file__).resolve().parent.parent / "server"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def today_ago(days: int) -> str:
    return (datetime.now(timezone.utc).date() - timedelta(days=days)).isoformat()


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def write_jsonl(path: Path, rows: list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))


# ---------------------------------------------------------------------------
# /api/health  (LOG_DIR/healthcheck.jsonl, newest 40)
# ---------------------------------------------------------------------------
def seed_health() -> None:
    now = datetime.now(timezone.utc)
    services = [
        ("demo-mail", "up", 41, "IMAP + API reachable"),
        ("demo-calendar", "up", 63, "CalDAV reachable"),
        ("demo-search", "up", 88, "index current"),
        ("demo-scheduler", "up", 12, "0 overdue jobs"),
        ("demo-database", "up", 7, "WAL checkpointed"),
        ("demo-backup", "degraded", 0, "archive volume not mounted"),
    ]
    rows = []
    for i in range(4):
        for name, status, ms, detail in services:
            ts = now - timedelta(minutes=15 * i)
            rows.append({
                "service": name, "status": status, "latency_ms": ms,
                "detail": detail, "ts": ts.replace(microsecond=0).isoformat(),
                "last_probe": ts.replace(microsecond=0).isoformat(),
            })
    rows.sort(key=lambda r: r["ts"])
    write_jsonl(LOG_DIR / "healthcheck.jsonl", rows)


def seed_restic() -> None:
    now = datetime.now(timezone.utc)
    write_json(LOG_DIR / "restic-snapshots.json", {
        "latest": {"id": "demo-snap-0003", "ts": (now - timedelta(hours=8)).replace(microsecond=0).isoformat(),
                   "size": "1.2 GiB", "files": 18432},
        "count": 3,
        "total_size": "3.6 GiB",
        "snapshots": [
            {"id": "demo-snap-0001", "ts": (now - timedelta(days=2)).replace(microsecond=0).isoformat(),
             "size": "1.2 GiB", "files": 18210},
            {"id": "demo-snap-0002", "ts": (now - timedelta(days=1)).replace(microsecond=0).isoformat(),
             "size": "1.2 GiB", "files": 18301},
            {"id": "demo-snap-0003", "ts": (now - timedelta(hours=8)).replace(microsecond=0).isoformat(),
             "size": "1.2 GiB", "files": 18432},
        ],
        "schedule": "daily 03:00", "ok": True,
    })


def seed_mcp_watch() -> None:
    write_jsonl(MCP_WATCH_LOG, [{
        "ts": now_iso(), "demo_mail": "200", "demo_cal": "200", "demo_shop": "down",
    }])


# ---------------------------------------------------------------------------
# /api/audit, /api/agents, /api/activity, /api/schedules, /api/skills
# ---------------------------------------------------------------------------
def seed_audit() -> None:
    write_json(ACCESS_JSON, {
        "keys_ok": 3, "keys_total": 3, "spend_mtd_usd": 48.12, "spend_cap_usd": 200.0,
        "drift_count": 0, "last_audit_at": now_iso(),
        "tool_calls_24h": 214, "mcp_calls_24h": 88, "flagged_24h": 0,
    })


def seed_roster() -> None:
    write_json(ROSTER_JSON, {"generated_at": now_iso(), "data": [
        {"id": "demo-agent", "name": "Demo Agent", "model": "claude-sonnet-5", "status": "up",
         "last_message_at": (datetime.now(timezone.utc) - timedelta(minutes=4)).replace(microsecond=0).isoformat(),
         "messages_today": 37, "avatar_glyph": ":robot:"},
        {"id": "demo-worker", "name": "Demo Worker", "model": "openai/gpt-oss-120b", "status": "up",
         "last_message_at": (datetime.now(timezone.utc) - timedelta(minutes=41)).replace(microsecond=0).isoformat(),
         "messages_today": 12, "avatar_glyph": ":gear:"},
    ]})


def seed_activity() -> None:
    now = datetime.now(timezone.utc)
    entries = [
        {"ts": (now - timedelta(minutes=4)).replace(microsecond=0).isoformat(), "kind": "message",
         "actor": "Demo Agent", "title": "Answered a trip-planning question", "detail": "2 options compared"},
        {"ts": (now - timedelta(minutes=26)).replace(microsecond=0).isoformat(), "kind": "tool",
         "actor": "Demo Worker", "title": "Fetched demo package status", "detail": "3 shipments"},
        {"ts": (now - timedelta(hours=2)).replace(microsecond=0).isoformat(), "kind": "job",
         "actor": "demo-inbox-sweep", "title": "Inbox sweep complete", "detail": "14 messages"},
        {"ts": (now - timedelta(hours=6)).replace(microsecond=0).isoformat(), "kind": "message",
         "actor": "Demo Agent", "title": "Drafted a home-project checklist", "detail": "8 items"},
    ]
    write_json(ACTIVITY_JSON, {"generated_at": now_iso(), "data": entries})


def seed_schedules() -> None:
    now = datetime.now(timezone.utc)
    write_json(SCHEDULES_JSON, {"generated_at": now_iso(), "data": [
        {"id": "demo-briefing", "label": "Morning briefing", "cadence": "daily 07:30",
         "next_run_at": (now + timedelta(hours=13)).replace(microsecond=0).isoformat(),
         "last_run": (now - timedelta(hours=11)).replace(microsecond=0).isoformat()},
        {"id": "demo-healthcheck", "label": "Service healthcheck", "cadence": "every 15m",
         "next_run_at": (now + timedelta(minutes=9)).replace(microsecond=0).isoformat(),
         "last_run": (now - timedelta(minutes=6)).replace(microsecond=0).isoformat()},
        {"id": "demo-inbox-sweep", "label": "Inbox sweep", "cadence": "every 2h",
         "next_run_at": (now + timedelta(hours=1)).replace(microsecond=0).isoformat(),
         "last_run": (now - timedelta(hours=1)).replace(microsecond=0).isoformat()},
    ]})


def seed_skills() -> None:
    # Legacy cache shape; /api/skills is bridge-backed now, kept for completeness.
    write_json(SKILLS_JSON, {"generated_at": now_iso(), "data": [
        {"name": "demo-briefing", "category": "productivity", "status": "enabled"},
        {"name": "demo-weather", "category": "data-sources", "status": "enabled"},
    ]})


# ---------------------------------------------------------------------------
# /api/feed (INBOX_DIR cards + status line)
# ---------------------------------------------------------------------------
def seed_inbox() -> None:
    now = int(datetime.now(timezone.utc).timestamp())
    write_json(INBOX_DIR / "status.json", {
        "ts": now, "ttl_s": 3600, "kind": "status",
        "text": "Demo sources healthy — 5 of 6 services up",
    })
    write_json(INBOX_DIR / "report-1.json", {
        "id": "demo-report-1", "ts": now - 600, "kind": "report",
        "title": "Weekly demo review ready",
        "summary": "3 projects advanced, 1 stalled, 2 waiting on you.",
        "link": "/my-pages/project-board/",
    })
    write_json(INBOX_DIR / "alert-1.json", {
        "id": "demo-alert-1", "ts": now - 1800, "kind": "alert", "priority": "high",
        "title": "demo-backup failed",
        "summary": "The archive volume was not mounted; last night's snapshot was skipped.",
    })


# ---------------------------------------------------------------------------
# /api/decisions (DECISIONS_DIR/*.json + responses.jsonl)
# ---------------------------------------------------------------------------
def seed_decisions() -> None:
    now = datetime.now(timezone.utc)
    write_json(DECISIONS_DIR / "demo-trip-dates.json", {
        "id": "demo-trip-dates", "title": "Which weekend for the demo trip?",
        "source": "Demo Agent",
        "created": (now - timedelta(hours=5)).replace(microsecond=0).isoformat(),
        "status": "open",
        "body": "Xavier proposed two windows. Pick one and I'll book.",
        "options": [
            {"key": "weekend-a", "label": "Weekend A — coastal town"},
            {"key": "weekend-b", "label": "Weekend B — mountain cabin"},
        ],
    })
    write_json(DECISIONS_DIR / "demo-project-scope.json", {
        "id": "demo-project-scope", "title": "Scope the demo garage project",
        "source": "Demo Worker",
        "created": (now - timedelta(hours=20)).replace(microsecond=0).isoformat(),
        "status": "open",
        "body": "Full rebuild or staged refresh?",
        "options": [
            {"key": "staged", "label": "Staged refresh"},
            {"key": "full", "label": "Full rebuild"},
        ],
    })
    write_json(DECISIONS_DIR / "demo-backup-fix.json", {
        "id": "demo-backup-fix", "title": "Remount the demo archive volume",
        "source": "Demo Agent",
        "created": (now - timedelta(days=2)).replace(microsecond=0).isoformat(),
        "status": "answered",
        "body": "The backup target went missing.",
        "options": [{"key": "remount", "label": "Remount now"}, {"key": "later", "label": "Do it later"}],
        "answer": {"option_key": "remount", "note": "remounted; next run scheduled",
                   "ts": (now - timedelta(days=1, hours=6)).replace(microsecond=0).isoformat()},
    })
    write_jsonl(DECISIONS_DIR / "responses.jsonl", [{
        "id": "demo-backup-fix", "title": "Remount the demo archive volume",
        "source": "Demo Agent", "status": "answered", "option_key": "remount",
        "note": "remounted; next run scheduled",
        "ts": (now - timedelta(days=1, hours=6)).replace(microsecond=0).isoformat(),
    }])


# ---------------------------------------------------------------------------
# /api/finance + /api/cost/recurring
# ---------------------------------------------------------------------------
def seed_finance() -> None:
    # Shaped to the app's FinanceSnapshot (app/src/lib/types.ts) — the Home tab's
    # MoneyEntryCard reads spend_windows.last_30d, so spend_windows must exist.
    write_json(FINANCE_SNAPSHOT, {
        "schema_version": 3,
        "asof": now_iso(),
        "sources": {
            "copilot_mcp": {"status": "ok", "asof": now_iso()},
            "plaid": {"status": "ok", "asof": now_iso()},
        },
        "spend_windows": {
            "today": 42.75,
            "last_7d": 312.60,
            "last_30d": 1284.20,
            "top_categories": [
                {"category": "Groceries", "amount": 418.90},
                {"category": "Dining", "amount": 265.40},
                {"category": "Transport", "amount": 122.75},
            ],
        },
        "spend": [
            {"category": "Groceries", "month_to_date": 214.10, "budget": 500.0,
             "window": "mtd", "source": "plaid"},
            {"category": "Transport", "month_to_date": 88.00, "budget": 200.0,
             "window": "mtd", "source": "plaid"},
            {"category": "Dining", "month_to_date": 132.30, "budget": 300.0,
             "window": "mtd", "source": "plaid"},
        ],
        "accounts": [
            {"name": "Demo Checking", "balance_usd": 4820.55},
            {"name": "Demo Card", "balance_usd": -318.20},
        ],
        "recent_transactions": [
            {"date": today_ago(0), "merchant": "Demo Market", "amount": 24.10,
             "category": "Groceries", "account_last4": "1006",
             "pending": False, "source": "plaid"},
            {"date": today_ago(1), "merchant": "Demo Diner", "amount": 32.40,
             "category": "Dining", "account_last4": "1006",
             "pending": False, "source": "plaid"},
            {"date": today_ago(2), "merchant": "Demo Transit", "amount": 2.90,
             "category": "Transport", "account_last4": "1006",
             "pending": True, "source": "plaid"},
        ],
        "net_worth": {"total": 18240.35, "assets": 24820.55,
                      "liabilities": 6580.20, "delta_1d": 14.60, "delta_30d": 512.80},
        "alerts": [],
    })
    write_json(RECURRING_COSTS, {
        "updated_on": datetime.now(timezone.utc).date().isoformat(),
        "items": [
            {"id": "demo-hosting", "label": "Demo Hosting", "vendor": "Demo Cloud",
             "category": "infra", "cadence": "monthly", "amount_usd": 24.00, "active": True},
            {"id": "demo-mail", "label": "Demo Mail", "vendor": "Demo Post",
             "category": "comms", "cadence": "monthly", "amount_usd": 9.00, "active": True},
            {"id": "demo-domain", "label": "Demo Domain", "vendor": "Demo Registrar",
             "category": "infra", "cadence": "annual", "amount_usd": 18.00, "active": True},
            {"id": "demo-old", "label": "Retired Demo Add-on", "vendor": "Demo Cloud",
             "category": "infra", "cadence": "monthly", "amount_usd": 4.00, "active": False},
        ],
        "_excluded": {"_note": "inactive lines excluded"},
    })


# ---------------------------------------------------------------------------
# MY_PAGES_ROOT briefing + a plain page
# ---------------------------------------------------------------------------
def _brief_slug() -> str:
    return f"briefing-{datetime.now(TZ).date().isoformat()}"


def seed_my_pages() -> None:
    slug = _brief_slug()
    # Item ids are 12 lowercase hex, matching app.py's _DZ_ID_RE.
    items = {
        "now": [
            {"item_id": "d1a2b3c4d5e6", "title": "Reply to Xavier about the demo trip", "source": "Demo Mail",
             "why": "waiting 6h"},
            {"item_id": "a1f2e3d4c5b6", "title": "Approve the demo garage scope", "source": "Demo Worker",
             "why": "decision open"},
        ],
        "today": [
            {"item_id": "b2c3d4e5f6a1", "title": "Demo standup at 11:00", "source": "Demo Calendar",
             "why": "in 2h"},
            {"item_id": "c3d4e5f6a1b2", "title": "Package arriving today", "source": "Demo Packages",
             "why": "out for delivery"},
        ],
        "week": [
            {"item_id": "d4e5f6a1b2c3", "title": "Renew the demo domain", "source": "Demo Finance",
             "why": "expires in 5d"},
        ],
        "background": [
            {"item_id": "e5f6a1b2c3d4", "title": "Demo newsletter — 3 releases worth a look",
             "source": "Demo News", "why": "low priority"},
        ],
    }
    write_json(MY_PAGES_ROOT / slug / "brief.json", {
        "date": slug.split("-", 1)[1],
        "generated_at": now_iso(),
        "buckets": {
            "now": [dict(i, bucket="now") for i in items["now"]],
            "today": [dict(i, bucket="today") for i in items["today"]],
            "week": [dict(i, bucket="week") for i in items["week"]],
            "background": [dict(i, bucket="background") for i in items["background"]],
        },
        "sources": {"email": "ok", "calendar": "ok", "packages": "ok", "imessage": "down"},
    })

    def card(item: dict, need: bool = False) -> str:
        iid = item["item_id"]
        open_tag = f"<!--dz:{iid}:need-->" if need else f"<!--dz:{iid}-->"
        return (
            f'{open_tag}\n'
            f'<article class="card"><div class="card-title">{item["title"]}</div>'
            f'<span class="tag">{item["source"]}</span></article>\n'
            f'<!--/dz:{iid}-->\n'
        )

    html = (
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
        f"<title>Briefing {slug.split('-',1)[1]}</title></head>\n<body>\n"
        "<header class=\"pagehead\">"
        f'<span data-dz-count="needall" data-dz-tpl="{{n}} waiting on you|{{n}} waiting on you">2 waiting on you</span>'
        f'<span data-dz-count="page" data-dz-tpl="{{n}} items|{{n}} item">5 items</span>'
        "</header>\n<section class=\"bucket\">\n<h2>Now</h2>\n"
        + card(items["now"][0], need=True)
        + card(items["now"][1], need=True)
        + "</section>\n<section class=\"bucket\">\n<h2>Today</h2>\n"
        + card(items["today"][0])
        + card(items["today"][1])
        + "</section>\n<section class=\"bucket\">\n<h2>This week</h2>\n"
        + card(items["week"][0])
        + "</section>\n<section class=\"bucket\">\n<h2>Background</h2>\n"
        + card(items["background"][0])
        + "</section>\n<!--dz-undo-->\n</body></html>\n"
    )
    write_text(MY_PAGES_ROOT / slug / "index.html", html)

    # A plain (non-briefing) published page, so /api/my-pages shows variety.
    write_text(MY_PAGES_ROOT / "project-board" / "index.html",
               "<!doctype html>\n<html><head><meta charset=\"utf-8\">"
               "<title>Demo Project Board</title></head>\n<body>\n"
               "<h1>Demo Project Board</h1>\n<p>Three fictional projects, one board.</p>\n"
               "</body></html>\n")


# ---------------------------------------------------------------------------
# Chat DB (ChatStore) — 3 fictional threads with messages
# ---------------------------------------------------------------------------
def demo_id(prefix: str, *parts: str) -> str:
    """A deterministic id for a seeded demo row.

    The app keeps a tail of each thread on the device, keyed by thread id
    (`chat.tail.<threadId>` in the app's AsyncStorage) and paints it while the
    server's answer is in flight. Seeding a fresh random id per message under a
    fixed thread id meant a device that had already cached the thread rendered
    the cached rows beside their replacements — the same message twice. Tying
    both the thread id and the message ids to the seeded content makes a re-seed
    idempotent: unchanged demo data reuses the same ids (so the cache stays
    correct), and edited data lands under fresh ids (so a stale tail cannot
    collide with it).

    The server's own ids stay opaque — nothing parses them — so a demo id only
    has to be unique and stable.
    """
    digest = hashlib.sha1("\x00".join(parts).encode("utf-8")).hexdigest()[:10]
    return f"{prefix}_{digest}"


def seed_chat() -> None:
    sys.path.insert(0, str(SERVER_DIR))
    from chat.store import ChatStore  # imported here so a bare bridge-only run never needs it

    CHAT_MEDIA.mkdir(parents=True, exist_ok=True)
    store = ChatStore(CHAT_DB, CHAT_MEDIA)
    try:
        threads = [
            ("Trip planning with Xavier", [
                ("user", "human", "Xavier and I are comparing two weekends for the demo trip — coastal town or mountain cabin?"),
                ("assistant", "agent", "Two options on the board: the coastal town (mild, walkable) or the mountain cabin (quiet, longer drive). Want me to compare costs?"),
                ("user", "human", "Yes, compare them and flag anything that needs booking early."),
                ("assistant", "agent", "Both fit the budget. The cabin needs booking two weeks out; the town is flexible. I left a decision card for the dates."),
            ]),
            ("Home projects", [
                ("user", "human", "Draft me a checklist for the demo garage project."),
                ("assistant", "agent", "Eight items: clear the space, sort tools, patch the wall, prime, paint, shelving, lighting, final tidy."),
                ("user", "human", "Good. Add a staging option too."),
                ("assistant", "agent", "Added: a staged refresh checklist as an alternative scope."),
            ]),
            ("Demo hub tour", [
                ("assistant", "agent", "Welcome to the demo Hub. Every number here is fictional — poke around freely."),
                ("user", "human", "What can I look at first?"),
                ("assistant", "agent", "Try the Brief tab, then Ops (cron + kanban) and the Cost page. Writes are locked on this demo box."),
            ]),
        ]
        for ti, (title, msgs) in enumerate(threads):
            # Ids follow the content: re-seeding unchanged data reuses them, so a
            # device's cached tail keeps matching; an edit mints new ones, so a
            # stale tail cannot collide. See demo_id.
            tid = demo_id("thr_demo", title, *(text for _, _, text in msgs))
            store.get_or_create_thread(tid, kind="chat", title=title)
            # A turn = a user message and the reply it produced, sharing one
            # run_id — the real gateway assigns one, and the app's transcript
            # uses it to collapse a reply the server delivers twice ("messages
            # are double sending", dropRepeatedProse in chat/transcript.ts).
            # Seeding run_id=None left that guard disabled for demo threads.
            run = 0
            for mi, (role, author_type, text) in enumerate(msgs):
                if role == "user":
                    run += 1
                store.insert_message(
                    thread_id=tid, role=role, author_type=author_type,
                    parts=[{"type": "text", "text": text}], status="complete",
                    run_id=f"run_demo_{ti + 1}_{run}",
                    message_id=demo_id("msg_demo", tid, str(mi)),
                )

        # A gallery of every chat widget this build can draw, so the demo shows the
        # real renderers rather than describing them. Only kinds the native app's
        # parser accepts (app/src/chat/widget.ts PARSERS) — anything else would draw
        # "Could not draw this widget". All figures are fictional, like the rest of
        # the demo. Part shape: {"type": "widget", "kind": ..., "props": {...}}.
        today = datetime.now(timezone.utc).date()

        def iso(offset: int) -> str:
            return (today + timedelta(days=offset)).isoformat()

        gallery = [
            ("assistant", "agent", [{"type": "text",
             "text": "Everything in this thread is a Hub widget drawn from fictional demo data — scroll for every widget kind this build draws, except the shopping ones, which live in the demo's own order thread where they sit in a real back-and-forth."}]),
            # --- status + one number: the shapes a daily check-in uses ---------
            ("assistant", "agent", [{"type": "text",
             "text": "Starting with the small ones: a status card and a single headline number."}]),
            ("assistant", "agent", [
                {"type": "widget", "kind": "card", "props": {
                    "title": "Demo Agent", "subtitle": "everything here is fictional",
                    "rows": [
                        {"label": "status", "value": "up", "tone": "up"},
                        {"label": "model", "value": "claude-sonnet-5", "tone": "neutral"},
                        {"label": "messages today", "value": "37", "tone": "accent"},
                    ],
                }},
                {"type": "widget", "kind": "metric", "props": {
                    "label": "spend this month", "value": "1284.20", "unit": "USD",
                    "delta": "-12% vs last month", "delta_tone": "up", "caption": "demo ledger",
                }},
            ]),
            # --- trends and records --------------------------------------------
            ("assistant", "agent", [{"type": "text",
             "text": "Two ways to show a series over time: a chart, and the same week as a table when you want the exact numbers."}]),
            ("assistant", "agent", [
                {"type": "widget", "kind": "chart", "props": {
                    "variant": "bars", "title": "spend by day", "unit": "USD",
                    "series": [{"id": "spend", "label": "spend", "color": "series-1"}],
                    "buckets": [
                        {"key": iso(-4), "values": {"spend": 42.75}},
                        {"key": iso(-3), "values": {"spend": 88.10}},
                        {"key": iso(-2), "values": {"spend": 61.40}},
                        {"key": iso(-1), "values": {"spend": 132.30}},
                        {"key": iso(0), "values": {"spend": 24.10}},
                    ],
                }},
            ]),
            ("assistant", "agent", [
                {"type": "widget", "kind": "table", "props": {
                    "title": "demo cron jobs",
                    "columns": [
                        {"key": "job", "label": "job"}, {"key": "cadence", "label": "cadence"},
                        {"key": "last", "label": "last run"}, {"key": "cost", "label": "cost", "align": "right"},
                    ],
                    "rows": [
                        {"job": "demo-briefing", "cadence": "daily 7am", "last": "ok", "cost": "$0.42"},
                        {"job": "demo-healthcheck", "cadence": "every 15m", "last": "ok", "cost": "$0.03"},
                        {"job": "demo-inbox-sweep", "cadence": "hourly", "last": "ok", "cost": "$1.10"},
                        {"job": "demo-nightly-backup", "cadence": "daily 3am", "last": "cost unknown", "cost": "—"},
                    ],
                }},
            ]),
            ("assistant", "agent", [
                {"type": "widget", "kind": "progress", "props": {
                    "label": "demo backup", "value": 3, "total": 5, "caption": "3 of 5 snapshots retained", "tone": "accent",
                }},
                {"type": "widget", "kind": "link", "props": {
                    "url": "https://example.com/demo-hub", "title": "Demo hub notes",
                    "subtitle": "a link widget (https only)",
                }},
            ]),
            # --- work in progress, and a history -------------------------------
            ("assistant", "agent", [{"type": "text",
             "text": "A plan in flight, and next to it an event log — same rows, different shapes: a checklist is something to do, a timeline is something that happened."}]),
            ("assistant", "agent", [
                {"type": "widget", "kind": "checklist", "props": {
                    "title": "demo release plan",
                    "items": [
                        {"label": "cut the branch", "state": "done", "note": "done 09:10"},
                        {"label": "run the suite", "state": "done", "note": "green in 41s"},
                        {"label": "stage the build", "state": "doing", "note": "in progress"},
                        {"label": "sign off", "state": "todo", "note": "waiting on review"},
                        {"label": "publish", "state": "blocked", "note": "blocked on sign-off"},
                    ],
                }},
                {"type": "widget", "kind": "timeline", "props": {
                    "title": "demo package history", "caption": "a timeline, not a to-do list",
                    "items": [
                        {"time": "Mon 09:02", "label": "label created", "detail": "Demo Post", "tone": "neutral"},
                        {"time": "Mon 15:40", "label": "in transit", "detail": "left the depot", "tone": "accent"},
                        {"time": "Tue 08:12", "label": "out for delivery", "tone": "accent"},
                        {"time": "Tue 11:05", "label": "delivered", "detail": "front door", "tone": "up"},
                    ],
                }},
            ]),
            # --- two live surfaces: a week, and the weather over it -------------
            ("assistant", "agent", [{"type": "text",
             "text": "And two that pull a real sense of the day: the week ahead, and the weather over it."}]),
            ("assistant", "agent", [
                {"type": "widget", "kind": "calendar", "props": {
                    "view": "week", "title": "demo week",
                    "days": [
                        {"date": iso(0), "label": "today", "events": [
                            {"title": "demo standup", "start": "09:30", "end": "09:45"},
                            {"title": "supplier call", "start": "14:00", "end": "14:30", "location": "phone"},
                        ]},
                        {"date": iso(1), "events": [
                            {"title": "deep work", "start": "10:00", "end": "12:00"},
                        ]},
                        {"date": iso(2), "events": [
                            {"title": "demo review", "start": "16:00", "end": "17:00"},
                        ]},
                    ],
                }},
            ]),
            ("assistant", "agent", [
                {"type": "widget", "kind": "weather", "props": {
                    "view": "conditions", "place": "Demo City", "temp": 61, "feels_like": 58,
                    "summary": "partly cloudy",
                    "hours": [
                        {"label": "Now", "temp": 61, "condition": "partly_cloudy", "precip": 5},
                        {"label": "2pm", "temp": 64, "condition": "clear", "precip": 0},
                        {"label": "4pm", "temp": 63, "condition": "cloudy", "precip": 15},
                        {"label": "6pm", "temp": 58, "condition": "rain", "precip": 60, "night": True},
                    ],
                    "days": [
                        {"label": "today", "low": 52, "high": 64, "condition": "partly_cloudy", "precip": 15},
                        {"label": "tomorrow", "low": 55, "high": 66, "condition": "rain", "precip": 70, "precip_in": 0.4},
                        {"label": "day 3", "low": 50, "high": 61, "condition": "cloudy", "precip": 30},
                    ],
                }},
            ]),
            # --- the display-only kinds ---------------------------------------
            ("assistant", "agent", [{"type": "text",
             "text": "Last three: a button row, a poll and a form. In chat these draw but return nothing when tapped — only server-rendered pages can post back, so they sit here as honest examples of that."}]),
            ("assistant", "agent", [
                {"type": "widget", "kind": "button_row", "props": {
                    "prompt": "these draw but return nothing — tap away",
                    "buttons": [
                        {"id": "a", "label": "Refresh"}, {"id": "b", "label": "Details"}, {"id": "c", "label": "Dismiss"},
                    ],
                }},
                {"type": "widget", "kind": "poll", "props": {
                    "question": "which demo thread did you find most useful?",
                    "options": [
                        {"id": "trip", "label": "Trip planning", "votes": 2},
                        {"id": "home", "label": "Home projects", "votes": 1},
                        {"id": "widgets", "label": "Widget gallery", "votes": 5},
                    ],
                }},
                {"type": "widget", "kind": "form", "props": {
                    "title": "a form draws only — chat has no JS to submit it",
                    "fields": [
                        {"id": "note", "label": "note", "type": "text"},
                        {"id": "count", "label": "count", "type": "number"},
                        {"id": "details", "label": "details", "type": "textarea"},
                    ],
                }},
            ]),
        ]
        gallery_title = "Widget gallery"
        gallery_tid = demo_id("thr_demo", gallery_title, json.dumps(gallery, sort_keys=True))
        store.get_or_create_thread(gallery_tid, kind="chat", title=gallery_title)
        for gi, (role, author_type, parts) in enumerate(gallery):
            store.insert_message(
                thread_id=gallery_tid, role=role, author_type=author_type,
                parts=parts, status="complete",
                run_id=f"run_demo_gallery_{gi + 1}",
                message_id=demo_id("msg_demo", gallery_tid, str(gi)),
            )

        # The shopping kinds, in the shape they're actually used: a request, a
        # listing, a basket to confirm, a receipt. A catalog row shows the shape;
        # a conversation is what tells you whether it reads right in context.
        PITCHER = {"name": "Demo water filter pitcher, 10-cup", "price": "$21.99", "qty": 1}
        shop = [
            ("assistant", "agent", [{"type": "text",
             "text": "Mock shopping flow — nothing here is really bought, and no card is touched."}]),
            ("user", "human", [{"type": "text",
             "text": "The water pitcher in the demo kitchen finally cracked. Can you find me a replacement?"}]),
            ("assistant", "agent", [
                {"type": "text", "text": "One on sale at Demo Market, and it's well reviewed:"},
                {"type": "widget", "kind": "product", "props": {
                    "title": "Demo water filter pitcher, 10-cup", "merchant": "Demo Market",
                    "price": "$21.99", "was": "$27.99", "rating": 4.6, "reviews": 218,
                    "eta": "arrives Tue", "badge": "best seller", "badge_tone": "up",
                    "url": "https://example.com/demo-market/pitcher",
                }},
            ]),
            ("user", "human", [{"type": "text",
             "text": "Good, that's the one. Show me the basket."}]),
            ("assistant", "agent", [
                {"type": "text", "text": "In the basket — free shipping over $20, so the only extra is tax:"},
                {"type": "widget", "kind": "cart", "props": {
                    "title": "Demo Market", "subtotal": "$21.99", "shipping": "$0.00",
                    "tax": "$1.50", "total": "$23.49",
                    "items": [PITCHER],
                }},
            ]),
            ("user", "human", [{"type": "text", "text": "Go ahead."}]),
            ("assistant", "agent", [
                {"type": "text", "text": "Before I place it, I'm issuing the card for this order — that's how I spend on your behalf: one card, capped at the total, tied to this merchant, and it dies after one charge."},
                {"type": "widget", "kind": "card", "props": {
                    "title": "Single-use card request",
                    "subtitle": "Demo Market · this order only",
                    "body": "One virtual card, capped at the order total and merchant-scoped — nothing else can be charged to it.",
                    "rows": [
                        {"label": "Amount", "value": "$23.49", "tone": "accent"},
                        {"label": "Merchant", "value": "Demo Market"},
                        {"label": "Use", "value": "single-use"},
                        {"label": "Expires", "value": "10 minutes", "tone": "warn"},
                    ],
                }},
                {"type": "widget", "kind": "button_row", "props": {
                    "prompt": "Approve this card request?",
                    "buttons": [
                        {"id": "approve", "label": "Approve"},
                        {"id": "decline", "label": "Decline"},
                    ],
                }},
            ]),
            ("assistant", "agent", [
                {"type": "text", "text": "Approved — the card was issued for $23.49 and charged once. Nothing else was touched:"},
                {"type": "widget", "kind": "order", "props": {
                    "order_id": "DEMO-4471", "placed": "Sun 4 Oct, 4:12 pm",
                    "subtotal": "$21.99", "shipping": "$0.00", "tax": "$1.50", "total": "$23.49",
                    "payment": "Single-use card ·· 8841", "address": "1 Demo Way, Demo City",
                    "eta": "arrives Tue 6 Oct",
                    "url": "https://example.com/demo-market/orders/DEMO-4471",
                    "items": [PITCHER],
                }},
            ]),
            ("assistant", "agent", [{"type": "text",
             "text": "Confirmation is in the demo inbox. I'll flag it here if the delivery date slips."}]),
        ]
        shop_title = "Ordering a demo pitcher"
        shop_tid = demo_id("thr_demo", shop_title, json.dumps(shop, sort_keys=True))
        store.get_or_create_thread(shop_tid, kind="chat", title=shop_title)
        for si, (role, author_type, parts) in enumerate(shop):
            store.insert_message(
                thread_id=shop_tid, role=role, author_type=author_type,
                parts=parts, status="complete",
                run_id=f"run_demo_shop_{si // 2 + 1}",
                message_id=demo_id("msg_demo", shop_tid, str(si)),
            )
    finally:
        store.close()
    write_text(CHAT_SESSIONS, "{}\n")


# ---------------------------------------------------------------------------
# Automations (chat/automation_store.py -> /api/chat/automations, the badge)
# ---------------------------------------------------------------------------
def seed_automations() -> None:
    """The Automations tab: the stub bridge's four cron jobs and a few days of
    their runs, fed through the server's own AutomationStore the way the
    hub-platform plugin's sync feeds it. The healthcheck's newest run is a
    warning, so one job needs you and the tab carries a badge; the backup job is
    paused and writes only `local`, so its failure is background."""
    sys.path.insert(0, str(SERVER_DIR))
    from chat.automation_store import AutomationStore
    from chat.store import ChatStore

    now = datetime.now(timezone.utc).replace(microsecond=0)

    def ago(**kw) -> str:
        return (now - timedelta(**kw)).strftime("%Y-%m-%dT%H:%M:%SZ")

    def ahead(**kw) -> str:
        return (now + timedelta(**kw)).isoformat()

    jobs = [
        {"id": "demo-briefing", "name": "Morning briefing", "schedule": "30 7 * * *",
         "deliver": "discord:brief", "state": "active", "mode": "agent",
         "next_run_at": ahead(hours=14), "last_status": "ok"},
        {"id": "demo-healthcheck", "name": "Service healthcheck", "schedule": "*/15 * * * *",
         "deliver": "discord:ops", "state": "active", "mode": "script",
         "next_run_at": ahead(minutes=9), "last_status": "ok"},
        {"id": "demo-inbox-sweep", "name": "Inbox sweep", "schedule": "0 */2 * * *",
         "deliver": "discord:ops", "state": "active", "mode": "agent",
         "next_run_at": ahead(hours=1), "last_status": "ok"},
        {"id": "demo-nightly-backup", "name": "Nightly backup", "schedule": "0 3 * * *",
         "deliver": "local", "state": "paused", "mode": "script",
         "last_status": "failed", "last_error": "target volume 'demo-archive' not mounted"},
    ]
    briefing = ("Built today's briefing: 6 items.\n"
                "- Reply to Xavier about the demo trip\n"
                "- Approve the demo garage scope\n"
                "- Demo standup at 11:00\n"
                "- Package arriving today\n"
                "- Renew the demo domain\n"
                "- Demo newsletter, 3 releases worth a look")
    runs = [
        ("demo-briefing", ago(hours=10), "ok", briefing),
        ("demo-briefing", ago(days=1, hours=10), "ok",
         "Built the briefing: 5 items.\n- Demo review moved to Thursday\n- Two parcels out for delivery\n"
         "- Demo newsletter, 2 releases\n- Garage quote arrived\n- Trip dates still open"),
        ("demo-briefing", ago(days=2, hours=10), "ok",
         "Built the briefing: 4 items.\n- Demo standup at 09:30\n- Renewal reminder for the demo domain\n"
         "- One parcel delivered\n- Nothing waiting on you"),
        ("demo-healthcheck", ago(minutes=75), "ok", ""),
        ("demo-healthcheck", ago(minutes=60), "ok", ""),
        ("demo-healthcheck", ago(minutes=45), "ok", ""),
        ("demo-healthcheck", ago(minutes=30), "ok", ""),
        ("demo-healthcheck", ago(minutes=15), "ok",
         "⚠️ demo-backup degraded: the archive volume is not mounted.\n- 5 of 6 demo services up\n"
         "- last good snapshot 2 days ago"),
        ("demo-inbox-sweep", ago(hours=5), "ok", ""),
        ("demo-inbox-sweep", ago(hours=3), "ok", "Swept 9 messages, nothing flagged."),
        ("demo-inbox-sweep", ago(hours=1), "ok",
         "Swept 14 messages: filed 3, flagged 1 for the approvals queue.\n"
         "- Demo Market: order confirmation\n- Demo Post: delivery window\n- Demo Bank: statement ready"),
        ("demo-nightly-backup", ago(days=2, hours=5), "ok", "Snapshot demo-snap-0002 saved: 1.2 GiB, 18301 files."),
        ("demo-nightly-backup", ago(days=1, hours=5), "failed",
         "demo-backup: target volume 'demo-archive' not mounted; skipped."),
    ]
    names = {j["id"]: j["name"] for j in jobs}

    store = ChatStore(CHAT_DB, CHAT_MEDIA)
    try:
        autos = AutomationStore(store)
        autos.upsert_jobs(jobs, complete=True)
        autos.upsert_runs([
            {"run_id": f"{job_id}:run-{i:02d}", "job_id": job_id,
             "job_name": names[job_id], "run_time": run_time, "status": status, "output": output}
            for i, (job_id, run_time, status, output) in enumerate(runs)
        ], source="file")
    finally:
        store.close()


# ---------------------------------------------------------------------------
# Calendar snapshot (hub_calendar.py -> /api/calendar)
# ---------------------------------------------------------------------------
def seed_calendar() -> None:
    """The host's calendar snapshot, shaped for hub_calendar.py.

    Days are HUB_TZ days throughout: an event late in the local evening belongs to
    that evening, not to the UTC day it has crossed into. Events are placed relative
    to today so the demo always shows a live-looking week, and `slices` carries
    a fresh ok_at for the near weeks — a slice overdue by twice its cadence is
    how the server reports a FAILING sync, which is not the state to demo.
    """
    now_local = datetime.now(TZ)
    today = now_local.date()
    now_iso = now_local.isoformat(timespec="seconds")

    def at(day_offset: int, hh: int, mm: int = 0) -> str:
        d = today + timedelta(days=day_offset)
        return datetime(d.year, d.month, d.day, hh, mm, tzinfo=TZ).isoformat(timespec="seconds")

    def day(day_offset: int) -> str:
        return (today + timedelta(days=day_offset)).isoformat()

    events = [
        {"id": "demo-ev-0001", "title": "Demo standup", "account": "work", "all_day": False,
         "start": at(0, 9, 30), "end": at(0, 9, 45), "start_date": None, "end_date": None,
         "location": None, "conference_url": "https://meet.example.com/demo-standup",
         "organizer": "Dana R.", "attendee_count": 6},
        {"id": "demo-ev-0002", "title": "Supplier call — q4 volumes", "account": "work", "all_day": False,
         "start": at(0, 14, 0), "end": at(0, 14, 30), "start_date": None, "end_date": None,
         "location": "phone", "conference_url": None, "organizer": "Supplier Co.", "attendee_count": 3},
        {"id": "demo-ev-0003", "title": "Focus block — pipeline rewrite", "account": "work", "all_day": False,
         "start": at(1, 10, 0), "end": at(1, 12, 0), "start_date": None, "end_date": None,
         "location": None, "conference_url": None, "organizer": None, "attendee_count": None},
        {"id": "demo-ev-0004", "title": "Demo review", "account": "work", "all_day": False,
         "start": at(2, 16, 0), "end": at(2, 17, 0), "start_date": None, "end_date": None,
         "location": "Room 2", "conference_url": "https://meet.example.com/demo-review",
         "organizer": "Priya S.", "attendee_count": 8},
        # An all-day event: end_date is EXCLUSIVE (one day later = one day long).
        {"id": "demo-ev-0005", "title": "Public holiday (demo)", "account": "personal", "all_day": True,
         "start": None, "end": None, "start_date": day(5), "end_date": day(6),
         "location": None, "conference_url": None, "organizer": None, "attendee_count": None},
        {"id": "demo-ev-0006", "title": "Dinner with Xavier", "account": "personal", "all_day": False,
         "start": at(4, 19, 0), "end": at(4, 21, 0), "start_date": None, "end_date": None,
         "location": "Demo Bistro", "conference_url": None, "organizer": None, "attendee_count": 2},
        {"id": "demo-ev-0007", "title": "Quarterly planning", "account": "work", "all_day": False,
         "start": at(7, 13, 0), "end": at(7, 15, 0), "start_date": None, "end_date": None,
         "location": "Room 1", "conference_url": None, "organizer": "Dana R.", "attendee_count": 12},
    ]

    monday = today - timedelta(days=today.weekday())
    slices = {}
    for week in (-1, 0, 1, 2):
        key_day = (monday + timedelta(weeks=week)).isoformat()
        for account in ("work", "personal"):
            slices[f"{key_day}|{account}"] = {"ok_at": now_iso, "events": len(
                [e for e in events if e["account"] == account])}

    write_json(CALENDAR_SNAPSHOT, {
        "synced_at": now_iso,
        "events": events,
        "slices": slices,
    })


# ---------------------------------------------------------------------------
# Misc ready-state files
# ---------------------------------------------------------------------------
def seed_misc() -> None:
    write_json(BRIEF_DISMISSALS, {"dismissed": {}, "snoozed": {}})
    write_text(BRIEF_FEEDBACK, "")
    write_json(BRIEF_RULES, {"rules": []})
    write_json(PUSH_TOKENS, {"tokens": [
        {"token": "ExponentPushToken[DEMOdemoDEMO0123456789abc]", "label": "Demo iPhone",
         "registered_at": now_iso()},
    ]})
    # Routing config + live snapshot so /api/config/topics renders (fictional).
    write_json(TOPICS_CONFIG, {
        "chat_id": "1002003000",
        "topics": {"ops": 1, "brief": 2, "money": 3, "approvals": 4},
        "routes": {
            "demo-briefing": "brief",
            "demo-healthcheck": "ops",
            "demo-inbox-sweep": "ops",
            "demo-nightly-backup": "local",
            "healthcheck": "ops",
            "imessage-approvals": "approvals",
        },
        "pending_sync": False,
    })
    write_json(TOPICS_LIVE, {
        "ts": now_iso(),
        "jobs": {
            "demo-briefing": "telegram:1002003000:2",
            "demo-healthcheck": "telegram:1002003000:1",
            "demo-inbox-sweep": "telegram:1002003000:1",
        },
        "approvals_topic": {"chat_id": "1002003000", "message_thread_id": 4},
    })
    # A small workspace so /api/files roots/browse have something to show.
    write_json(DEMO_ROOT / "Sites" / "demo-app" / "config.json",
               {"name": "demo-app", "port": 9100, "debug": False})
    write_text(DEMO_ROOT / "workspace" / "notes.md",
               "# Demo workspace\n\nThis file exists so the demo Files browser has content.\n")


# The top-level names seed.py itself creates — anything else inside DEMO_ROOT
# is not ours, and a reset that would destroy it must refuse.
_OWN_TOP_LEVEL = {".hub", "Sites", "chat", "data", "decisions", "finance",
                  "hub-config", "hub-inbox", "log", "sites", "workspace", "auth",
                  # the launcher's pid file (demo/start-demo.sh) — ours, and
                  # rewriting the tree around it is the normal re-seed path
                  "demo.pid", "demo.log"}

# Runtime state a human created (Face ID pairing), not seeded data: a re-seed must
# NOT un-pair the phone. Preserved across resets. The launcher's pid file and log
# ride along: a re-seed while the demo runs must not delete the pid that
# demo/stop-demo.sh stops it with (losing it falls back to signalling the
# children, which makes the launcher exit non-zero — a "failed" task card).
_PRESERVE_ON_RESET = {"auth", "demo.pid", "demo.log"}


def reset_demo_root() -> None:
    """Idempotency: seed.py must leave the SAME state on a re-run, not append
    to it (chat messages have no dedup key and would double). Remove the
    previous demo tree first, except runtime state a human created (the paired
    device key under auth/). Guard: only wipe a directory whose contents are
    recognisably ours."""
    if DEMO_ROOT.exists():
        if DEMO_ROOT == Path("/") or not DEMO_ROOT.is_dir():
            raise SystemExit(f"refusing to reset DEMO_ROOT={DEMO_ROOT}")
        unexpected = [p.name for p in DEMO_ROOT.iterdir() if p.name not in _OWN_TOP_LEVEL]
        if unexpected:
            raise SystemExit(
                f"refusing to reset DEMO_ROOT={DEMO_ROOT}: it holds non-demo entries {unexpected}"
            )
        for child in DEMO_ROOT.iterdir():
            if child.name in _PRESERVE_ON_RESET:
                continue
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()


def main() -> int:
    reset_demo_root()
    for d in (LOG_DIR, HUB_DIR, MY_PAGES_ROOT, INBOX_DIR, DECISIONS_DIR,
              FINANCE_SNAPSHOT.parent, RECURRING_COSTS.parent, CHAT_DB.parent):
        d.mkdir(parents=True, exist_ok=True)
    seed_health()
    seed_restic()
    seed_mcp_watch()
    seed_audit()
    seed_roster()
    seed_activity()
    seed_schedules()
    seed_skills()
    seed_inbox()
    seed_decisions()
    seed_finance()
    seed_my_pages()
    seed_chat()
    seed_automations()
    seed_calendar()
    seed_misc()
    print(f"seeded demo data under {DEMO_ROOT}")
    print(f"  briefing: {MY_PAGES_ROOT / _brief_slug()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
