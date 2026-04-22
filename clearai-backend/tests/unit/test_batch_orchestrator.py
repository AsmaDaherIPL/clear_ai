"""Integration tests for batch_orchestrator — end-to-end with a stub Batches
client. Real API calls are skipped; we verify the wiring (Excel → requests →
XMLs + review.csv + ZIP) works identically to the CLI path.
"""

from __future__ import annotations

import io
import json
import sqlite3
import zipfile
from datetime import date
from pathlib import Path

import pandas as pd
import pytest

from clearai.adapters.anthropic_batches import (
    AnthropicBatches, BatchRequest, BatchResultItem, BatchStatus,
)
from clearai.services import batch_orchestrator as orch
from clearai.services.batch_job_store import get_job, get_rows


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture
def conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    return c


@pytest.fixture
def sample_xlsx_bytes() -> bytes:
    """Two-row fixture mirroring the real pre-processed schema."""
    df = pd.DataFrame([
        {
            "WaybillNo": "279274301", "weight": "0.35", "ClientID": "9019628",
            "CurrencyID": "2", "declaredValue": "3426.35",
            "DestinationStationID": "501", "Mobile": "+966500000001",
            "PhoneNumber": "", "ConsigneeName": "TEST ONE",
            "ConsigneeNationalID": "2000000001", "Quantity": "1",
            "UnitType": "Piece", "CountryofManufacture": "US",
            "Description": "Cotton t-shirt", "CustomsCommodityCode": "61091000",
            "UnitCost": "3500", "Amount": "3426.35", "Currency": "AED",
            "ChineseDescription": "", "SKU": "SKU1", "CPC": "",
            "ItemWeightValue": "0.35", "ItemWeightUnit": "KG",
        },
        {
            # Row with blanked country to exercise the policy flag.
            "WaybillNo": "394613346", "weight": "1.2", "ClientID": "9022381",
            "CurrencyID": "1", "declaredValue": "450",
            "DestinationStationID": "503", "Mobile": "",
            "PhoneNumber": "+966500000002", "ConsigneeName": "TEST TWO",
            "ConsigneeNationalID": "1000000002", "Quantity": "2",
            "UnitType": "", "CountryofManufacture": "",
            "Description": "Silk scarf", "CustomsCommodityCode": "62142000",
            "UnitCost": "250", "Amount": "450", "Currency": "SAR",
            "ChineseDescription": "", "SKU": "SKU2", "CPC": "",
            "ItemWeightValue": "", "ItemWeightUnit": "",
        },
    ])
    buf = io.BytesIO()
    df.to_excel(buf, index=False)
    return buf.getvalue()


@pytest.fixture
def batch_root(tmp_path, monkeypatch) -> Path:
    """Redirect BATCH_ROOT to a temp dir so tests are hermetic."""
    root = tmp_path / "batches"
    root.mkdir()
    monkeypatch.setattr(orch, "BATCH_ROOT", root)
    return root


# ---------------------------------------------------------------------------
# Stub Batches client — one that does nothing real but mimics the shape
# ---------------------------------------------------------------------------
class StubBatches:
    """In-memory stand-in for AnthropicBatches. Lets tests inject any result
    shape without monkey-patching the Anthropic SDK."""

    def __init__(self, canned_results: dict[str, BatchResultItem]) -> None:
        self._canned = canned_results
        self.submitted: list[BatchRequest] = []
        self._batch_id = "msgbatch_stub"

    def submit(self, requests):
        self.submitted = list(requests)
        return self._batch_id

    def status(self, batch_id):
        assert batch_id == self._batch_id
        return BatchStatus(
            id=batch_id, processing_status="ended",
            request_counts={"succeeded": len(self._canned)},
            ended_at="2026-04-21T00:00:00Z", results_url="file://stub",
        )

    def fetch_results(self, batch_id):
        assert batch_id == self._batch_id
        for v in self._canned.values():
            yield v


