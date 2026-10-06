#!/usr/bin/env python3
"""hub-bridge — a small, authenticated, allowlisted helper that runs a fixed set
of Hermes CLI commands on the hub's behalf.

WHY IT EXISTS. The hub server (``server/``) runs non-root with no privileged
access. A handful of its panels (Config, Cron, Skills, Plugins, MCP, Memory,
Doctor, Spend, Connectors) need data that only the ``hermes`` CLI can produce,
and in the common deployment that CLI lives inside the agent's container. Rather
than give the hub a docker socket, the hub POSTs a command to THIS sidecar, which
holds the privilege, runs ONE of a fixed list of commands, and returns the output.

THE RISK, PLAINLY. In the default (docker) exec mode this process can run
``docker exec`` into another container, which requires the docker socket, which is
**root-equivalent on the host**. Everything below — a shared-secret on every
endpoint, a strict data-driven allowlist, no shell on the command path, a fixed
exec template — exists to keep that privilege behind a narrow door. Run it only on
a private network, never publish its port, and read ``README.md`` before you do.

TWO GATES, NOT ONE. The hub verifies a Face ID (WebAuthn / Secure-Enclave)
signature before it ever calls the write endpoint. This sidecar is the SECOND,
independent gate: even a caller that reaches the port directly must present the
shared key AND send a command that matches the allowlist. The two never overlap:
reads are served only by ``/run``, writes only by ``/run-write``.

AUTH. Every endpoint except ``/healthz`` requires ``Authorization: Bearer <key>``,
compared in constant time against the contents of ``HUB_BRIDGE_KEY_FILE`` (mode
0600). With no key file configured the bridge FAILS CLOSED: every authed endpoint
answers 503 and nothing runs.

EXEC MODES (``BRIDGE_EXEC``):
  * ``docker`` (default): ``docker exec [-u USER] <HERMES_CONTAINER> hermes …``.
    Needs the docker socket; root-equivalent. ``HERMES_CONTAINER`` names the
    container (default ``hermes``).
  * ``local``: runs ``hermes`` / ``python3`` / ``sh`` directly, for when Hermes is
    installed on the same host or in the same container. No docker socket needed.

CONTRACT (all JSON):
  * POST /run        {"argv": ["cron","list"]}        — READ allowlist  -> {stdout,stderr,code}
  * POST /run-write  {"argv": ["config","set",k,v]}   — WRITE allowlist -> {stdout,stderr,code}
  * POST /spend      {cutoff_epoch,split_epoch,granularity} -> computed spend tree
  * GET  /config-raw                                  -> {"config": <tree, secrets redacted>}
  * POST /cron-logs  {"limit": n}                     -> {"runs":[…],"count":N}
  * GET  /cron-costs                                  -> per-job trailing-window costs
  * POST /oauth-start   {"provider": p}               -> {"stage":"pending"}  (device-code login)
  * GET  /oauth-status?provider=p                     -> {"stage",url?,code?,error?}
  * GET  /healthz                                     -> {"ok": true}  (UNAUTHENTICATED liveness)
  * anything else -> 404 / 405; a bad/absent key -> 401; an unconfigured key -> 503.

No shell is used on the ``/run`` and ``/run-write`` path: ``argv`` is a Python list
passed straight to ``hermes`` as separate tokens, never interpolated into a string.
The ``/spend``, ``/config-raw``, ``/cron-logs`` and ``/cron-costs`` endpoints run a
FIXED Python script whose only variable inputs arrive as separate argv tokens. The
two device-code OAuth endpoints are the only ones that use ``sh -c``, and the only
value placed in that command is an exact key of a fixed provider map — never caller
bytes.
"""
from __future__ import annotations

import hmac
import json
import os
import re
import subprocess
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# --- Configuration (all via env; no personal content baked in) ----------------
BRIDGE_EXEC = os.environ.get("BRIDGE_EXEC", "docker").strip().lower()
HERMES_CONTAINER = os.environ.get("HERMES_CONTAINER", "hermes")
# Optional "uid:gid" to run the exec as (docker mode only). Blank = the container's default.
HERMES_EXEC_USER = os.environ.get("HERMES_EXEC_USER", "").strip()
# Where the Hermes data dir (state.db, config.yaml, cron/) is visible to the exec
# target. The agent container's conventional mount is /opt/data; a local install
# points this at the hermes home. Passed to the fixed scripts as an argv token —
# never a hardcoded path.
HERMES_DATA_DIR = os.environ.get("HERMES_DATA_DIR", "/opt/data")
# IANA tz the cost buckets are grouped in. Default UTC; set to taste.
BRIDGE_TZ = os.environ.get("BRIDGE_TZ", "UTC")

BIND_HOST = os.environ.get("BRIDGE_HOST", "0.0.0.0")
BIND_PORT = int(os.environ.get("BRIDGE_PORT", "8091"))
EXEC_TIMEOUT_S = float(os.environ.get("BRIDGE_EXEC_TIMEOUT_S", "30"))
MAX_BODY = 8192                      # argv payloads are tiny; larger is malformed/hostile.
MAX_OUTPUT_BYTES = int(os.environ.get("BRIDGE_MAX_OUTPUT_BYTES", "1000000"))  # cap /run output.

# The shared key file (mode 0600). No default VALUE — only a default PATH — so an
# unset/empty file fails closed rather than trusting a baked-in secret.
HUB_BRIDGE_KEY_FILE = os.environ.get("HUB_BRIDGE_KEY_FILE", "/keys/HUB_BRIDGE_KEY")


