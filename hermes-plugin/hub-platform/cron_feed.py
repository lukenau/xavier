# SPDX-License-Identifier: MIT
"""The gateway's schedule and run files, fed to the hub's Automations view.

The scheduler writes one file per run to ``cron/output/<job_id>/<stem>.md``
BEFORE it delivers (``save_job_output``, then ``_deliver_result``). Two things
follow from that, and they are the whole of how the Hub groups what jobs say:

* a run's job is the directory it was written to, so nothing about grouping is
  ever guessed from a channel, a title or the text;
* when ``send()`` is handed a delivery carrying ``metadata.job_id``, the newest
  file in that job's directory IS the run being delivered — ``run_id_for``.

``CronFeed.tick`` posts every job and every run file the hub has not been sent
yet, silent and ``local`` ones included, which is what makes a job that never
messages anyone visible at all. Read-only over ``cron/``: jobs.json is parsed,
never written.
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from . import paths

logger = logging.getLogger(__name__)

CRON_DIR = os.environ.get("HUB_CRON_DIR") or paths.under_home("cron")
SYNC_PATH = "/api/platform/hub/automations/sync"
POLL_S = float(os.environ.get("HUB_CRON_FEED_POLL_S", "30"))
START_DELAY_S = float(os.environ.get("HUB_CRON_FEED_START_DELAY_S", "25"))
BATCH = 40
MAX_OUTPUT_CHARS = 16_000

JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_STEM_RE = re.compile(r"^[A-Za-z0-9_.-]{1,96}$")
_SILENT_RESPONSES = frozenset({"[silent]", "silent", "no_reply", "no reply"})
_HEADER_FIELDS = (("status", "**Status:**"), ("mode", "**Mode:**"))


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _after_last(text: str, heading: str) -> Optional[str]:
    marker = f"\n{heading}\n"
    at = text.rfind(marker)
    return text[at + len(marker):] if at >= 0 else None


def _says_silent(output: str) -> bool:
    """The scheduler's own rule for "nothing to deliver": the bracketed marker as
    the whole answer, its first line or its last; the bare words only whole."""
    text = output.strip()
    if text.lower() in _SILENT_RESPONSES:
        return True
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return bool(lines) and "[SILENT]" in (lines[0], lines[-1])


def parse_run_file(text: str) -> Dict[str, Any]:
    """One run file -> ``{name, status, output, truncated}``.

    Three shapes, all the scheduler's own. A script run carries ``**Mode:**``
    and, when it said nothing or failed, ``**Status:**``; its output follows a
    ``---`` rule or the status line. An agent run carries the whole prompt, so
    its output is what follows the LAST ``## Response`` — a prompt is free to
    contain that heading itself. A run that died has ``## Error`` instead."""
    lines = text.splitlines()
    name = None
    failed_title = False
    header: Dict[str, str] = {}
    body_start = 0
    for index, line in enumerate(lines[:12]):
        stripped = line.strip()
        if stripped.startswith("# Cron Job:"):
            name = stripped[len("# Cron Job:"):].strip()
            if name.endswith("(FAILED)"):
                name, failed_title = name[: -len("(FAILED)")].strip(), True
            body_start = index + 1
            continue
        if stripped.startswith("**") and ":**" in stripped:
            for key, prefix in _HEADER_FIELDS:
                if stripped.startswith(prefix):
                    header[key] = stripped[len(prefix):].strip()
            body_start = index + 1
            continue
        if stripped == "---":
            body_start = index + 1
            break
        if stripped:
            break
    rest = "\n".join(lines[body_start:]) + "\n"

    agent = "mode" not in header and "\n## Prompt\n" in "\n" + rest
    response = _after_last("\n" + rest, "## Response") if agent else None
    error = _after_last("\n" + rest, "## Error") if agent else None
    status_line = header.get("status", "").lower()
    if not agent:
        output = rest
        status = "failed" if "fail" in status_line or failed_title else "ok"
        if status_line.startswith("silent"):
            status, output = "silent", ""
    elif error is not None and (failed_title or response is None or len(error) < len(response)):
        # The section the scheduler wrote last is the one nearest the end. A
        # prompt that itself contains "## Response" must not be read as the
        # answer of a run that died.
        output = error.strip().strip("`").strip()
        status = "failed"
    elif response is not None:
        output = response
        status = "ok"
    else:
        # The prompt and nothing after it: the run never got as far as an answer.
        output, status = "", "failed" if failed_title else "silent"
    if status == "ok" and _says_silent(output):
        status, output = "silent", ""
    output = output.strip()
    if status == "ok" and not output:
        status = "silent"
    truncated = len(output) > MAX_OUTPUT_CHARS
    return {"name": name or None, "status": status, "output": output[:MAX_OUTPUT_CHARS], "truncated": truncated}


def run_files(output_dir: str) -> List[Tuple[str, str, str, float]]:
    """Every run file as ``(job_id, stem, path, mtime)``, oldest first."""
    found: List[Tuple[str, str, str, float]] = []
    try:
        jobs = list(os.scandir(output_dir))
    except OSError:
        return found
    for job_dir in jobs:
        if not job_dir.is_dir(follow_symlinks=False) or not JOB_ID_RE.match(job_dir.name):
            continue
        try:
            entries = list(os.scandir(job_dir.path))
        except OSError:
            continue
        for entry in entries:
            stem, ext = os.path.splitext(entry.name)
            if ext != ".md" or not _STEM_RE.match(stem):
                continue
            try:
                found.append((job_dir.name, stem, entry.path, entry.stat().st_mtime))
            except OSError:
                continue
    found.sort(key=lambda row: (row[3], row[0], row[1]))
    return found