def _good_result(custom_id: str, hs: str = "611030000000",
                 arabic: str = "قميص قطني", conf: float = 0.9) -> BatchResultItem:
    payload = {"hs_code": hs, "arabic_description": arabic,
               "confidence": conf, "rationale": "stub"}
    return BatchResultItem(
        custom_id=custom_id, text=json.dumps(payload, ensure_ascii=False),
        stop_reason="end_turn", tokens_in=10, tokens_out=20, error=None,
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
class TestIngest:
    def test_two_rows_persisted(self, conn, sample_xlsx_bytes, batch_root) -> None:
        n = orch.ingest(conn, job_id="job1", input_bytes=sample_xlsx_bytes,
                        input_filename="merchant.xlsx")
        assert n == 2
        job = get_job(conn, "job1")
        assert job is not None
        assert job.state == "pending"
        assert job.row_count == 2
        rows = get_rows(conn, "job1")
        assert rows[0].waybill_no == "279274301"
        assert rows[1].flags == ["missing_country_of_origin"]

    def test_rejects_empty(self, conn, batch_root) -> None:
        empty = io.BytesIO()
        pd.DataFrame().to_excel(empty, index=False)
        with pytest.raises(ValueError, match="zero rows"):
            orch.ingest(conn, job_id="j", input_bytes=empty.getvalue(),
                        input_filename="empty.xlsx")

    def test_rejects_bad_format(self, conn, batch_root) -> None:
        with pytest.raises(ValueError, match="unsupported"):
            orch.ingest(conn, job_id="j", input_bytes=b"x",
                        input_filename="foo.pdf")


class TestSubmit:
    def test_builds_one_request_per_row(self, conn, sample_xlsx_bytes, batch_root) -> None:
        orch.ingest(conn, job_id="j1", input_bytes=sample_xlsx_bytes,
                    input_filename="m.xlsx")
        stub = StubBatches({})
        anthropic_id = orch.submit(conn, job_id="j1", batches_client=stub)
        assert anthropic_id == "msgbatch_stub"
        assert len(stub.submitted) == 2
        assert {r.custom_id for r in stub.submitted} == {"row-1", "row-2"}
        # Verify model + messages shape was assembled.
        first = stub.submitted[0]
        assert "messages" in first.params
        assert first.params["temperature"] == 0

        job = get_job(conn, "j1")
        assert job.state == "running"
        assert job.anthropic_batch_id == "msgbatch_stub"

    def test_submit_requires_pending_state(self, conn, sample_xlsx_bytes, batch_root) -> None:
        orch.ingest(conn, job_id="j1", input_bytes=sample_xlsx_bytes,
                    input_filename="m.xlsx")
        orch.submit(conn, job_id="j1", batches_client=StubBatches({}))
        with pytest.raises(ValueError, match="pending"):
            orch.submit(conn, job_id="j1", batches_client=StubBatches({}))


class TestFinalize:
    def test_end_to_end_two_rows(self, conn, sample_xlsx_bytes, batch_root) -> None:
        orch.ingest(conn, job_id="j1", input_bytes=sample_xlsx_bytes,
                    input_filename="m.xlsx")
        stub = StubBatches({
            "row-1": _good_result("row-1", hs="610910000000",
                                  arabic="تي شيرت قطني"),
            "row-2": _good_result("row-2", hs="621420000000",
                                  arabic="وشاح حريري", conf=0.3),  # low-conf → flag
        })
        orch.submit(conn, job_id="j1", batches_client=stub)

        zip_path = orch.finalize(conn, job_id="j1", batches_client=stub,
                                 today=date(2026, 4, 21))

        # Job state
        job = get_job(conn, "j1")
        assert job.state == "done"
        assert job.completed_count == 2
        # Row 1 is clean; row 2 has both low-conf + missing-country.
        # flagged_count counts rows with >= 1 flag → 1.
        assert job.flagged_count == 1
        assert zip_path.exists()

    def test_flagged_count_only_counts_rows_with_flags(
        self, conn, sample_xlsx_bytes, batch_root,
    ) -> None:
        orch.ingest(conn, job_id="j1", input_bytes=sample_xlsx_bytes,
                    input_filename="m.xlsx")
        stub = StubBatches({
            "row-1": _good_result("row-1"),               # clean
            "row-2": _good_result("row-2", conf=0.3),     # low-conf + missing country
        })
        orch.submit(conn, job_id="j1", batches_client=stub)
        orch.finalize(conn, job_id="j1", batches_client=stub,
                      today=date(2026, 4, 21))
        job = get_job(conn, "j1")
        assert job.flagged_count == 1
        rows = get_rows(conn, "j1")
        assert rows[0].flags == []
        # Row 2 accumulates both flags:
        assert "low_confidence_hs" in rows[1].flags
        assert "missing_country_of_origin" in rows[1].flags

    def test_zip_contents(self, conn, sample_xlsx_bytes, batch_root) -> None:
        orch.ingest(conn, job_id="j1", input_bytes=sample_xlsx_bytes,
                    input_filename="m.xlsx")
        stub = StubBatches({
            "row-1": _good_result("row-1"),
            "row-2": _good_result("row-2"),
        })
        orch.submit(conn, job_id="j1", batches_client=stub)
        zip_path = orch.finalize(conn, job_id="j1", batches_client=stub,
                                 today=date(2026, 4, 21))

        with zipfile.ZipFile(zip_path) as zf:
            names = zf.namelist()
        xml_entries = [n for n in names if n.endswith(".XML")]
        assert len(xml_entries) == 2
        assert "review.csv" in names

    def test_resolver_failed_flagged(self, conn, sample_xlsx_bytes, batch_root) -> None:
        orch.ingest(conn, job_id="j1", input_bytes=sample_xlsx_bytes,
                    input_filename="m.xlsx")
        stub = StubBatches({
            "row-1": _good_result("row-1"),
            "row-2": BatchResultItem(
                custom_id="row-2", text=None, stop_reason=None,
                tokens_in=0, tokens_out=0, error="rate_limit_error",
            ),
        })
        orch.submit(conn, job_id="j1", batches_client=stub)
        orch.finalize(conn, job_id="j1", batches_client=stub,
                      today=date(2026, 4, 21))
        rows = get_rows(conn, "j1")
        assert "resolver_failed" in rows[1].flags

    def test_unparseable_json_flagged(self, conn, sample_xlsx_bytes, batch_root) -> None:
        orch.ingest(conn, job_id="j1", input_bytes=sample_xlsx_bytes,
                    input_filename="m.xlsx")
        stub = StubBatches({
            "row-1": _good_result("row-1"),
            "row-2": BatchResultItem(
                custom_id="row-2", text="not JSON at all!",
                stop_reason="end_turn", tokens_in=1, tokens_out=1, error=None,
            ),
        })
        orch.submit(conn, job_id="j1", batches_client=stub)
        orch.finalize(conn, job_id="j1", batches_client=stub,
                      today=date(2026, 4, 21))
        rows = get_rows(conn, "j1")
        assert "resolver_failed" in rows[1].flags

    def test_tolerates_fenced_json(self, conn, sample_xlsx_bytes, batch_root) -> None:
        # Sonnet sometimes wraps output in ```json … ``` — orchestrator strips.
        orch.ingest(conn, job_id="j1", input_bytes=sample_xlsx_bytes,
                    input_filename="m.xlsx")
        fenced = (
            '```json\n'
            '{"hs_code": "610910000000", "arabic_description": "تيشيرت",'
            ' "confidence": 0.9, "rationale": "x"}\n'
            '```'
        )
        stub = StubBatches({
            "row-1": BatchResultItem(
                custom_id="row-1", text=fenced, stop_reason="end_turn",
                tokens_in=1, tokens_out=1, error=None,
            ),
            "row-2": _good_result("row-2"),
        })
        orch.submit(conn, job_id="j1", batches_client=stub)
        orch.finalize(conn, job_id="j1", batches_client=stub,
                      today=date(2026, 4, 21))
        rows = get_rows(conn, "j1")
        assert rows[0].hs_code == "610910000000"
        assert "resolver_failed" not in rows[0].flags

    def test_finalize_idempotent_when_done(self, conn, sample_xlsx_bytes, batch_root) -> None:
        orch.ingest(conn, job_id="j1", input_bytes=sample_xlsx_bytes,
                    input_filename="m.xlsx")
        stub = StubBatches({
            "row-1": _good_result("row-1"),
            "row-2": _good_result("row-2"),
        })
        orch.submit(conn, job_id="j1", batches_client=stub)
        first = orch.finalize(conn, job_id="j1", batches_client=stub,
                              today=date(2026, 4, 21))
        second = orch.finalize(conn, job_id="j1", batches_client=stub,
                               today=date(2026, 4, 21))
        assert first == second


class TestDryRunMode:
    def test_anthropic_batches_dry_run(self, monkeypatch) -> None:
        """CLEARAI_BATCH_DRY=1 lets us submit+fetch without API calls.
        Exercises the wrapper's stub code path directly."""
        monkeypatch.setenv("CLEARAI_BATCH_DRY", "1")
        # Fresh class-level cache each test.
        AnthropicBatches._results_store.clear()
        client = AnthropicBatches()
        reqs = [
            BatchRequest(custom_id="row-1", params={
                "model": "claude-x", "max_tokens": 10,
                "messages": [{"role": "user", "content": "hi"}],
            }),
        ]
        bid = client.submit(reqs)
        # New sync-loop id shape: msgbatch_sync_<ts>_<hex>
        assert bid.startswith("msgbatch_sync_")
        st = client.status(bid)
        assert st.processing_status == "ended"
        results = list(client.fetch_results(bid))
        assert len(results) == 1
        assert results[0].error is None
        # Stub echoes a valid JSON payload so parse succeeds.
        parsed = json.loads(results[0].text)
        assert "hs_code" in parsed