def _load_key() -> str:
    """Read the shared key from its file each call (cheap; lets a rotation take
    effect without a restart). Returns '' when the file is missing/empty -> the
    caller treats that as 'not configured' and fails closed."""
    try:
        with open(HUB_BRIDGE_KEY_FILE, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def authorize(headers) -> tuple[bool, int, str]:
    """(ok, status, reason). Constant-time bearer check against the key file.
    Fails CLOSED: an unconfigured key is 503, a missing/bad key is 401."""
    expected = _load_key()
    if not expected:
        return False, 503, "bridge key not configured"
    auth = headers.get("Authorization") or ""
    presented = auth[7:].strip() if auth.startswith("Bearer ") else ""
    if not presented or not hmac.compare_digest(presented, expected):
        return False, 401, "missing or invalid bearer key"
    return True, 200, ""


# --- Exec abstraction ----------------------------------------------------------
def _exec_prefix() -> list[str]:
    """The tokens before the program name. Empty for local mode; a fixed
    ``docker exec [-u USER] <container>`` for docker mode. No shell, ever."""
    if BRIDGE_EXEC == "local":
        return []
    prefix = ["docker", "exec"]
    if HERMES_EXEC_USER:
        prefix += ["-u", HERMES_EXEC_USER]
    prefix.append(HERMES_CONTAINER)
    return prefix


def _hermes_cmd(argv: list[str]) -> list[str]:
    return [*_exec_prefix(), "hermes", *argv]


def _python_cmd(script: str, *args: str) -> list[str]:
    return [*_exec_prefix(), "python3", "-c", script, *args]


def _sh_cmd(inner: str) -> list[str]:
    return [*_exec_prefix(), "sh", "-c", inner]


def _run(cmd: list[str], timeout: float = EXEC_TIMEOUT_S) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)


# --- Fixed scripts (no caller bytes; variable inputs arrive as argv tokens) ----
# sys.argv[1] is always the Hermes data dir. Scripts open state.db READ-ONLY and
# run a single SELECT. The one file they write is the spend script's daily cache
# of OpenRouter's price list, beside state.db.

