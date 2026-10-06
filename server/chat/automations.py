"""Automations routes — the plugin's feed in, the phone's reads and writes out.

Two routers, two credentials, same as the rest of chat/:
  POST /api/platform/hub/automations/sync   HUB_PLATFORM_KEY — jobs and runs from the
                                            gateway's own schedule and run files.
  /api/chat/automations/*                   the chat session cookie — what the
                                            Automations tab reads and writes.

Reads sit behind the cookie because a run's output is the same material a chat
thread holds: balances, orders, what the ops checks found.
"""
from __future__ import annotations

import re
import threading
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, model_validator

from chat.automation_store import (
    NOTIFY_MODES,
    AutomationStore,
    job_of,
    valid_job_id,
    valid_run_id,
)
from chat.platform import _platform_key_dep, get_store
from chat.routes import _chat_session_dep, _thread_payload

MAX_SYNC_JOBS = 500
MAX_SYNC_RUNS = 200
MAX_SNOOZE_HOURS = 24 * 30

_automations: AutomationStore | None = None
_automations_lock = threading.Lock()


def get_automations() -> AutomationStore:
    global _automations
    store = get_store()
    with _automations_lock:
        if _automations is None or _automations._store is not store:
            _automations = AutomationStore(store)
    return _automations


# --- the plugin's feed ------------------------------------------------------------
platform_router = APIRouter(
    prefix="/api/platform/hub/automations",
    tags=["hub-platform"],
    dependencies=[Depends(_platform_key_dep)],
)


