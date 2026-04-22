"""Batch XML endpoints.

Flow:

    POST /api/batch/upload   → ingest Excel/CSV, returns { job_id, row_count }
    POST /api/batch/{id}/run → submit to Anthropic Batches API + kick off
                               a background poll-and-finalize task
    GET  /api/batch/{id}     → current job status + per-row summary
    GET  /api/batch/{id}/download → stream the finalised ZIP

Each handler takes its own short-lived sqlite3 connection. Sharing the
resolver's conn across FastAPI requests would deadlock at 1000 rows because
SQLite's check_same_thread=False still serialises writes.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from clearai import config
from clearai.adapters.anthropic_batches import MAX_BATCH_ROWS, AnthropicBatches
from clearai.services import batch_orchestrator as orch
from clearai.services.batch_job_store import (
    BatchJob, get_job, get_rows, list_jobs, update_job,
)

logger = logging.getLogger("clearai.api.batch")

router = APIRouter(prefix="/api/batch", tags=["batch"])


# ---------------------------------------------------------------------------
# Schemas — kept local; they're batch-specific, no point polluting schemas.py
# ---------------------------------------------------------------------------
class UploadResponse(BaseModel):
    job_id: str
    row_count: int
    input_filename: str


class RunResponse(BaseModel):
    job_id: str
    anthropic_batch_id: str
    state: str


class RowSummary(BaseModel):
    row_idx: int
    waybill_no: str | None
    hs_code: str | None
    country_of_origin: str | None
    flags: list[str]
    xml_filename: str | None
    error: str | None


class StatusResponse(BaseModel):
    job_id: str
    state: str
    row_count: int
    completed_count: int
    flagged_count: int
    anthropic_batch_id: str | None
    created_at: str
    updated_at: str
    input_filename: str | None
    output_zip_available: bool
    error: str | None
    rows: list[RowSummary] = Field(default_factory=list)


class JobListItem(BaseModel):
    job_id: str
    state: str
    row_count: int
    completed_count: int
    flagged_count: int
    created_at: str


class JobListResponse(BaseModel):
    jobs: list[JobListItem]


# ---------------------------------------------------------------------------
# Connection helper — one per request so we don't fight the resolver's conn
# ---------------------------------------------------------------------------
def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(str(config.DB_PATH))
    c.row_factory = sqlite3.Row
    return c


def _to_row_summary(r: Any) -> RowSummary:
    return RowSummary(
        row_idx=r.row_idx, waybill_no=r.waybill_no, hs_code=r.hs_code,
        country_of_origin=r.country_of_origin, flags=r.flags,
        xml_filename=r.xml_filename, error=r.error,
    )


def _to_status(job: BatchJob, rows: list[Any]) -> StatusResponse:
    return StatusResponse(
        job_id=job.id,
        state=job.state,
        row_count=job.row_count,
        completed_count=job.completed_count,
        flagged_count=job.flagged_count,
        anthropic_batch_id=job.anthropic_batch_id,
        created_at=job.created_at,
        updated_at=job.updated_at,
        input_filename=job.input_filename,
        output_zip_available=bool(job.output_zip_path),
        error=job.error,
        rows=[_to_row_summary(r) for r in rows],
    )


# ---------------------------------------------------------------------------
# POST /api/batch/upload
# ---------------------------------------------------------------------------
@router.post("/upload", response_model=UploadResponse)
async def upload(file: UploadFile = File(...)) -> UploadResponse:
    """Ingest an Excel/CSV and return a job id. Does NOT submit to Anthropic —
    the UI calls /run once the merchant previews the parsed rows."""
    if not file.filename:
        raise HTTPException(400, "file must have a filename")
    suffix = Path(file.filename).suffix.lower()
    if suffix not in {".xlsx", ".xls", ".csv"}:
        raise HTTPException(400, f"unsupported format {suffix!r}; expected .xlsx/.csv")

    data = await file.read()
    if not data:
        raise HTTPException(400, "file is empty")

    job_id = secrets.token_hex(8)
    conn = _conn()
    try:
        row_count = orch.ingest(
            conn, job_id=job_id, input_bytes=data, input_filename=file.filename,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        conn.close()

    # The batch lane currently runs sync calls in a loop (Foundry doesn't
    # forward the async Batches API). Reject over-cap uploads up front so
    # the user sees a friendly 400 instead of a 500 from submit().
    if row_count > MAX_BATCH_ROWS:
        raise HTTPException(
            400,
            f"file has {row_count} rows; batch lane is currently capped at "
            f"{MAX_BATCH_ROWS}. Split the upload or use the single-item tab.",
        )

    return UploadResponse(
        job_id=job_id, row_count=row_count, input_filename=file.filename,
    )


# ---------------------------------------------------------------------------
# POST /api/batch/{job_id}/run
# ---------------------------------------------------------------------------
@router.post("/{job_id}/run", response_model=RunResponse)
def run(job_id: str, background_tasks: BackgroundTasks) -> RunResponse:
    conn = _conn()
    try:
        job = get_job(conn, job_id)
        if job is None:
            raise HTTPException(404, f"job {job_id} not found")
        if job.state != "pending":
            raise HTTPException(
                409, f"job state must be 'pending', got {job.state!r}"
            )
        anthropic_id = orch.submit(conn, job_id=job_id)
    finally:
        conn.close()

    background_tasks.add_task(_poll_and_finalize, job_id)
    return RunResponse(
        job_id=job_id, anthropic_batch_id=anthropic_id, state="running",
    )


# ---------------------------------------------------------------------------
# GET /api/batch/{job_id}
# ---------------------------------------------------------------------------
@router.get("/{job_id}", response_model=StatusResponse)
def status(job_id: str) -> StatusResponse:
    conn = _conn()
    try:
        job = get_job(conn, job_id)
        if job is None:
            raise HTTPException(404, f"job {job_id} not found")
        rows = get_rows(conn, job_id)
    finally:
        conn.close()
    return _to_status(job, rows)


# ---------------------------------------------------------------------------
# GET /api/batch  — operator dashboard list
# ---------------------------------------------------------------------------
@router.get("", response_model=JobListResponse)
def jobs(limit: int = 50) -> JobListResponse:
    conn = _conn()
    try:
        items = list_jobs(conn, limit=limit)
    finally:
        conn.close()
    return JobListResponse(jobs=[
        JobListItem(
            job_id=j.id, state=j.state, row_count=j.row_count,
            completed_count=j.completed_count,
            flagged_count=j.flagged_count, created_at=j.created_at,
        )
        for j in items
    ])


# ---------------------------------------------------------------------------
# GET /api/batch/{job_id}/download
# ---------------------------------------------------------------------------
@router.get("/{job_id}/download")
def download(job_id: str) -> FileResponse:
    conn = _conn()
    try:
        job = get_job(conn, job_id)
    finally:
        conn.close()
    if job is None:
        raise HTTPException(404, f"job {job_id} not found")
    if not job.output_zip_path:
        raise HTTPException(409, f"job {job_id} has no ZIP yet (state={job.state})")
    path = Path(job.output_zip_path)
    if not path.exists():
        raise HTTPException(500, f"ZIP missing on disk: {path}")
    return FileResponse(
        path=path, filename=path.name, media_type="application/zip",
    )


# ---------------------------------------------------------------------------
# Background: poll Anthropic, finalize when done
# ---------------------------------------------------------------------------
def _poll_and_finalize(job_id: str, *, poll_interval_s: float = 30.0) -> None:
    """Block-poll the Anthropic batch and call finalize() once it ends.

    Runs inside a FastAPI BackgroundTasks thread. On any exception we flip
    the job to `failed` so the UI can surface the error. In dry-run mode
    the status endpoint returns `ended` immediately, so this finishes in
    one iteration.
    """
    client = AnthropicBatches()
    conn = _conn()
    try:
        while True:
            job = get_job(conn, job_id)
            if job is None or job.state == "failed":
                return
            if not job.anthropic_batch_id:
                update_job(conn, job_id, state="failed",
                           error="no anthropic_batch_id on poll")
                return
            st = client.status(job.anthropic_batch_id)
            if st.processing_status == "ended":
                orch.finalize(conn, job_id=job_id, batches_client=client)
                return
            time.sleep(poll_interval_s)
    except Exception as e:  # noqa: BLE001
        logger.exception("poll_and_finalize failed for job=%s", job_id)
        try:
            update_job(conn, job_id, state="failed", error=str(e))
        except Exception:  # noqa: BLE001
            pass
    finally:
        conn.close()