SPEND_SCRIPT = r'''
import json, re, sqlite3, sys, time, os, urllib.request
from datetime import datetime, timezone, timedelta
DATA = sys.argv[1]
TZNAME = sys.argv[5] if len(sys.argv) > 5 else "UTC"
try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo(TZNAME)
except Exception:
    TZ = timezone.utc
now = time.time()
try:
    CUTOFF = int(sys.argv[2]); SPLIT = int(sys.argv[3]); GRAN = sys.argv[4]
except (IndexError, ValueError):
    print(json.dumps({"error": "bad args"})); sys.exit(1)
if GRAN not in ("hour", "day", "week", "month"):
    print(json.dumps({"error": "bad args"})); sys.exit(1)
if not (CUTOFF <= SPLIT <= now + 3600) or now - CUTOFF > 200 * 86400:
    print(json.dumps({"error": "bad args"})); sys.exit(1)

PRICING = {
    "claude-sonnet-5":           {"in": 3.00, "out": 15.00, "cw": 3.75, "cr": 0.30, "provider": "anthropic"},
    "claude-sonnet-4-6":         {"in": 3.00, "out": 15.00, "cw": 3.75, "cr": 0.30, "provider": "anthropic"},
    "claude-sonnet-4-5":         {"in": 3.00, "out": 15.00, "cw": 3.75, "cr": 0.30, "provider": "anthropic"},
    "claude-opus-4-8":           {"in": 5.00, "out": 25.00, "cw": 6.25, "cr": 0.50, "provider": "anthropic"},
    "claude-haiku-4-5":          {"in": 1.00, "out": 5.00,  "cw": 1.25, "cr": 0.10, "provider": "anthropic"},
}

def canonical(model):
    m = model or "unknown"
    if "/" in m: m = m.split("/", 1)[1]
    m = m.split(":", 1)[0]
    if "claude" in m: m = m.replace(".", "-")
    return m

def _load_openrouter_prices():
    cache = os.path.join(DATA, ".openrouter-prices.json")
    try:
        if time.time() - os.stat(cache).st_mtime < 86400:
            return json.load(open(cache))
    except Exception:
        pass
    try:
        key = os.environ.get("OPENROUTER_API_KEY", "")
        req = urllib.request.Request("https://openrouter.ai/api/v1/models",
                                     headers={"Authorization": "Bearer " + key})
        data = json.load(urllib.request.urlopen(req, timeout=10))
        out = {}
        for it in data.get("data", []):
            pr = it.get("pricing", {}) or {}
            try:
                out[it["id"]] = {"in": float(pr.get("prompt", 0)) * 1e6,
                                 "out": float(pr.get("completion", 0)) * 1e6,
                                 "cr": float(pr.get("input_cache_read", 0) or 0) * 1e6,
                                 "cw": float(pr.get("input_cache_write", 0) or 0) * 1e6}
            except Exception:
                pass
        if out:
            try: json.dump(out, open(cache, "w"))
            except Exception: pass
            return out
    except Exception:
        pass
    try: return json.load(open(cache))
    except Exception: return {}

OPENROUTER_PRICES = _load_openrouter_prices()

def resolve_price(model, billing):
    if billing == "openrouter":
        base = (model or "").split(":", 1)[0]
        dotted = re.sub(r"-(\d+)-(\d+)$", r"-\1.\2", base) if "claude" in base else base
        orp = OPENROUTER_PRICES.get(model) or OPENROUTER_PRICES.get(base) or OPENROUTER_PRICES.get(dotted)
        if not orp:
            for k in OPENROUTER_PRICES:
                if k.endswith("/" + base) or k.endswith("/" + dotted):
                    orp = OPENROUTER_PRICES[k]; break
        if orp:
            return {"in": orp["in"], "out": orp["out"], "cw": orp.get("cw", 0.0),
                    "cr": orp.get("cr", 0.0), "provider": "openrouter"}
        return None
    hit = PRICING.get(model) or PRICING.get(canonical(model))
    if hit: return hit
    m = (model or "").lower()
    if "claude" in m:
        if "opus" in m: return PRICING["claude-opus-4-8"]
        if "haiku" in m: return PRICING["claude-haiku-4-5"]
        return PRICING["claude-sonnet-5"]
    return None

def provider_of(billing, price):
    if billing in ("anthropic", "openrouter"): return billing
    if billing: return "other"
    return price["provider"] if price else "other"

def bucket_key(ts):
    dt = datetime.fromtimestamp(ts, tz=TZ)
    if GRAN == "hour": return dt.strftime("%Y-%m-%dT%H:00")
    if GRAN == "day": return dt.strftime("%Y-%m-%d")
    if GRAN == "week":
        monday = dt - timedelta(days=dt.weekday()); return monday.strftime("%Y-%m-%d")
    return dt.strftime("%Y-%m")

def all_buckets():
    out, seen = [], set()
    start = datetime.fromtimestamp(SPLIT, tz=TZ); end = datetime.fromtimestamp(now, tz=TZ)
    if GRAN == "hour":
        cur = start.replace(minute=0, second=0, microsecond=0)
        while cur <= end:
            k = cur.strftime("%Y-%m-%dT%H:00")
            if k not in seen: out.append(k); seen.add(k)
            cur += timedelta(hours=1)
    elif GRAN == "day":
        cur = start.replace(hour=0, minute=0, second=0, microsecond=0)
        while cur <= end:
            k = cur.strftime("%Y-%m-%d")
            if k not in seen: out.append(k); seen.add(k)
            cur += timedelta(days=1)
    elif GRAN == "week":
        cur = start.replace(hour=0, minute=0, second=0, microsecond=0)
        cur = cur - timedelta(days=cur.weekday())
        while cur <= end:
            k = cur.strftime("%Y-%m-%d")
            if k not in seen: out.append(k); seen.add(k)
            cur += timedelta(weeks=1)
    else:
        y, m = start.year, start.month
        while (y, m) <= (end.year, end.month):
            out.append("%04d-%02d" % (y, m))
            m += 1
            if m > 12: m = 1; y += 1
    return out

con = sqlite3.connect("file:" + os.path.join(DATA, "state.db") + "?mode=ro", uri=True)
con.row_factory = sqlite3.Row
rows = con.execute(
    "SELECT model, billing_provider, started_at, input_tokens, output_tokens, "
    "cache_read_tokens, cache_write_tokens FROM sessions WHERE started_at >= ?",
    (CUTOFF,)).fetchall()

total = 0.0; prev_total = 0.0; prev_by_provider = {}; by_provider = {}
models_agg = {}; unpriced_agg = {}; ts_agg = {}
tok_in = tok_out = tok_cr = tok_cw = 0; sessions_n = 0; cache_saved = 0.0

for r in rows:
    model = r["model"] or "unknown"; billing = r["billing_provider"]
    inp = r["input_tokens"] or 0; outp = r["output_tokens"] or 0
    cr = r["cache_read_tokens"] or 0; cw = r["cache_write_tokens"] or 0
    p = resolve_price(model, billing)
    cost = (inp * p["in"] + outp * p["out"] + cw * p["cw"] + cr * p["cr"]) / 1e6 if p else 0.0
    provider = provider_of(billing, p)
    if r["started_at"] < SPLIT:
        prev_total += cost
        prev_by_provider[provider] = prev_by_provider.get(provider, 0.0) + cost
        continue
    key = canonical(model)
    total += cost
    by_provider[provider] = by_provider.get(provider, 0.0) + cost
    tok_in += inp; tok_out += outp; tok_cr += cr; tok_cw += cw; sessions_n += 1
    if p:
        m = models_agg.setdefault(key, {"provider": provider, "input": 0, "output": 0,
            "cache_read": 0, "cache_write": 0, "sessions": 0, "cost": 0.0, "aliases": set()})
        m["input"] += inp; m["output"] += outp; m["cache_read"] += cr; m["cache_write"] += cw
        m["sessions"] += 1; m["cost"] += cost
        if model != key: m["aliases"].add(model)
        cache_saved += (cr * (p["in"] - p["cr"]) - cw * (p["cw"] - p["in"])) / 1e6
    else:
        u = unpriced_agg.setdefault(key, {"input": 0, "output": 0, "cache_read": 0})
        u["input"] += inp; u["output"] += outp; u["cache_read"] += cr
    k = bucket_key(r["started_at"])
    b = ts_agg.setdefault(k, {"total": 0.0, "per_model": {}, "per_provider": {},
        "input": 0, "output": 0, "cache_read": 0, "sessions": 0})
    b["total"] += cost
    if p: b["per_model"][key] = b["per_model"].get(key, 0.0) + cost
    b["per_provider"][provider] = b["per_provider"].get(provider, 0.0) + cost
    b["input"] += inp; b["output"] += outp; b["cache_read"] += cr; b["sessions"] += 1

timeseries = []
for k in all_buckets():
    b = ts_agg.get(k, {"total": 0.0, "per_model": {}, "per_provider": {},
        "input": 0, "output": 0, "cache_read": 0, "sessions": 0})
    timeseries.append({"bucket": k, "total": round(b["total"], 6),
        "per_model": {mm: round(v, 6) for mm, v in b["per_model"].items()},
        "per_provider": {pp: round(v, 6) for pp, v in b["per_provider"].items()},
        "tokens": {"input": b["input"], "output": b["output"], "cache_read": b["cache_read"]},
        "sessions": b["sessions"]})

models = [{"model": mm, "provider": v["provider"], "input": v["input"], "output": v["output"],
    "cache_read": v["cache_read"], "cache_write": v["cache_write"], "sessions": v["sessions"],
    "cost": round(v["cost"], 6), "aliases": sorted(v["aliases"])}
    for mm, v in sorted(models_agg.items(), key=lambda kv: -kv[1]["cost"])]
unpriced = [{"model": mm, "input": v["input"], "output": v["output"], "cache_read": v["cache_read"]}
    for mm, v in sorted(unpriced_agg.items())]
would_have_cost = total + cache_saved
saved_pct = (cache_saved / would_have_cost * 100.0) if would_have_cost > 0 else 0.0
print(json.dumps({"summary": {"total_usd": round(total, 6), "prev_total_usd": round(prev_total, 6),
    "prev_by_provider": {pp: round(v, 6) for pp, v in prev_by_provider.items()},
    "by_provider": {pp: round(v, 6) for pp, v in by_provider.items()},
    "tokens": {"input": tok_in, "output": tok_out, "cache_read": tok_cr, "cache_write": tok_cw},
    "sessions": sessions_n}, "timeseries": timeseries, "models": models,
    "cache": {"read_tokens": tok_cr, "saved_usd": round(cache_saved, 6),
        "saved_pct": round(saved_pct, 2), "would_have_cost_usd": round(would_have_cost, 6)},
    "unpriced": unpriced}))
'''