def run_id_for(job_id: str, output_dir: Optional[str] = None) -> Optional[str]:
    """The run a delivery for this job belongs to: the newest file in its
    directory, which the scheduler wrote just before it called ``send()``."""
    if not JOB_ID_RE.match(job_id or ""):
        return None
    directory = os.path.join(output_dir or os.path.join(CRON_DIR, "output"), job_id)
    newest: Optional[Tuple[float, str]] = None
    try:
        for entry in os.scandir(directory):
            stem, ext = os.path.splitext(entry.name)
            if ext != ".md" or not _STEM_RE.match(stem):
                continue
            mtime = entry.stat().st_mtime
            if newest is None or (mtime, stem) > newest:
                newest = (mtime, stem)
    except OSError:
        return None
    return f"{job_id}:{newest[1]}" if newest else None


def job_record(job: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    job_id = str(job.get("id") or "")
    if not JOB_ID_RE.match(job_id):
        return None
    schedule = job.get("schedule")
    display = job.get("schedule_display") or (
        (schedule.get("display") or schedule.get("expr")) if isinstance(schedule, dict) else schedule
    )
    if job.get("enabled", True):
        state = "active"
    else:
        state = "completed" if job.get("state") == "completed" else "paused"
    origin = job.get("origin") if isinstance(job.get("origin"), dict) else None
    return {
        "id": job_id,
        "name": str(job.get("name") or job_id)[:200],
        "schedule": str(display)[:120] if display else None,
        "deliver": str(job.get("deliver") or "")[:400] or None,
        "state": state,
        "mode": "script" if job.get("no_agent") else "agent",
        "next_run_at": job.get("next_run_at") if state == "active" else None,
        "last_status": job.get("last_status"),
        "last_error": (str(job.get("last_error") or job.get("last_delivery_error") or "")[:500] or None),
        "origin": {"platform": origin.get("platform"), "chat_id": origin.get("chat_id")} if origin else None,
    }


def read_jobs(jobs_file: str) -> Optional[List[Dict[str, Any]]]:
    """None when the file could not be read — which must never be sent as "the
    schedule is empty", or every job would be marked removed."""
    try:
        with open(jobs_file, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    jobs = data.get("jobs") if isinstance(data, dict) else data
    if not isinstance(jobs, list):
        return None
    return [r for r in (job_record(j) for j in jobs if isinstance(j, dict)) if r]


class CronFeed:
    def __init__(self, client: Any, cron_dir: Optional[str] = None):
        base = cron_dir or CRON_DIR
        self._client = client
        self.output_dir = os.path.join(base, "output")
        self.jobs_file = os.path.join(base, "jobs.json")
        self._sent: Dict[str, float] = {}
        self._jobs_mtime: Optional[float] = None

    def _pending_runs(self) -> List[Tuple[str, str, str, float]]:
        files = run_files(self.output_dir)
        live = {path for _, _, path, _ in files}
        for path in [p for p in self._sent if p not in live]:
            del self._sent[path]
        return [row for row in files if self._sent.get(row[2]) != row[3]]

    def _run_record(self, row: Tuple[str, str, str, float]) -> Optional[Dict[str, Any]]:
        job_id, stem, path, mtime = row
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                parsed = parse_run_file(f.read())
        except OSError:
            return None
        return {
            "run_id": f"{job_id}:{stem}",
            "job_id": job_id,
            "job_name": parsed["name"],
            "run_time": _iso(mtime),
            "status": parsed["status"],
            "output": parsed["output"],
            "truncated": parsed["truncated"],
        }

    def tick(self) -> Dict[str, int]:
        """One pass. A batch that did not land is left unsent and tried again on
        the next pass; nothing is dropped because hub-api was restarting."""
        stats = {"jobs": 0, "runs": 0, "failed": 0}
        try:
            jobs_mtime: Optional[float] = os.stat(self.jobs_file).st_mtime
        except OSError:
            jobs_mtime = None
        if jobs_mtime is not None and jobs_mtime != self._jobs_mtime:
            jobs = read_jobs(self.jobs_file)
            if jobs:
                status, _ = self._client.post(SYNC_PATH, {"jobs": jobs, "jobs_complete": True})
                if 200 <= status < 300:
                    self._jobs_mtime = jobs_mtime
                    stats["jobs"] = len(jobs)
                else:
                    stats["failed"] += 1
        pending = self._pending_runs()
        for start in range(0, len(pending), BATCH):
            rows = pending[start:start + BATCH]
            records = [r for r in (self._run_record(row) for row in rows) if r]
            if records:
                status, _ = self._client.post(SYNC_PATH, {"runs": records})
                if 400 <= status < 500:
                    # hub-api refused something in the batch. Find which, one at
                    # a time, and mark the refused one sent: a record it will
                    # never accept must not hold every run behind it forever.
                    for record in records:
                        one, _ = self._client.post(SYNC_PATH, {"runs": [record]})
                        if one == 0 or one >= 500:
                            stats["failed"] += 1
                            return stats
                        if not 200 <= one < 300:
                            stats["refused"] = stats.get("refused", 0) + 1
                            logger.warning("hub cron feed: hub-api refused run %s (%s)", record["run_id"], one)
                elif not 200 <= status < 300:
                    stats["failed"] += 1
                    return stats
            for _, _, path, mtime in rows:
                self._sent[path] = mtime
            stats["runs"] += len(records)
        return stats
