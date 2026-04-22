"""
batch_job_store.py — persistent state for batch runs + docRefNo sequencing.

Two tables, one responsibility each:

  doc_ref_sequence — daily monotonic counter for NQD{YY}{MM}{DD}{nnnnn} IDs.
  batch_jobs        — one row per merchant upload. Tracks Batches-API state.
  batch_rows        — one row per Excel line. Stores its resolved hs_code,
                      Arabic text, review flags, and XML filename.

Why SQLite and not a full Postgres: Session-1 spec says offline / single-
operator. A file-based store keeps the ops surface tiny and the review queue
co-located with the XMLs.

Concurrency: every write is wrapped in `with conn:` which issues an IMMEDIATE
transaction. Two concurrent batch runs won't double-issue the same daily
sequence number.

States for `batch_jobs.state`:
  - pending       — uploaded, not yet submitted to Anthropic
  - submitting    — orchestrator is packaging requests
  - running       — Anthropic Batches API in-progress
  - finalizing    — results arrived, building XMLs + review.csv
  - done          — ZIP ready for download
  - failed        — uncaught error; `error` column holds the trace
"""

from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any, Iterable

logger = logging.getLogger("clearai.batch_job_store")


# ---------------------------------------------------------------------------
# Schema — created on demand; idempotent.
# ---------------------------------------------------------------------------
_SCHEMA = """
CREATE TABLE IF NOT EXISTS doc_ref_sequence (
    day TEXT PRIMARY KEY,      -- ISO date YYYY-MM-DD
    last_seq INTEGER NOT NULL  -- highest allocated sequence for the day
);

CREATE TABLE IF NOT EXISTS batch_jobs (
    id TEXT PRIMARY KEY,               -- internal batch id (hex token)
    anthropic_batch_id TEXT,           -- set when /run submits to Batches API
    state TEXT NOT NULL,               -- see states list in module docstring
    row_count INTEGER NOT NULL,
    completed_count INTEGER NOT NULL DEFAULT 0,
    flagged_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    input_filename TEXT,               -- original Excel name for ops
    output_zip_path TEXT,              -- absolute path once built
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_batch_jobs_state ON batch_jobs(state);

CREATE TABLE IF NOT EXISTS batch_rows (
    job_id TEXT NOT NULL,
    row_idx INTEGER NOT NULL,          -- 1-based as seen in the Excel
    waybill_no TEXT,
    hs_code TEXT,
    arabic_description TEXT,
    country_of_origin TEXT,
    flags_json TEXT NOT NULL DEFAULT '[]',
    xml_filename TEXT,
    error TEXT,
    PRIMARY KEY (job_id, row_idx),
    FOREIGN KEY (job_id) REFERENCES batch_jobs(id) ON DELETE CASCADE
);
"""


def ensure_schema(conn: sqlite3.Connection) -> None:
    """Create batch tables if they don't exist. Safe to call repeatedly.

    Also performs additive column migrations for tables created by earlier
    sessions — `CREATE TABLE IF NOT EXISTS` won't alter an existing table,
    so we ADD COLUMN any missing field introduced in Session 2.
    """
    with conn:
        conn.executescript(_SCHEMA)
        # Migration: Session 1 shipped a `batch_jobs` scaffold without
        # `flagged_count` / `input_filename` / `output_zip_path`. Add them
        # if the existing row is the older shape.
        cur = conn.execute("PRAGMA table_info(batch_jobs)")
        existing_cols = {r[1] for r in cur.fetchall()}
        added = {
            "flagged_count": "INTEGER NOT NULL DEFAULT 0",
            "input_filename": "TEXT",
            "output_zip_path": "TEXT",
        }
        for col, decl in added.items():
            if col not in existing_cols:
                conn.execute(f"ALTER TABLE batch_jobs ADD COLUMN {col} {decl}")


# ---------------------------------------------------------------------------
# docRefNo sequence allocation
# ---------------------------------------------------------------------------
def allocate_doc_ref_seq(conn: sqlite3.Connection, today: date) -> int:
    """Return the next unused daily sequence number, atomically.

    First call of the day → 1. Subsequent calls → strictly increasing.
    Crosses midnight cleanly — day N+1's counter restarts at 1.
    """
    ensure_schema(conn)
    key = today.isoformat()
    with conn:
        cur = conn.execute(
            "SELECT last_seq FROM doc_ref_sequence WHERE day = ?", (key,)
        )
        row = cur.fetchone()
        next_seq = 1 if row is None else row[0] + 1
        if row is None:
            conn.execute(
                "INSERT INTO doc_ref_sequence(day, last_seq) VALUES (?, ?)",
                (key, next_seq),
            )
        else:
            conn.execute(
                "UPDATE doc_ref_sequence SET last_seq = ? WHERE day = ?",
                (next_seq, key),
            )
    return next_seq


# ---------------------------------------------------------------------------
# batch_jobs CRUD
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class BatchJob:
    id: str
    anthropic_batch_id: str | None
    state: str
    row_count: int
    completed_count: int
    flagged_count: int
    created_at: str
    updated_at: str
    input_filename: str | None
    output_zip_path: str | None
    error: str | None