CONFIG_DUMP_SCRIPT = r'''
import json, re, sys, os
try:
    import yaml
except Exception as exc:
    print(json.dumps({"error": "pyyaml unavailable: %s" % exc})); sys.exit(0)
DATA = sys.argv[1]
# MUST match the hub's own _CONFIG_SENSITIVE_RE (server/app.py). The hub re-applies
# the SAME rule to decide which leaves are writable/masked, so the two must agree on
# what is secret; broadening only one side would redact real non-secret keys (e.g.
# session_reset) that the hub would then show as writable with a redacted value.
SENSITIVE = re.compile(r"key|token|secret|password|hash", re.IGNORECASE)
REDACT = "__redacted__"
def mask(node, path=""):
    if isinstance(node, dict):
        return {k: mask(v, ("%s.%s" % (path, k)) if path else str(k)) for k, v in node.items()}
    if isinstance(node, list):
        return [mask(v, "%s.%d" % (path, i)) for i, v in enumerate(node)]
    if SENSITIVE.search(path):
        return node if node in (None, "", [], {}) else REDACT
    return node
try:
    data = yaml.safe_load(open(os.path.join(DATA, "config.yaml"))) or {}
except Exception as exc:
    print(json.dumps({"error": "config load failed: %s" % exc})); sys.exit(0)
if not isinstance(data, dict):
    print(json.dumps({"error": "config.yaml root is not a mapping"})); sys.exit(0)
print(json.dumps({"config": mask(data)}))
'''

CRON_LOGS_SCRIPT = r'''
import json, glob, os, sys
DATA = sys.argv[1]
try:
    LIMIT = int(sys.argv[2])
except (IndexError, ValueError):
    print(json.dumps({"error": "bad args"})); sys.exit(1)
if not (1 <= LIMIT <= 200):
    print(json.dumps({"error": "bad args"})); sys.exit(1)
OUTPUT_DIR = os.path.join(DATA, "cron", "output")
MAX_OUTPUT = 4000
FIELDS = (("job_id", "**Job ID:**"), ("run_time", "**Run Time:**"),
          ("mode", "**Mode:**"), ("status", "**Status:**"))
def parse(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return None
    run = {"job_id": None, "name": None, "run_time": None, "mode": None, "status": None}
    body_start = None
    for i, line in enumerate(lines):
        s = line.strip()
        if run["name"] is None and s.startswith("# Cron Job:"):
            run["name"] = s[len("# Cron Job:"):].strip() or None
            continue
        for key, prefix in FIELDS:
            if run[key] is None and s.startswith(prefix):
                run[key] = s[len(prefix):].strip() or None
                if key == "status": body_start = i + 1
                break
        if body_start is not None: break
    output = ""
    if body_start is not None and body_start < len(lines):
        output = "\n".join(lines[body_start:]).strip()
    truncated = len(output) > MAX_OUTPUT
    if truncated: output = output[:MAX_OUTPUT]
    if not run["job_id"]:
        run["job_id"] = os.path.basename(os.path.dirname(path)) or None
    run["output"] = output; run["truncated"] = truncated
    return run
def _mtime(p):
    try: return os.stat(p).st_mtime
    except OSError: return 0.0
paths = glob.glob(os.path.join(OUTPUT_DIR, "*", "*.md"))
paths.sort(key=_mtime, reverse=True)
runs = []
for p in paths[:LIMIT]:
    r = parse(p)
    if r is not None: runs.append(r)
print(json.dumps({"runs": runs, "count": len(runs)}))
'''

