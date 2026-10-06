"""Automations — scheduled-job output, grouped by the job that produced it.

The unit is the RUN, keyed `"<job_id>:<run file stem>"`. The gateway writes one file
per run under `cron/output/<job_id>/`, so the job id is a fact about where the run
was written, never something inferred from a channel, a title or the text. The hub
plugin pushes jobs and runs here (`sync`), and tags each live delivery with the same
run id (`record_delivery`), so a delivery and its run file land on one row.

Reads and writes share `ChatStore`'s connection and lock: follow-up threads are
ordinary chat threads and a run's delivered media are ordinary messages, so they
have to be one database.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from chat.store import LEGACY_DELIVERY_KINDS, ChatStore
from hub_tz import hub_tz

HUB_TZ = hub_tz()

# Base of the scheduler's run-file archive, used by the follow-up note that points at
# the full run file. The gateway's data directory differs per deployment, so this is
# overridable; the default is the archive's location relative to the gateway data dir
# (the same `cron/output/<job_id>/` layout this module keys runs on).
CRON_OUTPUT_DIR = os.environ.get("HERMES_CRON_OUTPUT_DIR", "cron/output")

UNATTRIBUTED_JOB_ID = "unattributed"
SKILLS_CURATOR_JOB_ID = "skills-curator"
MAX_OUTPUT_CHARS = 16_000
PREVIEW_CHARS = 160
CONTEXT_NOTE_OUTPUT_CHARS = 6_000
# How far back a job's change detection is recomputed on each write. A job that
# fires every five minutes must not rescan its whole history to file one run.
RECOMPUTE_WINDOW = 200
REPEAT_WINDOW = timedelta(hours=48)
# An alert he has opened goes quiet while it keeps saying the same thing — but
# not for ever. Still standing this long after he read it, it needs him again,
# once: the ops-watch backup warning read "the same" for four nights while
# every nightly backup failed (2026-09-30).
REMIND_AFTER = timedelta(hours=72)
SILENT_RETENTION_DAYS = 90
# The scheduler's notice for a job that failed before it could report.
_FAILURE_NOTICE_RE = re.compile(r"^\W*Cron '(.+?)' failed")

# A stored delivery and the run file it came from are the same run when their
# text is equal and they are this close in time.
BACKFILL_MATCH_WINDOW = timedelta(hours=3)
JOB_ITEMS_SCAN = 1500

NOTIFY_MODES = ("push", "quiet", "muted")
ATTENTION_SEVERITIES = ("alert", "warn", "failed")

_HUB_THREAD_CATEGORY = {"ops": "ops", "cron": "ops", "money": "money", "brief": "personal"}

_RUN_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_.-]{1,96}$")
_JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def valid_run_id(run_id: str) -> bool:
    return bool(_RUN_ID_RE.match(run_id))


def valid_job_id(job_id: str) -> bool:
    return bool(_JOB_ID_RE.match(job_id))


def job_of(run_id: str) -> str:
    return run_id.split(":", 1)[0]


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def local_day(run_time: str) -> str:
    return _parse_iso(run_time).astimezone(HUB_TZ).strftime("%Y-%m-%d")


def followup_thread_id(run_id: str) -> str:
    return "fu_" + hashlib.sha1(run_id.encode()).hexdigest()[:16]


def delivery_thread_id(job_id: str) -> str:
    return f"auto_{job_id}"


# --- what a run says ------------------------------------------------------------
def category_for(deliver: str | None, origin_platform: str | None = None) -> str:
    """Where a job's output belongs, from where it is sent. A job that only ever
    writes `local` has nobody it is addressed to, which is what background means."""
    targets = [t.strip() for t in (deliver or "").split(",") if t.strip()]
    for target in targets:
        platform, _, chat = target.partition(":")
        if platform == "hub" and chat in _HUB_THREAD_CATEGORY:
            return _HUB_THREAD_CATEGORY[chat]
    if targets and all(t == "local" for t in targets):
        return "background"
    if "origin" in targets:
        return "personal"
    return "ops" if targets else "background"


def severity_of(status: str, output: str) -> str:
    """Read from what the jobs already print: ops-watch, credit-watch and
    cron-watch open an alarm with a siren or a warning sign."""
    if status == "failed":
        return "failed"
    head = output.lstrip()[:4]
    if head.startswith("\U0001F6A8") or head.startswith("❌"):
        return "alert"
    if head.startswith("⚠"):
        return "warn"
    return "info"


_BULLET_RE = re.compile(r"^\s*(?:[-*•●◦]|\d+[.)])\s+")
_LEAD_MARK_RE = re.compile(r"^[^\w\s$(\[\"'`*_#]+\s*", re.UNICODE)
_MD_RE = re.compile(r"(\*\*|__|`|^#{1,6}\s+)")
_TAG_RE = re.compile(r"</?[A-Za-z][^<>]{0,80}>")


def _clean_line(line: str) -> str:
    line = _BULLET_RE.sub("", _TAG_RE.sub("", line).strip())
    line = _LEAD_MARK_RE.sub("", line)
    line = _MD_RE.sub("", line)
    return " ".join(line.split())


def item_count(output: str) -> int:
    return sum(1 for line in output.splitlines() if _BULLET_RE.match(line))


PREVIEW_LINES = 3
PREVIEW_LINE_CHARS = 90


def preview_lines(output: str) -> list[str]:
    """The first few lines a card shows, one per line, cleaned the same way
    as `preview_of` — joined into one run-on with "·", a report of four
    findings read as a single sentence (the user, 2026-09-30)."""
    raw = [line for line in output.splitlines() if line.strip()]
    lines = [c for c in (_clean_line(line) for line in raw) if c]
    if len(lines) > 1:
        first = raw[0].strip()
        heading = first.startswith("#") or (first.startswith("**") and first.endswith("**"))
        if heading or lines[0].endswith(":"):
            lines = lines[1:]
    return [
        line if len(line) <= PREVIEW_LINE_CHARS else line[: PREVIEW_LINE_CHARS - 1].rstrip() + "\u2026"
        for line in lines[:PREVIEW_LINES]
    ]


def preview_of(output: str) -> str:
    """One line for a list row. A first line that only names the job — a heading,
    or "ops-watch:" — says nothing the row's title has not already said."""
    raw = [line for line in output.splitlines() if line.strip()]
    lines = [c for c in (_clean_line(line) for line in raw) if c]
    if len(lines) > 1:
        first = raw[0].strip()
        heading = first.startswith("#") or (first.startswith("**") and first.endswith("**"))
        if heading or lines[0].endswith(":"):
            lines = lines[1:]
    text = " · ".join(lines)
    if len(text) > PREVIEW_CHARS:
        text = text[: PREVIEW_CHARS - 1].rstrip() + "…"
    return text


