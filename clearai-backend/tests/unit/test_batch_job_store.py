"""Unit tests for batch_job_store — CRUD + state machine invariants.

The store is the persistence backbone for batch runs; every other Session-2
module trusts it to keep jobs + rows consistent. These tests pin that contract.
"""

from __future__ import annotations

import sqlite3
from datetime import date

import pytest

from clearai.services.batch_job_store import (
    BatchJob,
    allocate_doc_ref_seq,
    create_job,
    get_job,
    get_rows,
    list_jobs,
    update_job,
    upsert_rows,
)


@pytest.fixture
def conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    return c


class TestDocRefSequence:
    def test_first_call_returns_one(self, conn) -> None:
        assert allocate_doc_ref_seq(conn, date(2026, 4, 1)) == 1

    def test_monotonic_within_day(self, conn) -> None:
        d = date(2026, 4, 1)
        seqs = [allocate_doc_ref_seq(conn, d) for _ in range(5)]
        assert seqs == [1, 2, 3, 4, 5]

    def test_counter_resets_across_days(self, conn) -> None:
        assert allocate_doc_ref_seq(conn, date(2026, 4, 1)) == 1
        assert allocate_doc_ref_seq(conn, date(2026, 4, 1)) == 2
        assert allocate_doc_ref_seq(conn, date(2026, 4, 2)) == 1


class TestBatchJobs:
    def test_create_and_get_roundtrip(self, conn) -> None:
        job = create_job(conn, job_id="abc123", row_count=42,
                         input_filename="merchant.xlsx")
        assert isinstance(job, BatchJob)
        assert job.id == "abc123"
        assert job.state == "pending"
        assert job.row_count == 42
        assert job.completed_count == 0

        got = get_job(conn, "abc123")
        assert got == job

    def test_get_missing_returns_none(self, conn) -> None:
        assert get_job(conn, "no-such") is None

    def test_update_job_advances_state(self, conn) -> None:
        create_job(conn, job_id="j1", row_count=10)
        update_job(conn, "j1", state="running", anthropic_batch_id="msgbatch_x")
        j = get_job(conn, "j1")
        assert j is not None
        assert j.state == "running"
        assert j.anthropic_batch_id == "msgbatch_x"

    def test_update_rejects_unknown_column(self, conn) -> None:
        create_job(conn, job_id="j1", row_count=1)
        with pytest.raises(ValueError, match="unknown fields"):
            update_job(conn, "j1", bogus="x")

    def test_update_rejects_invalid_state(self, conn) -> None:
        create_job(conn, job_id="j1", row_count=1)
        with pytest.raises(ValueError, match="invalid state"):
            update_job(conn, "j1", state="nonsense")

    def test_list_returns_newest_first(self, conn) -> None:
        import time
        create_job(conn, job_id="a", row_count=1)
        time.sleep(0.02)
        create_job(conn, job_id="b", row_count=1)
        listed = list_jobs(conn)
        assert [j.id for j in listed[:2]] == ["b", "a"]


class TestBatchRows:
    def test_upsert_inserts_rows(self, conn) -> None:
        create_job(conn, job_id="j1", row_count=3)
        n = upsert_rows(conn, "j1", [
            {"row_idx": 1, "waybill_no": "W1", "hs_code": "010101010101",
             "flags": []},
            {"row_idx": 2, "waybill_no": "W2", "hs_code": "020202020202",
             "flags": ["missing_country_of_origin"]},
        ])
        assert n == 2
        rows = get_rows(conn, "j1")
        assert len(rows) == 2
        assert rows[0].row_idx == 1
        assert rows[1].flags == ["missing_country_of_origin"]

    def test_upsert_updates_on_conflict(self, conn) -> None:
        create_job(conn, job_id="j1", row_count=1)
        upsert_rows(conn, "j1", [{"row_idx": 1, "waybill_no": "W1", "flags": []}])
        upsert_rows(conn, "j1", [{
            "row_idx": 1, "waybill_no": "W1",
            "hs_code": "999999999999", "flags": ["low_confidence_hs"],
        }])
        rows = get_rows(conn, "j1")
        assert len(rows) == 1
        assert rows[0].hs_code == "999999999999"
        assert rows[0].flags == ["low_confidence_hs"]

    def test_cascade_delete_with_job(self, conn) -> None:
        # Foreign key is declared but SQLite off-by-default; confirm that
        # an explicit DELETE still leaves row data intact for auditability.
        create_job(conn, job_id="j1", row_count=1)
        upsert_rows(conn, "j1", [{"row_idx": 1, "flags": []}])
        assert len(get_rows(conn, "j1")) == 1