CRON_COSTS_SCRIPT = r'''
import json, re, sqlite3, datetime, sys, os
DATA = sys.argv[1]
TZNAME = sys.argv[2] if len(sys.argv) > 2 else "UTC"
try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo(TZNAME)
except Exception:
    TZ = datetime.timezone.utc
now = datetime.datetime.now(datetime.timezone.utc)
cut = int(now.timestamp()) - 7 * 86400
con = sqlite3.connect("file:" + os.path.join(DATA, "state.db") + "?mode=ro", uri=True)
con.row_factory = sqlite3.Row
rows = con.execute(
    "SELECT id, model, started_at, input_tokens, output_tokens, cache_read_tokens,"
    " cache_write_tokens, estimated_cost_usd, actual_cost_usd, cost_status"
    " FROM sessions WHERE source = 'cron' AND started_at >= ?", (cut,)).fetchall()
con.close()
names = {}
try:
    with open(os.path.join(DATA, "cron", "jobs.json"), "r", encoding="utf-8") as f:
        store = json.load(f)
    items = store.get("jobs") if isinstance(store, dict) else store
    for j in items or []:
        if isinstance(j, dict) and j.get("id"):
            names[j["id"]] = j.get("name")
except Exception:
    pass
IDS = re.compile(r"^cron_(.+)_(\d{8})_(\d{6})$")
agg = {}
for r in rows:
    m = IDS.match(r["id"] or "")
    if not m: continue
    jid = m.group(1)
    inp = r["input_tokens"] or 0; outp = r["output_tokens"] or 0
    cr = r["cache_read_tokens"] or 0; cw = r["cache_write_tokens"] or 0
    toks = inp + outp + cr + cw
    cost = r["actual_cost_usd"]
    if cost is None: cost = r["estimated_cost_usd"]
    status = r["cost_status"] or "unknown"
    unknown = cost is None or status == "unknown"
    day = datetime.datetime.fromtimestamp(r["started_at"], TZ).strftime("%Y-%m-%d")
    a = agg.setdefault(jid, {"last": None, "days": {}, "tokens": 0})
    run = {"at": r["started_at"], "cost_usd": None if unknown else round(float(cost), 6),
           "cost_status": status, "tokens": toks, "model": r["model"]}
    a["tokens"] += toks
    if a["last"] is None or run["at"] > a["last"]["at"]: a["last"] = run
    d = a["days"].setdefault(day, {"cost_usd": 0.0, "runs": 0, "unknown_runs": 0})
    d["runs"] += 1
    if unknown: d["unknown_runs"] += 1
    else: d["cost_usd"] += float(cost)
jobs = []
for jid, a in agg.items():
    days = {k: {"cost_usd": round(v["cost_usd"], 6), "runs": v["runs"],
                "unknown_runs": v["unknown_runs"]} for k, v in sorted(a["days"].items())}
    runs = sum(v["runs"] for v in a["days"].values())
    unk = sum(v["unknown_runs"] for v in a["days"].values())
    cost = round(sum(v["cost_usd"] for v in a["days"].values()), 6)
    jobs.append({"id": jid, "name": names.get(jid), "no_agent": runs == 0,
        "last_run": a["last"], "week": {"runs": runs, "cost_usd": cost, "unknown_runs": unk,
            "tokens": a["tokens"], "days": days}})
jobs = sorted(jobs, key=lambda j: (j["name"] or j["id"]).lower())
print(json.dumps({"generated_at": now.isoformat(), "window_days": 7, "jobs": jobs, "count": len(jobs)}))
'''

# --- Token validators ----------------------------------------------------------
_CONFIG_KEY_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_SOURCE_RE = re.compile(r"^[a-z]+$")
_JOB_ID_RE = re.compile(r"^[A-Za-z0-9._:-]+$")
_PLATFORM_RE = re.compile(r"^[a-z][a-z0-9_-]*$")
_PAIRING_TOKEN_RE = re.compile(r"^[A-Za-z0-9._:@-]+$")
_PROVIDER_RE = re.compile(r"^[a-z0-9][a-z0-9._:-]*$")
_TASK_ID_RE = re.compile(r"^t_[A-Za-z0-9]{1,32}$")
_DELIVER_RE = re.compile(r"^[A-Za-z0-9._:@-]+$")
# Config keys the bridge refuses to WRITE, independent of the hub: secret-shaped
# (would store a credential) and ALL-UPPER_SNAKE (Hermes routes those into .env).
# Kept to clearly-secret tokens so it never blocks a real scalar key such as
# `group_sessions_per_user` or `session_reset` — a stricter refusal than the hub's
# own, which is the point, without false positives on legitimate settings.
_SENSITIVE_KEY_RE = re.compile(r"key|token|secret|password|hash|credential|passphrase|cookie",
                               re.IGNORECASE)
_ENV_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")


def _flaglike(tok: str) -> bool:
    """A value token that would be read as an option by the downstream CLI."""
    return tok.startswith("-")


def _no_extra(rest: list[str]) -> bool:
    return len(rest) == 0


def _optional(*allowed: str):
    allowed_set = set(allowed)

    def check(rest: list[str]) -> bool:
        return all(tok in allowed_set for tok in rest)
    return check


def _config_get_ok(rest: list[str]) -> bool:
    return len(rest) == 1 and bool(_CONFIG_KEY_RE.match(rest[0]))


def _auth_list_ok(rest: list[str]) -> bool:
    return len(rest) == 0 or (len(rest) == 1 and bool(_PROVIDER_RE.match(rest[0])))


def _auth_status_ok(rest: list[str]) -> bool:
    return len(rest) == 1 and bool(_PROVIDER_RE.match(rest[0]))


def _kanban_show_ok(rest: list[str]) -> bool:
    toks = rest[:-1] if rest and rest[-1] == "--json" else rest
    return len(toks) == 1 and bool(_TASK_ID_RE.match(toks[0]))


def _skills_list_ok(rest: list[str]) -> bool:
    i = 0
    while i < len(rest):
        tok = rest[i]
        if tok == "--enabled-only":
            i += 1
        elif tok == "--source":
            if i + 1 >= len(rest) or rest[i + 1] not in {"all", "hub", "builtin", "local"}:
                return False
            i += 2
        else:
            return False
    return True


def _sessions_list_ok(rest: list[str]) -> bool:
    i = 0
    while i < len(rest):
        tok = rest[i]
        if tok == "--limit":
            if i + 1 >= len(rest) or not rest[i + 1].isdigit() or not (0 < int(rest[i + 1]) <= 500):
                return False
            i += 2
        elif tok == "--source":
            if i + 1 >= len(rest) or not _SOURCE_RE.match(rest[i + 1]):
                return False
            i += 2
        else:
            return False
    return True


# READ allowlist — nothing here mutates state.
ALLOWLIST = {
    ("config", "show"): _no_extra,
    ("config", "get"): _config_get_ok,
    ("auth", "list"): _auth_list_ok,
    ("auth", "status"): _auth_status_ok,
    ("cron", "list"): _optional("--all"),
    ("cron", "status"): _no_extra,
    ("kanban", "list"): _optional("--json"),
    ("kanban", "stats"): _optional("--json"),
    ("kanban", "show"): _kanban_show_ok,
    ("skills", "list"): _skills_list_ok,
    ("plugins", "list"): _optional("--json", "--enabled", "--no-bundled", "--plain", "--user"),
    ("mcp", "list"): _no_extra,
    ("doctor",): _no_extra,
    ("sessions", "list"): _sessions_list_ok,
    ("memory", "status"): _no_extra,
    ("pairing", "list"): _no_extra,
}