VALID_STATES = {
    "pending", "submitting", "running", "finalizing", "done", "failed",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def create_job(
    conn: sqlite3.Connection,
    *,
    job_id: str,
    row_count: int,
    input_filename: str | None = None,
) -> BatchJob:
    ensure_schema(conn)
    now = _now_iso()
    with conn:
        conn.execute(
            """
            INSERT INTO batch_jobs
              (id, anthropic_batch_id, state, row_count, completed_count,
               flagged_count, created_at, updated_at, input_filename,
               output_zip_path, error)
            VALUES (?, NULL, 'pending', ?, 0, 0, ?, ?, ?, NULL, NULL)
            """,
            (job_id, row_count, now, now, input_filename),
        )
    got = get_job(conn, job_id)
    assert got is not None
    return got


def get_job(conn: sqlite3.Connection, job_id: str) -> BatchJob | None:
    ensure_schema(conn)
    cur = conn.execute("SELECT * FROM batch_jobs WHERE id = ?", (job_id,))
    row = cur.fetchone()
    if row is None:
        return None
    return _row_to_job(row)


def list_jobs(conn: sqlite3.Connection, limit: int = 50) -> list[BatchJob]:
    ensure_schema(conn)
    # Stable tiebreak on id — created_at is second-precision, so two jobs
    # created in the same second would order unpredictably otherwise.
    cur = conn.execute(
        "SELECT * FROM batch_jobs ORDER BY created_at DESC, id DESC LIMIT ?",
        (limit,),
    )
    return [_row_to_job(r) for r in cur.fetchall()]


def update_job(
    conn: sqlite3.Connection,
    job_id: str,
    **fields: Any,
) -> None:
    """Partial update. Whitelist of updatable columns to prevent typos from
    silently corrupting state."""
    allowed = {
        "anthropic_batch_id", "state", "completed_count", "flagged_count",
        "output_zip_path", "error",
    }
    bad = set(fields) - allowed
    if bad:
        raise ValueError(f"update_job: unknown fields {bad}")
    if "state" in fields and fields["state"] not in VALID_STATES:
        raise ValueError(f"update_job: invalid state {fields['state']!r}")
    if not fields:
        return
    assignments = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [_now_iso(), job_id]
    with conn:
        conn.execute(
            f"UPDATE batch_jobs SET {assignments}, updated_at = ? WHERE id = ?",
            values,
        )


_JOB_FIELDS = {
    "id", "anthropic_batch_id", "state", "row_count", "completed_count",
    "flagged_count", "created_at", "updated_at", "input_filename",
    "output_zip_path", "error",
}


def _row_to_job(row: sqlite3.Row | tuple) -> BatchJob:
    # Support both default-tuple and Row factory clients.
    if isinstance(row, sqlite3.Row):
        d = {k: row[k] for k in row.keys()}
    else:
        cols = [
            "id", "anthropic_batch_id", "state", "row_count", "completed_count",
            "flagged_count", "created_at", "updated_at", "input_filename",
            "output_zip_path", "error",
        ]
        d = dict(zip(cols, row))
    # Drop legacy columns from older schemas (e.g. `header_fields_json`
    # from the Session-1 reserve schema) so BatchJob(**d) stays strict.
    d = {k: v for k, v in d.items() if k in _JOB_FIELDS}
    return BatchJob(**d)


# ---------------------------------------------------------------------------
# batch_rows CRUD
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class BatchRow:
    job_id: str
    row_idx: int
    waybill_no: str | None
    hs_code: str | None
    arabic_description: str | None
    country_of_origin: str | None
    flags: list[str]
    xml_filename: str | None
    error: str | None


def upsert_rows(
    conn: sqlite3.Connection,
    job_id: str,
    rows: Iterable[dict[str, Any]],
) -> int:
    """Bulk upsert rows for a job. Each dict needs at minimum `row_idx`.

    Returns the number of rows written.
    """
    ensure_schema(conn)
    count = 0
    with conn:
        for r in rows:
            flags_json = json.dumps(r.get("flags", []), ensure_ascii=False)
            conn.execute(
                """
                INSERT INTO batch_rows
                  (job_id, row_idx, waybill_no, hs_code, arabic_description,
                   country_of_origin, flags_json, xml_filename, error)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(job_id, row_idx) DO UPDATE SET
                  waybill_no = excluded.waybill_no,
                  hs_code = excluded.hs_code,
                  arabic_description = excluded.arabic_description,
                  country_of_origin = excluded.country_of_origin,
                  flags_json = excluded.flags_json,
                  xml_filename = excluded.xml_filename,
                  error = excluded.error
                """,
                (
                    job_id, r["row_idx"], r.get("waybill_no"), r.get("hs_code"),
                    r.get("arabic_description"), r.get("country_of_origin"),
                    flags_json, r.get("xml_filename"), r.get("error"),
                ),
            )
            count += 1
    return count


def get_rows(conn: sqlite3.Connection, job_id: str) -> list[BatchRow]:
    ensure_schema(conn)
    cur = conn.execute(
        "SELECT * FROM batch_rows WHERE job_id = ? ORDER BY row_idx",
        (job_id,),
    )
    out: list[BatchRow] = []
    for row in cur.fetchall():
        if isinstance(row, sqlite3.Row):
            d = {k: row[k] for k in row.keys()}
        else:
            cols = [
                "job_id", "row_idx", "waybill_no", "hs_code",
                "arabic_description", "country_of_origin", "flags_json",
                "xml_filename", "error",
            ]
            d = dict(zip(cols, row))
        flags = json.loads(d.pop("flags_json") or "[]")
        out.append(BatchRow(flags=flags, **d))
    return out