# What the clock changes on its own: dates, times, ages and durations. "last
# snapshot 112h ago" and "last snapshot 136h ago" are one finding a day apart.
# Every other number is compared as written: a balance going $9.97 to $0.82 is
# what the alert exists to say, and a review of the first cut found that
# masking it let the alert go quiet while the balance drained (2026-09-29).
_CLOCK_RE = re.compile(
    r"\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?"
    r"|\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b"
    r"|\b\d+(?:\.\d+)?\s*(?:h|d|m|s|min|mins|hr|hrs|hours?|days?|minutes?|seconds?|weeks?|months?)\b(?:\s+ago)?"
    r"|\(\d+(?:\.\d+)?[hdms]\)",
    re.IGNORECASE,
)


def normalized_lines(output: str) -> list[str]:
    out = []
    for line in output.splitlines():
        line = " ".join(_CLOCK_RE.sub("#", line).split()).lower()
        if line:
            out.append(line)
    return out


def fingerprint_of(output: str) -> str:
    lines = normalized_lines(output)
    return hashlib.sha1("\n".join(lines).encode()).hexdigest() if lines else ""


def context_note(job: dict[str, Any], run: dict[str, Any]) -> str:
    when = _parse_iso(run["run_time"]).astimezone(HUB_TZ).strftime("%Y-%m-%d %H:%M %Z")
    output = run["output"] or "(no output)"
    if len(output) > CONTEXT_NOTE_OUTPUT_CHARS:
        output = output[:CONTEXT_NOTE_OUTPUT_CHARS] + "\n(truncated)"
    job_id, _, stem = run["run_id"].partition(":")
    return (
        "This conversation is the user's follow-up to the output of a scheduled job. "
        f"Job: {job['name']} (id {job['job_id']}, schedule {job.get('schedule') or 'unknown'}, "
        f"{job.get('mode') or 'agent'}). Run: {when}, status {run['status']}. "
        f"The full run file, while the scheduler still keeps it: {CRON_OUTPUT_DIR}/{job_id}/{stem}.md\n"
        f"What that run reported:\n{output}"
    )