# --- WRITE validators ----------------------------------------------------------
def _config_set_ok(rest: list[str]) -> bool:
    # `config set <key> <value>` — a dotted key plus one value token. The key must
    # not be secret-shaped or UPPER_SNAKE (would write a secret or an env var); the
    # value must not look like an option.
    if len(rest) != 2:
        return False
    key, value = rest
    if not _CONFIG_KEY_RE.match(key):
        return False
    if _SENSITIVE_KEY_RE.search(key) or _ENV_KEY_RE.match(key):
        return False
    # The model endpoint decides where the provider key is sent; change it in a terminal.
    if key in ("model.base_url", "model.api_mode"):
        return False
    if _flaglike(value):
        return False
    return True


def _cron_job_id_only(rest: list[str]) -> bool:
    return len(rest) == 1 and bool(_JOB_ID_RE.match(rest[0]))


def _cron_run_ok(rest: list[str]) -> bool:
    toks = rest[:-1] if rest and rest[-1] == "--accept-hooks" else rest
    return len(toks) == 1 and bool(_JOB_ID_RE.match(toks[0]))


_CRON_CREATE_VALUE_FLAGS = {"--name", "--deliver", "--repeat", "--skill", "--script", "--workdir"}
_CRON_CREATE_BOOL_FLAGS = {"--no-agent"}
_CRON_EDIT_VALUE_FLAGS = {"--schedule", "--prompt", "--name", "--deliver", "--repeat",
                          "--skill", "--add-skill", "--remove-skill", "--script", "--workdir"}
_CRON_EDIT_BOOL_FLAGS = {"--no-agent", "--agent", "--clear-skills"}


def _walk_flags(rest: list[str], start: int, value_flags: set[str], bool_flags: set[str]) -> bool:
    i = start
    while i < len(rest):
        tok = rest[i]
        if tok in bool_flags:
            i += 1
        elif tok in value_flags:
            if i + 1 >= len(rest) or _flaglike(rest[i + 1]):
                return False
            i += 2
        else:
            return False
    return True


def _cron_create_ok(rest: list[str]) -> bool:
    # `cron create <schedule> [prompt] [flags...]` — 1-2 leading positionals that
    # must not look like options, then only known flags.
    i = 0
    positionals = 0
    while i < len(rest) and not rest[i].startswith("-"):
        positionals += 1
        i += 1
    if not (1 <= positionals <= 2):
        return False
    return _walk_flags(rest, i, _CRON_CREATE_VALUE_FLAGS, _CRON_CREATE_BOOL_FLAGS)


def _cron_edit_ok(rest: list[str]) -> bool:
    if not rest or rest[0].startswith("-") or not _JOB_ID_RE.match(rest[0]):
        return False
    return _walk_flags(rest, 1, _CRON_EDIT_VALUE_FLAGS, _CRON_EDIT_BOOL_FLAGS)


def _pairing_two_ok(rest: list[str]) -> bool:
    return (len(rest) == 2
            and bool(_PLATFORM_RE.match(rest[0]))
            and bool(_PAIRING_TOKEN_RE.match(rest[1])))


# WRITE allowlist — served ONLY by /run-write.
WRITE_ALLOWLIST = {
    ("config", "set"): _config_set_ok,
    ("cron", "create"): _cron_create_ok,
    ("cron", "edit"): _cron_edit_ok,
    ("cron", "pause"): _cron_job_id_only,
    ("cron", "resume"): _cron_job_id_only,
    ("cron", "run"): _cron_run_ok,
    ("cron", "remove"): _cron_job_id_only,
    ("pairing", "approve"): _pairing_two_ok,
    ("pairing", "revoke"): _pairing_two_ok,
    ("gateway", "restart"): _no_extra,
    ("gateway", "stop"): _no_extra,
}


def _argv_well_formed(argv) -> bool:
    if not isinstance(argv, list) or not argv:
        return False
    if not all(isinstance(tok, str) for tok in argv):
        return False
    for tok in argv:
        if tok == "" or "\x00" in tok or "\n" in tok or "\r" in tok:
            return False
    return True


def _validate_against(argv, allowlist: dict) -> bool:
    if not _argv_well_formed(argv):
        return False
    for plen in (2, 1):
        if len(argv) >= plen:
            validator = allowlist.get(tuple(argv[:plen]))
            if validator is not None:
                return validator(argv[plen:])
    return False


def validate_argv(argv) -> bool:
    """True iff argv is a well-formed READ-allowlist command."""
    return _validate_against(argv, ALLOWLIST)


def validate_write_argv(argv) -> bool:
    """True iff argv is a well-formed WRITE-allowlist command."""
    return _validate_against(argv, WRITE_ALLOWLIST)


# --- Command runners -----------------------------------------------------------
def _cap(text: str) -> str:
    if text and len(text) > MAX_OUTPUT_BYTES:
        return text[:MAX_OUTPUT_BYTES] + "\n…[truncated by bridge]"
    return text


def _run_command_uncached(argv: list[str]) -> dict:
    try:
        proc = _run(_hermes_cmd(argv))
    except subprocess.TimeoutExpired:
        return {"stdout": "", "stderr": f"bridge: timed out after {EXEC_TIMEOUT_S}s", "code": 124}
    except OSError as exc:
        return {"stdout": "", "stderr": f"bridge: exec failed: {exc}", "code": 127}
    return {"stdout": _cap(proc.stdout), "stderr": _cap(proc.stderr), "code": proc.returncode}


# Warm cache for the two kanban reads (each pays a cold CLI start, polled often).
_KANBAN_CACHE_ARGS = (("kanban", "list", "--json"), ("kanban", "stats", "--json"))
_KANBAN_CACHE: dict[tuple, tuple[float, dict]] = {}
_KANBAN_CACHE_LOCK = threading.Lock()
_KANBAN_TTL_S = float(os.environ.get("BRIDGE_KANBAN_TTL_S", "15"))