class SyncJob(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    name: str | None = None
    schedule: str | None = None
    deliver: str | None = None
    state: str | None = None
    mode: Literal["agent", "script"] | None = None
    next_run_at: str | None = None
    last_status: str | None = None
    last_error: str | None = None
    origin: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _bounds(self) -> "SyncJob":
        if not valid_job_id(self.id):
            raise ValueError("malformed job id")
        self.name = _clean(self.name) if self.name else self.name
        self.last_error = _clean(self.last_error) if self.last_error else self.last_error
        return self


_RUN_TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def _clean(text: str) -> str:
    """Lone surrogates (a jobs.json escape can carry one) cannot be stored."""
    return text.encode("utf-8", "replace").decode("utf-8")


class SyncRun(BaseModel):
    model_config = ConfigDict(extra="ignore")

    run_id: str
    job_id: str
    job_name: str | None = None
    run_time: str
    status: Literal["ok", "silent", "failed"] = "ok"
    output: str = ""
    truncated: bool = False

    @model_validator(mode="after")
    def _bounds(self) -> "SyncRun":
        if not valid_run_id(self.run_id) or job_of(self.run_id) != self.job_id:
            raise ValueError("run_id must be '<job_id>:<stem>'")
        if not _RUN_TIME_RE.match(self.run_time):
            raise ValueError("run_time must be UTC ISO, YYYY-MM-DDTHH:MM:SSZ")
        self.output = _clean(self.output)
        self.job_name = _clean(self.job_name) if self.job_name else self.job_name
        return self


class SyncRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    jobs: list[SyncJob] = []
    # The whole schedule, so a job absent from `jobs` has been removed.
    jobs_complete: bool = False
    runs: list[SyncRun] = []

    @model_validator(mode="after")
    def _bounds(self) -> "SyncRequest":
        if len(self.jobs) > MAX_SYNC_JOBS:
            raise ValueError(f"over {MAX_SYNC_JOBS} jobs")
        if len(self.runs) > MAX_SYNC_RUNS:
            raise ValueError(f"over {MAX_SYNC_RUNS} runs")
        return self


@platform_router.post("/sync")
def automations_sync(req: SyncRequest) -> dict[str, Any]:
    autos = get_automations()
    jobs = autos.upsert_jobs([j.model_dump() for j in req.jobs], complete=req.jobs_complete)
    touched = autos.upsert_runs([r.model_dump() for r in req.runs], source="file")
    if req.jobs_complete:
        autos.prune()
    return {"status": "ok", "jobs": jobs, "runs": len(req.runs), "jobs_touched": touched}


@platform_router.post("/baseline")
def automations_baseline() -> dict[str, Any]:
    """One-time, at cutover, after the first sync has landed: mark what is
    already on file as read, leaving only the findings still standing."""
    return {"status": "ok", **get_automations().baseline()}


class BackfillRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dry_run: bool = True


@platform_router.post("/backfill")
def automations_backfill(req: BackfillRequest) -> dict[str, Any]:
    """One-time: file the deliveries already stored in the catch-all threads under
    their jobs. Dry by default, and safe to repeat — a row once filed is no
    longer a candidate."""
    return get_automations().backfill_deliveries(dry_run=req.dry_run)


# --- the phone ----------------------------------------------------------------------
router = APIRouter(
    prefix="/api/chat/automations",
    tags=["hub-automations"],
    dependencies=[Depends(_chat_session_dep)],
)


def _not_found(what: str) -> HTTPException:
    return HTTPException(status_code=404, detail={"code": "not_found", "detail": f"no such {what}"})


@router.get("")
def automations_list() -> dict[str, Any]:
    return get_automations().list_jobs()


@router.get("/timeline")
def automations_timeline(days: int = 7, before: str | None = None) -> dict[str, Any]:
    if before is not None and not _is_day(before):
        raise HTTPException(status_code=400, detail={"code": "bad_request", "detail": "before must be YYYY-MM-DD"})
    return get_automations().timeline(days=min(max(days, 1), 31), before=before)


def _is_day(value: str) -> bool:
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return False
    return True


@router.get("/jobs/{job_id}")
def automations_job(job_id: str) -> dict[str, Any]:
    autos = get_automations()
    job = autos.job_summary(job_id) if valid_job_id(job_id) else None
    if job is None:
        raise _not_found("automation")
    return {"job": job, "items": autos.job_items(job_id)}


class PrefsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    notify: Literal["push", "quiet", "muted"] | None = None
    snooze_hours: int | None = None
    clear_snooze: bool = False

    @model_validator(mode="after")
    def _bounds(self) -> "PrefsRequest":
        if self.notify is None and self.snooze_hours is None and not self.clear_snooze:
            raise ValueError("nothing to change")
        if self.snooze_hours is not None and not 1 <= self.snooze_hours <= MAX_SNOOZE_HOURS:
            raise ValueError(f"snooze_hours must be 1..{MAX_SNOOZE_HOURS}")
        return self


@router.post("/jobs/{job_id}/prefs")
def automations_prefs(job_id: str, req: PrefsRequest) -> dict[str, Any]:
    assert req.notify is None or req.notify in NOTIFY_MODES
    job = (
        get_automations().set_prefs(
            job_id, notify=req.notify, snooze_hours=req.snooze_hours, clear_snooze=req.clear_snooze
        )
        if valid_job_id(job_id)
        else None
    )
    if job is None:
        raise _not_found("automation")
    return {"job": job}


@router.post("/jobs/{job_id}/read")
def automations_job_read(job_id: str) -> dict[str, Any]:
    autos = get_automations()
    if not valid_job_id(job_id) or autos.get_job(job_id) is None:
        raise _not_found("automation")
    autos.mark_read(job_id)
    return {"job": autos.job_summary(job_id)}


@router.post("/read-all")
def automations_read_all() -> dict[str, Any]:
    autos = get_automations()
    cleared = autos.mark_all_read()
    return {"cleared": cleared, "counts": autos.list_jobs()["counts"]}


# The tab's badge: a count and nothing else, on the same footing as /api/feed —
# tailnet-only, no cookie — so the number is right while the session is locked.
badge_router = APIRouter(prefix="/api/automations", tags=["hub-automations"])


@badge_router.get("/badge")
def automations_badge() -> dict[str, int]:
    return get_automations().badge()


@router.post("/runs/{run_id}/open")
def automations_run_open(run_id: str) -> dict[str, Any]:
    """Opening a run reads it, and makes sure the thread under it exists — so the
    screen that shows a run is always a thread screen, with or without replies."""
    autos = get_automations()
    run = autos.get_run(run_id) if valid_run_id(run_id) else None
    if run is None:
        raise _not_found("run")
    autos.mark_read(run["job_id"], through=run["run_time"])
    thread = autos.open_followup(run_id)
    job = autos.get_job(run["job_id"])
    with autos._lock:
        summary = autos._run_summary(run, job)  # type: ignore[arg-type]
    return {
        "run": {
            **summary,
            "output": run["output"],
            "truncated": bool(run["truncated"]),
            "parts": autos.run_parts(run),
        },
        "job": autos.job_summary(run["job_id"]),
        "thread": _thread_payload(thread, thread["last_read_seq"], thread["unread"]),  # type: ignore[index]
    }
