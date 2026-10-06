#!/usr/bin/env python3
"""Regenerate the app's demo-mode fixtures (app/src/demo/fixtures.json).

Demo mode (app/src/demo/) answers every read from this file instead of a server.
The file is not written by hand: this script builds the repo's own fictional demo
seed (demo/seed.py) into a throwaway DEMO_ROOT, serves the stub bridge
(demo/bridge.py) on an ephemeral 127.0.0.1 port, imports the server with the same
environment demo/start-demo.sh exports, and records what every GET the app makes
answers, through FastAPI's TestClient. Nothing listens beyond loopback, nothing
outside the temp tree is read or written, and the tree is removed afterwards.

Three edits are made on the way, each for the app demo only:
  - the shopping thread (a single-use card request) is left out, and the two
    seeded sentences that only hold on the server demo are reworded (TEXT_EDITS);
  - each brief item gets a `token`: the generator mints these in production, the
    seed has none, and the app will not dismiss an item without one;
  - the Files root the app opens on (`code`) is the seed's workspace.

    server/.venv/bin/python app/scripts/demo-fixtures.py
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tempfile
import threading
from datetime import date, datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "app" / "src" / "demo" / "fixtures.json"

SHOP_THREAD_TITLE = "Ordering a demo pitcher"
# (thread title, seeded words, the app demo's words). The seed describes the
# server demo, where the order thread exists and every write is refused.
TEXT_EDITS = (
    ("Widget gallery",
     ", except the shopping ones, which live in the demo's own order thread "
     "where they sit in a real back-and-forth", ""),
    ("Demo hub tour", "Writes are locked on this demo box.",
     "Anything you change stays on this iPhone."),
)
SPEND_WINDOWS = ("today", "7d", "30d", "mtd")
# Where the recorded paths say the data lives, in place of this machine's temp dir.
PLACEHOLDER_ROOT = "/srv/xavier-demo"
FILE_DEPTH = 3


def demo_env(root: Path) -> dict[str, str]:
    """demo/start-demo.sh's exports, pointed at `root`. Every path the server
    would otherwise default (some to the home directory) is named here."""
    return {
        "DEMO_ROOT": str(root),
        "HUB_BRIDGE_TIMEOUT_S": "35",
        "MY_PAGES_ROOT": f"{root}/Sites/my-pages",
        "HUB_LOG_DIR": f"{root}/log",
        "HUB_ACCESS_REPORT": f"{root}/.hub/access-report.json",
        "HUB_ROSTER": f"{root}/.hub/agents.json",
        "HUB_ACTIVITY": f"{root}/.hub/activity.json",
        "HUB_SCHEDULES": f"{root}/.hub/schedules.json",
        "HUB_SKILLS": f"{root}/.hub/skills.json",
        "HUB_INBOX_DIR": f"{root}/hub-inbox",
        "HUB_DECISIONS_DIR": f"{root}/decisions",
        "HUB_FINANCE_SNAPSHOT": f"{root}/sites/finance/snapshot.json",
        "HUB_RECURRING_COSTS": f"{root}/finance/recurring-costs.json",
        "HUB_MCP_WATCH_LOG": f"{root}/log/mcp-watch.jsonl",
        "HUB_CHAT_DB": f"{root}/chat/chat.db",
        "HUB_CHAT_MEDIA_DIR": f"{root}/chat/media",
        "HUB_CHAT_SESSIONS_FILE": f"{root}/chat/sessions.json",
        "HUB_CHAT_COMMAND_CATALOG": f"{root}/chat/commands-catalog.json",
        "HUB_BRIEFING_DISMISSALS": f"{root}/data/briefing_dismissals.json",
        "HUB_BRIEFING_FEEDBACK": f"{root}/data/briefing_feedback.jsonl",
        "HUB_BRIEFING_RULES": f"{root}/data/briefing_rules.json",
        "HUB_PUSH_TOKENS": f"{root}/data/push_tokens.json",
        "HUB_TOPICS_CONFIG": f"{root}/hub-config/telegram-topics.json",
        "HUB_TOPICS_LIVE": f"{root}/hub-config/telegram-topics.live.json",
        "HUB_CALENDAR": f"{root}/hub-config/calendar.json",
        "HUB_CALENDAR_SYNC_REQUEST": f"{root}/hub-config/calendar-sync.request",
        "HUB_FS_ROOTS": (f"sites:Sites:{root}/Sites;code:Code:{root}/workspace;"
                         f"hub_config:.hub:{root}/.hub"),
        # The shells are server-only in the app demo; an empty socket path makes
        # the server answer 503 rather than reach any host daemon.
        "HUB_TMUXD_SOCK": "",
        "HUB_TTYD_SOCK": "",
        "HERMES_API_KEY": "demo-not-a-secret",
        "HERMES_AGENT_ID": "demo-agent",
        "HERMES_AGENT_NAME": "Demo Agent",
        "HERMES_CRON_OUTPUT_DIR": f"{root}/cron/output",
        "HUB_TZ": "UTC",
        "HUB_ORIGIN": "",
        "HUB_RP_NAME": "Hub (demo)",
        "HUB_USER_NAME": "demo-user",
        "HUB_USER_DISPLAY": "Demo User",
        "HUB_PASSKEYS": f"{root}/auth/passkeys.json",
        "HUB_DEVICEKEYS": f"{root}/auth/devicekeys.json",
        "HUB_PAIR_SOCK": f"{root}/auth/pair.sock",
        "HUB_PLATFORM_KEY_FILE": f"{root}/auth/no-platform-key",
        "HUB_BRIDGE_KEY_FILE": f"{root}/auth/no-bridge-key",
        "HUB_BRIEF_DISMISS_KEY_FILE": f"{root}/auth/no-dismiss-key",
        # FastAPI's TestClient sends `Host: testserver` (server/conftest.py).
        "HUB_ALLOWED_HOSTS": "testserver",
    }


def start_bridge() -> tuple[ThreadingHTTPServer, str]:
    import bridge  # demo/bridge.py

    srv = ThreadingHTTPServer(("127.0.0.1", 0), bridge.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


class Recorder:
    def __init__(self, client):
        self.client = client
        self.routes: dict[str, dict] = {}

    def get(self, path: str, key: str | None = None) -> dict | list | None:
        res = self.client.get(f"/api{path}")
        body = res.json() if res.headers.get("content-type", "").startswith("application/json") else None
        self.routes[key or f"GET {path}"] = {"status": res.status_code, "body": body}
        return body if res.status_code == 200 else None

    def post(self, path: str, payload: dict, key: str) -> dict | None:
        res = self.client.post(f"/api{path}", json=payload)
        body = res.json()
        self.routes[key] = {"status": res.status_code, "body": body}
        return body if res.status_code == 200 else None


def drop_shop_thread(rec: Recorder) -> set[str]:
    boot = rec.routes["GET /chat/bootstrap"]["body"]
    shop = {t["id"] for t in boot["threads"] if t["title"] == SHOP_THREAD_TITLE}
    assert shop, "the seed's shopping thread was not found; update SHOP_THREAD_TITLE"
    boot["threads"] = [t for t in boot["threads"] if t["id"] not in shop]
    att = rec.routes["GET /chat/attention"]["body"]
    att["attention"] = [a for a in att["attention"] if a["thread_id"] not in shop]
    return shop


def edit_text(detail: dict, old: str, new: str) -> None:
    for message in detail["messages"]:
        for part in message["parts"]:
            if part.get("type") == "text" and old in part["text"]:
                part["text"] = part["text"].replace(old, new)
                return
    raise AssertionError(f"seeded text changed, update TEXT_EDITS: {old!r}")


def token_brief(brief: dict) -> None:
    for items in brief["buckets"].values():
        for item in items:
            item["token"] = hashlib.sha256(f"demo:{item['item_id']}".encode()).hexdigest()[:24]


def walk_files(rec: Recorder, root: str, path: str, depth: int) -> None:
    from urllib.parse import quote

    listing = rec.get(f"/files/browse?root={quote(root)}&path={quote(path)}")
    if not listing or depth == 0:
        return
    for entry in listing["entries"]:
        child = f"{path}/{entry['name']}" if path else entry["name"]
        if entry["kind"] == "dir":
            walk_files(rec, root, child, depth - 1)
        elif entry["kind"] == "file":
            rec.get(f"/files/read?root={quote(root)}&path={quote(child)}")


def record(rec: Recorder, anchor: date) -> dict[str, str]:
    for path in ("/health", "/backups", "/my-pages", "/feed", "/vitals", "/sessions", "/cron",
                 "/cron/costs", "/kanban", "/skills", "/plugins", "/mcp", "/memory", "/doctor",
                 "/pairing", "/browser/sessions", "/cost/openrouter", "/config/full", "/advisor",
                 "/connectors", "/chat/models", "/finance", "/passkey/status", "/config/topics",
                 "/briefing/rules.json", "/decisions", "/files/roots", "/chat/bootstrap",
                 "/chat/commands", "/chat/attention", "/chat/automations", "/automations/badge"):
        rec.get(path)
    # The app asks for 10 or 15; one generous read serves any limit.
    rec.get("/cron/logs?limit=200", key="GET /cron/logs")
    for window in SPEND_WINDOWS:
        rec.get(f"/spend/summary?window={window}")
        rec.get(f"/spend/timeseries?window={window}")
        rec.get(f"/cost/recurring?window={window}")
    for session in rec.routes["GET /sessions"]["body"]["data"]:
        rec.get(f"/sessions/{session['id']}")
        rec.get(f"/sessions/{session['id']}/messages")

    start = anchor - timedelta(days=14)
    rec.get(f"/calendar?from={start}&to={start + timedelta(days=62)}", key="GET /calendar")

    brief = rec.get("/brief")
    token_brief(brief)

    for root in rec.routes["GET /files/roots"]["body"]:
        walk_files(rec, root["id"], "", FILE_DEPTH)

    shop = drop_shop_thread(rec)
    for thread in rec.routes["GET /chat/bootstrap"]["body"]["threads"]:
        detail = rec.get(f"/chat/threads/{thread['id']}?after_seq=0", key=f"GET /chat/threads/{thread['id']}")
        for title, old, new in TEXT_EDITS:
            if thread["title"] == title:
                edit_text(detail, old, new)
                for row in (thread, detail["thread"]):
                    if row["preview"] and old in row["preview"]:
                        row["preview"] = row["preview"].replace(old, new)

    # Automations as first seen, then each piece again once everything is read:
    # the demo swaps a job's summary for its read one when it is marked read.
    before = None
    timeline = rec.get("/chat/automations/timeline", key="GET /chat/automations/timeline")
    while timeline and timeline.get("before") and timeline["before"] != before:
        before = timeline["before"]
        timeline = rec.get(f"/chat/automations/timeline?before={before}")
    jobs = rec.routes["GET /chat/automations"]["body"]["jobs"]
    for job in jobs:
        rec.get(f"/chat/automations/jobs/{job['id']}")
    runs = [
        item["run"]["run_id"]
        for job in jobs
        for item in rec.routes[f"GET /chat/automations/jobs/{job['id']}"]["body"]["items"]
        if item["kind"] == "run"
    ]
    for run_id in runs:
        opened = rec.post(f"/chat/automations/runs/{run_id}/open", {}, key=f"POST /chat/automations/runs/{run_id}/open")
        thread_id = opened["thread"]["id"]
        rec.get(f"/chat/threads/{thread_id}?after_seq=0", key=f"GET /chat/threads/{thread_id}")
    for job in jobs:
        rec.post(f"/chat/automations/jobs/{job['id']}/read", {}, key=f"POST /chat/automations/jobs/{job['id']}/read")
        rec.get(f"/chat/automations/jobs/{job['id']}", key=f"GET /chat/automations/jobs/{job['id']}#read")
    rec.get("/chat/automations", key="GET /chat/automations#read")
    rec.get("/chat/automations/timeline", key="GET /chat/automations/timeline#read")

    pages = {}
    for page in rec.routes["GET /my-pages"]["body"]["pages"]:
        path = f"/my-pages/{page['slug']}/"
        res = rec.client.get(path)
        if res.status_code == 200:
            pages[path] = res.text

    blob = json.dumps(rec.routes)
    for leftover in [*shop, "pitcher", "Single-use", "single-use"]:
        assert leftover not in blob, f"the shopping thread leaked into the fixtures: {leftover!r}"
    return pages


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="xavier-demo-fixtures-"))
    root = tmp / "data"
    for name in ("OPENROUTER_API_KEY", "OPENROUTER_MGMT_KEY"):
        os.environ.pop(name, None)
    os.environ.update(demo_env(root))
    os.chdir(tmp)
    sys.path.insert(0, str(REPO / "demo"))
    sys.path.insert(0, str(REPO / "server"))
    bridge_srv = None
    try:
        generated_at = datetime.now(timezone.utc).replace(microsecond=0)
        import seed

        seed.main()
        bridge_srv, bridge_url = start_bridge()
        os.environ["HUB_BRIDGE_URL"] = bridge_url
        os.environ["HERMES_API_BASE"] = bridge_url

        from fastapi.testclient import TestClient

        import app as hub
        from chat import session

        client = TestClient(hub.app)
        client.cookies.set("hub_chat_session", session._chat_session_new())
        rec = Recorder(client)
        pages = record(rec, generated_at.date())

        fixtures = {
            "meta": {
                "generated_at": generated_at.isoformat().replace("+00:00", "Z"),
                # The seed's "today" (HUB_TZ=UTC): the day every date in here is relative to.
                "anchor_date": generated_at.date().isoformat(),
                "source": "demo/seed.py via app/scripts/demo-fixtures.py",
            },
            "routes": dict(sorted(rec.routes.items())),
            "pages": pages,
        }
        text = json.dumps(fixtures, indent=1, ensure_ascii=False).replace(str(root), PLACEHOLDER_ROOT)
        assert str(tmp) not in text, "a path on this machine is still in the fixtures"
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(text + "\n")
        failed = sorted(k for k, v in rec.routes.items() if v["status"] >= 500)
        print(f"wrote {OUT.relative_to(REPO)}: {len(rec.routes)} routes, {len(pages)} pages, "
              f"{OUT.stat().st_size // 1024} KiB")
        if failed:
            print("server errors recorded (kept, the app shows them as such):", *failed, sep="\n  ")
        return 0
    finally:
        if bridge_srv is not None:
            bridge_srv.shutdown()
            bridge_srv.server_close()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