def _kanban_cache_get(argv: list[str]) -> dict | None:
    key = tuple(argv)
    if key not in _KANBAN_CACHE_ARGS:
        return None
    with _KANBAN_CACHE_LOCK:
        hit = _KANBAN_CACHE.get(key)
    if hit is not None and (time.time() - hit[0]) < _KANBAN_TTL_S:
        return hit[1]
    return None


def _kanban_cache_put(argv: list[str], result: dict) -> None:
    key = tuple(argv)
    if key not in _KANBAN_CACHE_ARGS or result.get("code") != 0:
        return
    with _KANBAN_CACHE_LOCK:
        _KANBAN_CACHE[key] = (time.time(), result)


def _kanban_refresher() -> None:
    while True:
        for argv in _KANBAN_CACHE_ARGS:
            _kanban_cache_put(list(argv), _run_command_uncached(list(argv)))
        time.sleep(_KANBAN_TTL_S)


def run_command(argv: list[str]) -> dict:
    cached = _kanban_cache_get(argv)
    if cached is not None:
        return cached
    result = _run_command_uncached(argv)
    _kanban_cache_put(argv, result)
    return result


def _run_script(cmd: list[str], err_label: str) -> dict:
    try:
        proc = _run(cmd)
    except subprocess.TimeoutExpired:
        return {"error": f"{err_label} timed out after {EXEC_TIMEOUT_S}s"}
    except OSError as exc:
        return {"error": f"{err_label} exec failed: {exc}"}
    if proc.returncode != 0:
        return {"error": f"{err_label} exited {proc.returncode}: {proc.stderr.strip()[:300]}"}
    try:
        return json.loads(proc.stdout)
    except (json.JSONDecodeError, ValueError):
        return {"error": f"{err_label} returned non-JSON output"}


SPEND_GRANULARITIES = {"hour", "day", "week", "month"}
SPEND_MAX_LOOKBACK_S = 200 * 86400
SPEND_CLOCK_SKEW_S = 3600
CRON_LOGS_MAX_LIMIT = 200


def validate_spend(body) -> tuple[int, int, str] | None:
    if not isinstance(body, dict):
        return None
    gran = body.get("granularity")
    cutoff = body.get("cutoff_epoch")
    split = body.get("split_epoch")
    if gran not in SPEND_GRANULARITIES:
        return None
    if isinstance(cutoff, bool) or not isinstance(cutoff, int):
        return None
    if isinstance(split, bool) or not isinstance(split, int):
        return None
    now = time.time()
    if not (cutoff <= split <= now + SPEND_CLOCK_SKEW_S):
        return None
    if now - cutoff > SPEND_MAX_LOOKBACK_S:
        return None
    return cutoff, split, gran


def run_spend(cutoff_epoch: int, split_epoch: int, granularity: str) -> dict:
    return _run_script(_python_cmd(SPEND_SCRIPT, HERMES_DATA_DIR, str(cutoff_epoch),
                                   str(split_epoch), granularity, BRIDGE_TZ), "spend query")


def run_config_dump() -> dict:
    return _run_script(_python_cmd(CONFIG_DUMP_SCRIPT, HERMES_DATA_DIR), "config dump")


def run_cron_costs() -> dict:
    return _run_script(_python_cmd(CRON_COSTS_SCRIPT, HERMES_DATA_DIR, BRIDGE_TZ), "cron-costs query")


def validate_cron_logs(body) -> int | None:
    if not isinstance(body, dict):
        return None
    limit = body.get("limit")
    if isinstance(limit, bool) or not isinstance(limit, int):
        return None
    if not (1 <= limit <= CRON_LOGS_MAX_LIMIT):
        return None
    return limit


def run_cron_logs(limit: int) -> dict:
    return _run_script(_python_cmd(CRON_LOGS_SCRIPT, HERMES_DATA_DIR, str(limit)), "cron-logs query")


# --- Device-code OAuth (verification URL + user_code only; never a token) ------
# The log path is derived from the provider via this fixed map and the data dir —
# never built from caller bytes. `provider` must be an exact key here before any
# exec, so the value interpolated into `sh -c` is always a fixed literal.
DEVICE_OAUTH_PROVIDERS = {
    "nous": ".hub-oauth-nous.log",
    "openai-codex": ".hub-oauth-openai-codex.log",
    "minimax-oauth": ".hub-oauth-minimax-oauth.log",
}
OAUTH_EXPIRY_S = 16 * 60
_OAUTH_URL_RE = re.compile(r"Open:\s*(https?://\S+)")
_OAUTH_CODE_RE = re.compile(r"enter code:\s*(\S+)")
_OAUTH_SUCCESS_MARKERS = ("login successful", "logged in", "oauth login successful")
_OAUTH_FAILURE_MARKERS = (
    "timed out", "login cancelled", "error:", "traceback (most recent call last)",
    "autherror", "did not return credentials", "not implemented", "access_denied",
    "authorization_declined", "declined", "denied", "no api key", "unknown provider")


def _oauth_log_path(provider: str) -> str:
    return os.path.join(HERMES_DATA_DIR, DEVICE_OAUTH_PROVIDERS[provider])


def _parse_oauth_log(text: str, mtime: int) -> dict:
    url_m = _OAUTH_URL_RE.search(text)
    code_m = _OAUTH_CODE_RE.search(text)
    url = url_m.group(1) if url_m else None
    code = code_m.group(1) if code_m else None
    low = text.lower()
    if any(s in low for s in _OAUTH_SUCCESS_MARKERS):
        return {"stage": "connected", "url": url, "code": code}
    for line in text.splitlines():
        ll = line.lower()
        if any(f in ll for f in _OAUTH_FAILURE_MARKERS):
            return {"stage": "failed", "url": url, "code": code, "error": line.strip()[:300]}
    if mtime and (time.time() - mtime) > OAUTH_EXPIRY_S:
        return {"stage": "failed", "url": url, "code": code,
                "error": "device code expired (no approval within ~15 min)"}
    return {"stage": "pending", "url": url, "code": code}