class AutomationStore:
    def __init__(self, store: ChatStore):
        self._store = store
        self._conn = store._conn
        self._lock = store._lock

    # -- ingest ----------------------------------------------------------------
    def upsert_jobs(self, jobs: list[dict[str, Any]], *, complete: bool) -> int:
        """`complete` means the list is the gateway's whole schedule, so a job
        missing from it has been removed there."""
        now = _iso(_now())
        with self._lock:
            for job in jobs:
                origin = job.get("origin") or {}
                origin_thread = origin.get("chat_id") if origin.get("platform") == "hub" else None
                self._conn.execute(
                    "INSERT INTO automation_jobs (job_id, name, schedule, deliver, state, mode, category, "
                    "origin_thread_id, next_run_at, last_status, last_error, updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?) "
                    "ON CONFLICT(job_id) DO UPDATE SET name=excluded.name, schedule=excluded.schedule, "
                    "deliver=excluded.deliver, state=excluded.state, mode=excluded.mode, "
                    "category=excluded.category, origin_thread_id=excluded.origin_thread_id, "
                    "next_run_at=excluded.next_run_at, last_status=excluded.last_status, "
                    "last_error=excluded.last_error, updated_at=excluded.updated_at",
                    (
                        job["id"], job.get("name") or job["id"], job.get("schedule"), job.get("deliver"),
                        job.get("state") or "active", job.get("mode") or "agent",
                        category_for(job.get("deliver"), origin.get("platform")),
                        origin_thread, job.get("next_run_at"), job.get("last_status"),
                        (job.get("last_error") or None), now,
                    ),
                )
            if complete and jobs:
                ids = [j["id"] for j in jobs]
                marks = ",".join("?" for _ in ids)
                self._conn.execute(
                    f"UPDATE automation_jobs SET state='removed', next_run_at=NULL, updated_at=? "
                    f"WHERE job_id NOT IN ({marks}) AND job_id NOT IN (?, ?) AND state != 'removed'",
                    (now, *ids, UNATTRIBUTED_JOB_ID, SKILLS_CURATOR_JOB_ID),
                )
            self._conn.commit()
        return len(jobs)

    def _ensure_job(self, job_id: str, name: str | None) -> None:
        """CALLER MUST HOLD `_lock`. A run whose job the schedule no longer lists
        still belongs to that job."""
        curator = job_id == SKILLS_CURATOR_JOB_ID
        self._conn.execute(
            "INSERT OR IGNORE INTO automation_jobs (job_id, name, state, category, updated_at) "
            "VALUES (?,?,?,?,?)",
            (
                job_id,
                name or ("Unattributed" if job_id == UNATTRIBUTED_JOB_ID else "Skills curator" if curator else job_id),
                "active" if curator else "removed",
                "ops",
                _iso(_now()),
            ),
        )

    def upsert_runs(self, runs: list[dict[str, Any]], *, source: str = "file") -> int:
        touched: set[str] = set()
        now = _iso(_now())
        with self._lock:
            try:
                self._upsert_runs_locked(runs, source, touched, now)
            except Exception:
                self._conn.rollback()
                raise
        return len(touched)

    def _upsert_runs_locked(self, runs: list[dict[str, Any]], source: str, touched: set[str], now: str) -> None:
        """CALLER MUST HOLD `_lock`. One transaction: a batch lands whole or not at all."""
        if True:
            for run in runs:
                status = run.get("status") or "ok"
                output = (run.get("output") or "").strip()
                truncated = bool(run.get("truncated")) or len(output) > MAX_OUTPUT_CHARS
                output = output[:MAX_OUTPUT_CHARS]
                if status == "ok" and not output:
                    status = "silent"
                self._ensure_job(run["job_id"], run.get("job_name"))
                existing = self._conn.execute(
                    "SELECT source FROM automation_runs WHERE run_id=?", (run["run_id"],)
                ).fetchone()
                # The run file is the record. A delivery that arrives after it
                # adds nothing; one that arrived before it is replaced by it.
                if existing and source != "file":
                    continue
                self._conn.execute(
                    "INSERT INTO automation_runs (run_id, job_id, run_time, status, severity, output, "
                    "truncated, fingerprint, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?) "
                    "ON CONFLICT(run_id) DO UPDATE SET run_time=excluded.run_time, status=excluded.status, "
                    "severity=excluded.severity, output=excluded.output, truncated=excluded.truncated, "
                    "fingerprint=excluded.fingerprint, source=excluded.source",
                    (
                        run["run_id"], run["job_id"], run["run_time"], status, severity_of(status, output),
                        output, int(truncated), fingerprint_of(output), source, now,
                    ),
                )
                touched.add(run["job_id"])
            for job_id in touched:
                self._recompute(job_id)
            self._conn.commit()

    def _recompute(self, job_id: str) -> None:
        """CALLER MUST HOLD `_lock`. Marks each run that says what the run before
        it said. A silent run in between resets the comparison: the finding
        went away and came back, and that is news."""
        rows = self._conn.execute(
            "SELECT run_id, run_time, status, output, unchanged, streak, streak_since FROM automation_runs "
            "WHERE job_id=? ORDER BY run_time DESC, run_id DESC LIMIT ?",
            (job_id, RECOMPUTE_WINDOW),
        ).fetchall()[::-1]
        previous: list[str] | None = None
        previous_at: datetime | None = None
        streak, since = 1, ""
        for index, row in enumerate(rows):
            if row["status"] == "silent":
                self._conn.execute(
                    "UPDATE automation_runs SET streak=1, streak_since=run_time WHERE run_id=?", (row["run_id"],)
                )
                continue
            lines = normalized_lines(row["output"])
            at = _parse_iso(row["run_time"])
            # A report is compared with the last report, silent runs between
            # them or not — a job that speaks each morning and is quiet the
            # rest of the day says the same thing on day two, not something
            # new. Past two days the finding is taken to have gone and come back.
            if previous_at is not None and at - previous_at > REPEAT_WINDOW:
                previous = None
            if index == 0 and len(rows) == RECOMPUTE_WINDOW:
                # The window's first row keeps what an earlier pass decided
                # about it — its streak included; what came before it is out of view.
                previous, previous_at = lines, at
                streak, since = row["streak"], row["streak_since"] or row["run_time"]
                continue
            unchanged = previous is not None and lines == previous
            # Stored, not walked back at read time: a streak longer than the
            # window would otherwise stop at the window's edge, and its start
            # would slide forward past what he had already read (review).
            streak, since = (streak + 1, since) if unchanged else (1, row["run_time"])
            seen = set(previous or [])
            new_lines = 0 if previous is None or unchanged else sum(1 for line in lines if line not in seen)
            self._conn.execute(
                "UPDATE automation_runs SET unchanged=?, new_lines=?, fingerprint=?, streak=?, streak_since=? "
                "WHERE run_id=?",
                (int(unchanged), new_lines, fingerprint_of(row["output"]), streak, since, row["run_id"]),
            )
            previous, previous_at = lines, at

    def record_delivery(self, *, job_id: str, run_id: str, text: str) -> dict[str, Any]:
        """A live delivery, which reaches here before the feed has seen its run file."""
        self.upsert_runs(
            [{"run_id": run_id, "job_id": job_id, "run_time": _iso(_now()), "status": "ok", "output": text}],
            source="delivery",
        )
        return self.get_run(run_id)  # type: ignore[return-value]

    def prune(self) -> int:
        cutoff = _iso(_now() - timedelta(days=SILENT_RETENTION_DAYS))
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM automation_runs WHERE status='silent' AND run_time < ?", (cutoff,)
            )
            self._conn.commit()
            return cur.rowcount

    # -- reads -------------------------------------------------------------------
    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM automation_jobs WHERE job_id=?", (job_id,)).fetchone()
            return dict(row) if row else None

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM automation_runs WHERE run_id=?", (run_id,)).fetchone()
            return dict(row) if row else None

    def _replies(self, run_id: str) -> int:
        """CALLER MUST HOLD `_lock`. What the user has said under this run."""
        row = self._conn.execute(
            "SELECT COUNT(*) AS n FROM messages m JOIN threads t ON t.id = m.thread_id "
            "WHERE t.origin_run_id=? AND m.role='user'",
            (run_id,),
        ).fetchone()
        return int(row["n"])

    def _streak(self, job_id: str, run: dict[str, Any]) -> tuple[int, str]:
        """CALLER MUST HOLD `_lock`. How many runs in a row have said this, and
        when the first of them ran."""
        return int(run.get("streak") or 1), run.get("streak_since") or run["run_time"]

    def _run_summary(self, run: dict[str, Any], job: dict[str, Any]) -> dict[str, Any]:
        """CALLER MUST HOLD `_lock`."""
        streak, since = self._streak(run["job_id"], run) if run["status"] != "silent" else (1, run["run_time"])
        read_through = job.get("read_through")
        # An alert he has already opened stays opened while it keeps saying the
        # same thing: what is acknowledged is the finding, not the one run —
        # until REMIND_AFTER has passed since he read it.
        read = (
            bool(read_through)
            and since <= read_through
            and not (
                run["severity"] in ATTENTION_SEVERITIES
                and _parse_iso(run["run_time"]) > _parse_iso(read_through) + REMIND_AFTER
            )
        )
        return {
            "run_id": run["run_id"],
            "job_id": run["job_id"],
            "job_name": job["name"],
            "category": job["category"],
            "run_time": run["run_time"],
            "day": local_day(run["run_time"]),
            "status": run["status"],
            "severity": run["severity"],
            "preview": preview_of(run["output"]),
            "preview_lines": preview_lines(run["output"]),
            "more_lines": max(0, item_count(run["output"]) - PREVIEW_LINES),
            # Equal for two runs that say the same thing, numbers aside — what
            # lets the app show ten jobs failing one way as one row.
            "fingerprint": run["fingerprint"],
            "items": item_count(run["output"]),
            "unchanged": bool(run["unchanged"]),
            "new_lines": run["new_lines"],
            "streak": streak,
            "since": since,
            "read": read,
            "replies": self._replies(run["run_id"]),
        }

    def _job_summary(self, job: dict[str, Any], now: datetime) -> dict[str, Any]:
        """CALLER MUST HOLD `_lock`."""
        job_id = job["job_id"]
        latest = self._conn.execute(
            "SELECT * FROM automation_runs WHERE job_id=? AND status != 'silent' "
            "ORDER BY run_time DESC, run_id DESC LIMIT 1",
            (job_id,),
        ).fetchone()
        last = self._conn.execute(
            "SELECT run_time, status FROM automation_runs WHERE job_id=? ORDER BY run_time DESC, run_id DESC LIMIT 1",
            (job_id,),
        ).fetchone()
        since = _iso(now - timedelta(days=30))
        counts = {
            r["status"]: r["n"]
            for r in self._conn.execute(
                "SELECT status, COUNT(*) AS n FROM automation_runs WHERE job_id=? AND run_time >= ? GROUP BY status",
                (job_id, since),
            )
        }
        unread = self._conn.execute(
            "SELECT COUNT(*) AS n FROM automation_runs WHERE job_id=? AND status != 'silent' "
            "AND unchanged = 0 AND run_time > ?",
            (job_id, job.get("read_through") or ""),
        ).fetchone()["n"]
        followups = self._conn.execute(
            "SELECT COUNT(DISTINCT t.id) AS n FROM threads t JOIN messages m ON m.thread_id = t.id "
            "WHERE substr(t.origin_run_id, 1, ?) = ? AND m.role='user'",
            (len(job_id) + 1, f"{job_id}:"),
        ).fetchone()["n"]
        origin = None
        if job.get("origin_thread_id"):
            thread = self._conn.execute(
                "SELECT id, title FROM threads WHERE id=?", (job["origin_thread_id"],)
            ).fetchone()
            if thread:
                origin = {"id": thread["id"], "title": thread["title"]}

        muted = job["notify"] == "muted"
        latest_summary = self._run_summary(dict(latest), job) if latest else None
        snoozed = self._snoozed(job, latest_summary, now)
        # Only a job that is still scheduled can need him, and only while the
        # newest run of any kind is the one that raised it: a failure followed
        # by a clean run, or a warning followed by a silent one, has cleared.
        standing = bool(
            latest_summary
            and last
            and last["run_time"] == latest["run_time"]
            and job["state"] == "active"
            and latest_summary["severity"] in ATTENTION_SEVERITIES
        )
        needs_you = standing and not latest_summary["read"] and not snoozed and not muted  # type: ignore[index]
        if muted or snoozed:
            unread = 0
        background = job["category"] == "background"
        ended = job["state"] in ("removed", "completed")
        if needs_you:
            section = "needs_you"
        elif background or muted or latest_summary is None or (ended and unread == 0):
            section = "quiet"
        elif unread > 0:
            section = "new"
        else:
            section = "earlier"
        return {
            "id": job_id,
            "name": job["name"],
            "category": job["category"],
            "schedule": job.get("schedule"),
            "deliver": job.get("deliver"),
            "state": job["state"],
            "mode": job["mode"],
            "next_run_at": job.get("next_run_at"),
            "last_status": job.get("last_status"),
            "last_error": job.get("last_error"),
            "notify": job["notify"],
            "snoozed_until": job["snoozed_until"] if job.get("snoozed_until") and job["snoozed_until"] > _iso(now) else None,
            "standing": standing,
            "origin_thread": origin,
            "latest": latest_summary,
            "last_run": {"run_time": last["run_time"], "status": last["status"]} if last else None,
            "unread": 0 if background and not needs_you else unread,
            "needs_you": needs_you,
            "followups": followups,
            "section": section,
            "counts_30d": {
                "runs": sum(counts.values()),
                "reported": counts.get("ok", 0),
                "silent": counts.get("silent", 0),
                "failed": counts.get("failed", 0),
            },
        }

    def _snoozed(self, job: dict[str, Any], latest: dict[str, Any] | None, now: datetime) -> bool:
        """A snooze covers the finding he snoozed, not the job: a run that adds
        a line or changes severity breaks through. Numbers moving inside the
        same lines do not — that is what he asked not to hear about for a while."""
        until = job.get("snoozed_until")
        if not until or until <= _iso(now) or latest is None:
            return False
        if latest["new_lines"] > 0 and latest["run_time"] > (job.get("snoozed_at") or ""):
            return False
        if job.get("snoozed_severity") and latest["severity"] != job["snoozed_severity"]:
            return False
        return True

    def job_summary(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self.get_job(job_id)
            return self._job_summary(job, _now()) if job else None

    def list_jobs(self) -> dict[str, Any]:
        """Every job that has ever run or is scheduled to. A removed job with
        nothing to show is the one thing left out."""
        now = _now()
        with self._lock:
            rows = [dict(r) for r in self._conn.execute("SELECT * FROM automation_jobs").fetchall()]
            jobs = []
            for job in rows:
                summary = self._job_summary(job, now)
                if job["state"] == "removed" and summary["last_run"] is None:
                    continue
                jobs.append(summary)
        order = {"needs_you": 0, "new": 1, "earlier": 2, "quiet": 3}

        def latest_time(job: dict[str, Any]) -> str:
            head = job["latest"] or job["last_run"]
            return head["run_time"] if head else ""

        jobs.sort(key=lambda j: j["name"].lower())
        jobs.sort(key=latest_time, reverse=True)
        jobs.sort(key=lambda j: order[j["section"]])
        return {
            "jobs": jobs,
            "counts": {
                "needs_you": sum(1 for j in jobs if j["needs_you"]),
                "unread": sum(j["unread"] for j in jobs),
                "jobs": len(jobs),
            },
            "generated_at": _iso(now),
        }

    def timeline(self, *, days: int = 7, before: str | None = None) -> dict[str, Any]:
        """Strict time order, a day at a time. What a job reported is a row; the
        runs that had nothing to say are one count per job per day."""
        end_local = (
            datetime.strptime(before, "%Y-%m-%d").replace(tzinfo=HUB_TZ)
            if before
            else (datetime.now(HUB_TZ) + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        )
        start_local = end_local - timedelta(days=days)
        with self._lock:
            jobs = {r["job_id"]: dict(r) for r in self._conn.execute("SELECT * FROM automation_jobs")}
            rows = self._conn.execute(
                "SELECT * FROM automation_runs WHERE run_time >= ? AND run_time < ? "
                "ORDER BY run_time DESC, run_id DESC",
                (_iso(start_local), _iso(end_local)),
            ).fetchall()
            by_day: dict[str, dict[str, Any]] = {}
            for row in rows:
                run = dict(row)
                job = jobs.get(run["job_id"])
                if job is None:
                    continue
                day = by_day.setdefault(local_day(run["run_time"]), {"runs": [], "quiet": {}})
                reported = run["status"] != "silent"
                shown = reported and job["notify"] != "muted" and (
                    job["category"] != "background" or run["status"] == "failed"
                )
                if shown:
                    day["runs"].append(self._run_summary(run, job))
                    continue
                quiet = day["quiet"].setdefault(
                    run["job_id"], {"job_id": run["job_id"], "name": job["name"], "count": 0, "silent": 0}
                )
                quiet["count"] += 1
                quiet["silent"] += 0 if reported else 1
            older = self._conn.execute(
                "SELECT 1 FROM automation_runs WHERE run_time < ? LIMIT 1", (_iso(start_local),)
            ).fetchone()
        out = [
            {
                "day": day,
                "runs": body["runs"],
                "quiet": sorted(body["quiet"].values(), key=lambda q: (-q["count"], q["name"].lower())),
            }
            for day, body in sorted(by_day.items(), reverse=True)
        ]
        return {
            "days": out,
            "before": start_local.strftime("%Y-%m-%d") if older else None,
        }

    def job_items(self, job_id: str) -> list[dict[str, Any]]:
        """One job's history, newest first, with the runs that added nothing
        folded: a stretch of silent runs, or of runs repeating the one before."""
        with self._lock:
            job = self.get_job(job_id)
            if job is None:
                return []
            rows = [
                dict(r)
                for r in self._conn.execute(
                    "SELECT * FROM automation_runs WHERE job_id=? ORDER BY run_time DESC, run_id DESC LIMIT ?",
                    (job_id, JOB_ITEMS_SCAN),
                )
            ]
            items: list[dict[str, Any]] = []
            newest_reported = next((r["run_id"] for r in rows if r["status"] != "silent"), None)
            for run in rows:
                if run["status"] == "silent":
                    span = "silent"
                elif run["unchanged"] and run["run_id"] != newest_reported and self._replies(run["run_id"]) == 0:
                    span = "unchanged"
                else:
                    items.append({"kind": "run", "run": self._run_summary(run, job)})
                    continue
                tail = items[-1] if items else None
                if tail and tail["kind"] == "span" and tail["span"] == span:
                    tail["count"] += 1
                    tail["from"] = run["run_time"]
                else:
                    items.append(
                        {"kind": "span", "span": span, "count": 1, "from": run["run_time"], "to": run["run_time"]}
                    )
            return items

    def run_parts(self, run: dict[str, Any]) -> list[dict[str, Any]]:
        """What the run screen draws: the run's words, then anything else it
        delivered (an image, a file)."""
        parts: list[dict[str, Any]] = []
        if run["output"]:
            parts.append({"type": "text", "text": run["output"]})
        with self._lock:
            ids = self._conn.execute(
                "SELECT id FROM messages WHERE job_run_id=? ORDER BY seq", (run["run_id"],)
            ).fetchall()
            for row in ids:
                for part in self._store._message_row(row["id"])["parts"]:
                    if part.get("type") not in ("text", "reasoning"):
                        parts.append(part)
        return parts

    # -- writes from the phone -----------------------------------------------------
    def mark_read(self, job_id: str, *, through: str | None = None) -> None:
        with self._lock:
            if through is None:
                row = self._conn.execute(
                    "SELECT MAX(run_time) AS t FROM automation_runs WHERE job_id=?", (job_id,)
                ).fetchone()
                through = row["t"]
            if not through:
                return
            self._conn.execute(
                "UPDATE automation_jobs SET read_through=? WHERE job_id=? "
                "AND (read_through IS NULL OR read_through < ?)",
                (through, job_id, through),
            )
            self._conn.commit()

    def baseline(self) -> dict[str, int]:
        """Cutover: everything already said is read, except a finding that is
        still standing. Without it the first open shows every run the box has
        on file as new. For a job whose latest word is an alert, the cursor
        stops just short of where that finding began, so it needs him once —
        not once per run it has repeated."""
        counts = {"read": 0, "standing": 0}
        with self._lock:
            jobs = [dict(r) for r in self._conn.execute("SELECT * FROM automation_jobs").fetchall()]
            for job in jobs:
                latest = self._conn.execute(
                    "SELECT * FROM automation_runs WHERE job_id=? AND status != 'silent' "
                    "ORDER BY run_time DESC, run_id DESC LIMIT 1",
                    (job["job_id"],),
                ).fetchone()
                newest = self._conn.execute(
                    "SELECT MAX(run_time) AS t FROM automation_runs WHERE job_id=?", (job["job_id"],)
                ).fetchone()["t"]
                if not newest:
                    continue
                standing = (
                    latest is not None
                    and latest["run_time"] == newest
                    and job["state"] == "active"
                    and latest["severity"] in ATTENTION_SEVERITIES
                )
                if standing:
                    _, since = self._streak(job["job_id"], dict(latest))
                    through = _iso(_parse_iso(since) - timedelta(seconds=1))
                    counts["standing"] += 1
                else:
                    through = newest
                    counts["read"] += 1
                # Only ever forward: a second call must not re-raise an alert
                # he acknowledged after the first.
                self._conn.execute(
                    "UPDATE automation_jobs SET read_through=? WHERE job_id=? "
                    "AND (read_through IS NULL OR read_through < ?)",
                    (through, job["job_id"], through),
                )
            self._conn.commit()
        return counts

    def mark_all_read(self) -> int:
        """Clears New. A standing alert is acknowledged by opening it, never by
        one tap on a chip that was really aimed at the noise around it."""
        with self._lock:
            now = _now()
            cleared = 0
            for row in self._conn.execute("SELECT * FROM automation_jobs").fetchall():
                if self._job_summary(dict(row), now)["needs_you"]:
                    continue
                self.mark_read(row["job_id"])
                cleared += 1
            return cleared

    def set_prefs(
        self, job_id: str, *, notify: str | None = None, snooze_hours: int | None = None, clear_snooze: bool = False
    ) -> dict[str, Any] | None:
        with self._lock:
            if self.get_job(job_id) is None:
                return None
            if notify is not None:
                self._conn.execute("UPDATE automation_jobs SET notify=? WHERE job_id=?", (notify, job_id))
            if clear_snooze:
                self._conn.execute(
                    "UPDATE automation_jobs SET snoozed_until=NULL, snoozed_at=NULL, snoozed_severity=NULL WHERE job_id=?",
                    (job_id,),
                )
            elif snooze_hours is not None:
                until = _iso(_now() + timedelta(hours=snooze_hours))
                latest = self._conn.execute(
                    "SELECT severity FROM automation_runs WHERE job_id=? AND status != 'silent' "
                    "ORDER BY run_time DESC, run_id DESC LIMIT 1",
                    (job_id,),
                ).fetchone()
                self._conn.execute(
                    "UPDATE automation_jobs SET snoozed_until=?, snoozed_at=?, snoozed_severity=? WHERE job_id=?",
                    (until, _iso(_now()), latest["severity"] if latest else None, job_id),
                )
            self._conn.commit()
            return self.job_summary(job_id)

    def open_followup(self, run_id: str) -> dict[str, Any] | None:
        """The thread under a run, made the first time the run is opened. The
        run's output is parked as a note, so it rides the user's first message and
        Assistant answers with the run in hand."""
        with self._lock:
            run = self.get_run(run_id)
            if run is None:
                return None
            job = self.get_job(run["job_id"])
            thread_id = followup_thread_id(run_id)
            if self._store.get_thread(thread_id) is None:
                when = _parse_iso(run["run_time"]).astimezone(HUB_TZ)
                title = f"{job['name']} · {when.strftime('%b')} {when.day}"
                self._store.get_or_create_thread(
                    thread_id, kind="followup", title=title, origin_run_id=run_id
                )
                self._store.note_for_agent(thread_id, context_note(job, run))
            return self._store.get_thread_summary(thread_id)

    # -- history -------------------------------------------------------------------
    def backfill_deliveries(self, *, dry_run: bool = True) -> dict[str, Any]:
        """Files what the catch-all threads already hold under the job that sent it.

        A row is attributed only on evidence, tried in this order:
          named   it is the scheduler's own failure notice, which names its job;
          text    its text equals a run file's output, and only one job has said that;
          thread  exactly one job delivers to the thread it is in;
          opener  its first line (numbers masked) opens runs of one job and no other.
        A row none of those claims stays where it is, in its thread: a progress
        line or a note in a conversation is not a job's output, and filing it
        under a made-up job would take it out of the conversation it belongs to. Rows that are part of a conversation — the user's
        own, and anything a chat turn produced — are never candidates."""
        report: dict[str, Any] = {"dry_run": dry_run, "by_rule": {}, "by_job": {}, "rows": 0}
        with self._lock:
            jobs = {r["job_id"]: dict(r) for r in self._conn.execute("SELECT * FROM automation_jobs")}
            by_text: dict[str, set[str]] = {}
            openers: dict[str, set[str]] = {}
            for row in self._conn.execute(
                "SELECT job_id, output FROM automation_runs WHERE status != 'silent' AND source = 'file'"
            ):
                by_text.setdefault(row["output"].strip(), set()).add(row["job_id"])
                lines = normalized_lines(row["output"])
                if lines:
                    openers.setdefault(lines[0], set()).add(row["job_id"])
            by_name: dict[str, set[str]] = {}
            for job in jobs.values():
                by_name.setdefault(job["name"], set()).add(job["job_id"])
            thread_jobs: dict[str, set[str]] = {}
            for job in jobs.values():
                for target in (job.get("deliver") or "").split(","):
                    platform, _, chat = target.strip().partition(":")
                    if platform == "hub" and chat:
                        thread_jobs.setdefault(chat, set()).add(job["job_id"])

            marks = ",".join("?" for _ in LEGACY_DELIVERY_KINDS)
            candidates = self._conn.execute(
                "SELECT m.id, m.thread_id, m.created_at FROM messages m JOIN threads t ON t.id = m.thread_id "
                f"WHERE t.kind IN ({marks}) AND m.role = 'assistant' AND m.run_id IS NULL "
                "AND m.job_id IS NULL ORDER BY m.created_at, m.seq",
                LEGACY_DELIVERY_KINDS,
            ).fetchall()
            new_runs: list[dict[str, Any]] = []
            filed: list[str] = []
            for row in candidates:
                text = self._store._text_of(row["id"]).strip()
                if not text:
                    continue
                lines = normalized_lines(text)
                job_id, rule = UNATTRIBUTED_JOB_ID, "unattributed"
                named = _FAILURE_NOTICE_RE.match(text)
                if named and len(by_name.get(named.group(1), ())) == 1:
                    job_id, rule = next(iter(by_name[named.group(1)])), "named"
                elif len(by_text.get(text, ())) == 1:
                    job_id, rule = next(iter(by_text[text])), "text"
                elif len(thread_jobs.get(row["thread_id"], ())) == 1:
                    job_id, rule = next(iter(thread_jobs[row["thread_id"]])), "thread"
                elif lines and len(openers.get(lines[0], ())) == 1:
                    job_id, rule = next(iter(openers[lines[0]])), "opener"
                if rule == "unattributed":
                    report["left_in_thread"] = report.get("left_in_thread", 0) + 1
                    continue
                report["rows"] += 1
                report["by_rule"][rule] = report["by_rule"].get(rule, 0) + 1
                run_id = self._matching_run(job_id, text, row["created_at"])
                if run_id is None:
                    run_id = f"{job_id}:m{row['id'].removeprefix('msg_')}"
                    new_runs.append({
                        "run_id": run_id, "job_id": job_id, "run_time": row["created_at"],
                        "status": "ok", "output": text,
                    })
                name = jobs[job_id]["name"]
                report["by_job"][name] = report["by_job"].get(name, 0) + 1
                filed.append(row["id"])
                self._conn.execute(
                    "UPDATE messages SET job_id=?, job_run_id=? WHERE id=?", (job_id, run_id, row["id"])
                )
            report["runs_added"] = len(new_runs)
            if dry_run:
                self._conn.rollback()
            else:
                # The runs land before the rows that point at them are committed,
                # so a failure between the two never leaves a row filed under a
                # run that does not exist.
                pending = self._conn.execute(
                    "SELECT id, job_id, job_run_id FROM messages WHERE job_id IS NOT NULL AND job_run_id IS NOT NULL "
                    "AND id IN (SELECT value FROM json_each(?))",
                    (json.dumps(filed),),
                ).fetchall()
                self._conn.rollback()
                self.upsert_runs(new_runs, source="backfill")
                self._conn.executemany(
                    "UPDATE messages SET job_id=?, job_run_id=? WHERE id=?",
                    [(r["job_id"], r["job_run_id"], r["id"]) for r in pending],
                )
                self._conn.commit()
        return report

    def _matching_run(self, job_id: str, text: str, created_at: str) -> str | None:
        """CALLER MUST HOLD `_lock`. The run file this stored delivery came from."""
        moment = _parse_iso(created_at)
        rows = self._conn.execute(
            "SELECT run_id, run_time FROM automation_runs WHERE job_id=? AND output=? AND run_time BETWEEN ? AND ?",
            (job_id, text, _iso(moment - BACKFILL_MATCH_WINDOW), _iso(moment + BACKFILL_MATCH_WINDOW)),
        ).fetchall()
        if not rows:
            return None
        return min(rows, key=lambda r: abs(_parse_iso(r["run_time"]) - moment))["run_id"]

    def should_push(self, run: dict[str, Any]) -> bool:
        job = self.get_job(run["job_id"])
        if job is None or job["notify"] != "push":
            return False
        if run["unchanged"] and not self._first_reminder(job, run):
            return False
        with self._lock:
            return not self._snoozed(job, self._run_summary(run, job), _now())

    def _first_reminder(self, job: dict[str, Any], run: dict[str, Any]) -> bool:
        """Is this the run that crossed REMIND_AFTER on an alert he had read?
        One push when a standing finding outlasts his acknowledgement, not one
        per run from then on."""
        if run["severity"] not in ATTENTION_SEVERITIES or not job.get("read_through"):
            return False
        line = _iso(_parse_iso(job["read_through"]) + REMIND_AFTER)
        if run["run_time"] <= line:
            return False
        with self._lock:
            previous = self._conn.execute(
                "SELECT MAX(run_time) AS t FROM automation_runs WHERE job_id=? AND status != 'silent' AND run_time < ?",
                (run["job_id"], run["run_time"]),
            ).fetchone()["t"]
        return previous is None or previous <= line

    def badge(self) -> dict[str, int]:
        """The tab's number and nothing else, for a read that carries no cookie."""
        return {"needs_you": self.list_jobs()["counts"]["needs_you"]}