def oauth_start(provider: str) -> dict:
    log = _oauth_log_path(provider)
    inner = f": >{log}; setsid hermes auth add {provider} --no-browser </dev/null >>{log} 2>&1 &"
    try:
        _run(_sh_cmd(inner))
    except subprocess.TimeoutExpired:
        return {"stage": "failed", "error": f"oauth start timed out after {EXEC_TIMEOUT_S}s"}
    except OSError as exc:
        return {"stage": "failed", "error": f"oauth start exec failed: {exc}"}
    return {"stage": "pending"}


def oauth_status(provider: str) -> dict:
    log = _oauth_log_path(provider)
    inner = f'echo "MTIME:$(stat -c %Y {log} 2>/dev/null || echo 0)"; cat {log} 2>/dev/null || true'
    try:
        proc = _run(_sh_cmd(inner))
    except subprocess.TimeoutExpired:
        return {"stage": "failed", "error": f"oauth status timed out after {EXEC_TIMEOUT_S}s"}
    except OSError as exc:
        return {"stage": "failed", "error": f"oauth status exec failed: {exc}"}
    out = proc.stdout or ""
    lines = out.splitlines()
    mtime = 0
    if lines and lines[0].startswith("MTIME:"):
        try:
            mtime = int(lines[0][len("MTIME:"):].strip())
        except ValueError:
            mtime = 0
        body = "\n".join(lines[1:])
    else:
        body = out
    return _parse_oauth_log(body, mtime)


# --- Pure routing (socket-free; unit-tested directly) --------------------------
def route_get(path: str, query: dict, headers) -> tuple[int, dict]:
    if path == "/healthz":
        return 200, {"ok": True}
    ok, status, reason = authorize(headers)
    if not ok:
        return status, {"error": reason}
    if path == "/config-raw":
        result = run_config_dump()
        return (502 if "error" in result else 200), result
    if path == "/cron-costs":
        result = run_cron_costs()
        return (502 if "error" in result else 200), result
    if path == "/oauth-status":
        provider = (query.get("provider") or [""])[0]
        if provider not in DEVICE_OAUTH_PROVIDERS:
            return 400, {"error": "unknown or non-device-code provider"}
        return 200, oauth_status(provider)
    return 404, {"error": "not found"}


def route_post(path: str, headers, body: dict | None) -> tuple[int, dict]:
    ok, status, reason = authorize(headers)
    if not ok:
        return status, {"error": reason}
    if path == "/spend":
        parsed = validate_spend(body)
        if parsed is None:
            return 400, {"error": "invalid spend params"}
        result = run_spend(*parsed)
        return (502 if "error" in result else 200), result
    if path == "/cron-logs":
        limit = validate_cron_logs(body)
        if limit is None:
            return 400, {"error": f"invalid cron-logs params (limit int 1..{CRON_LOGS_MAX_LIMIT})"}
        result = run_cron_logs(limit)
        return (502 if "error" in result else 200), result
    if path == "/oauth-start":
        provider = body.get("provider") if isinstance(body, dict) else None
        if not isinstance(provider, str) or provider not in DEVICE_OAUTH_PROVIDERS:
            return 400, {"error": "unknown or non-device-code provider"}
        result = oauth_start(provider)
        return (502 if result.get("stage") == "failed" else 200), result
    if path in ("/run", "/run-write"):
        validator = validate_argv if path == "/run" else validate_write_argv
        argv = body.get("argv") if isinstance(body, dict) else None
        if not validator(argv):
            return 403, {"error": f"argv not allowlisted ({'read-only' if path == '/run' else 'write'} bridge)"}
        return 200, run_command(argv)
    return 404, {"error": "not found"}


class Handler(BaseHTTPRequestHandler):
    server_version = "hub-bridge/2.0"

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> tuple[dict | None, tuple[int, dict] | None]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None, (400, {"error": "bad content-length"})
        if length <= 0 or length > MAX_BODY:
            return None, (400, {"error": "empty or oversized body"})
        raw = self.rfile.read(length)
        try:
            return json.loads(raw), None
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None, (400, {"error": "invalid JSON"})

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        status, payload = route_get(parsed.path, query, self.headers)
        self._send(status, payload)

    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if path not in ("/run", "/run-write", "/spend", "/cron-logs", "/oauth-start"):
            # Still require auth before disclosing route existence.
            ok, status, reason = authorize(self.headers)
            self._send(status if not ok else 404, {"error": reason or "not found"})
            return
        body, err = self._read_body()
        if err is not None:
            # Authenticate even malformed bodies so an unauth caller learns nothing.
            ok, status, reason = authorize(self.headers)
            if not ok:
                self._send(status, {"error": reason})
                return
            self._send(*err)
            return
        status, payload = route_post(path, self.headers, body)
        self._send(status, payload)

    def log_message(self, fmt: str, *args) -> None:
        # method + path + status only; never the argv body (avoids logging config keys).
        print("hub-bridge %s - %s" % (self.address_string(), fmt % args))


def main() -> None:
    mode = "local" if BRIDGE_EXEC == "local" else f"docker exec {HERMES_CONTAINER}"
    if not _load_key():
        print(f"hub-bridge WARNING: no key at {HUB_BRIDGE_KEY_FILE} — every request will 503 until one exists")
    threading.Thread(target=_kanban_refresher, daemon=True, name="kanban-refresher").start()
    httpd = ThreadingHTTPServer((BIND_HOST, BIND_PORT), Handler)
    print(f"hub-bridge listening on {BIND_HOST}:{BIND_PORT} -> {mode} hermes")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()
