"""
batch_orchestrator.py — coordinate an end-to-end batch run.

Responsibilities:

  1. ingest()   — parse the uploaded Excel/CSV, persist job + row stubs.
  2. submit()   — package one Batches API request per row, POST to Anthropic,
                  stash the returned batch id.
  3. finalize() — once the Batches API reports `ended`, fetch results, parse
                  each row's JSON, build the SaudiEDI XML, write review.csv,
                  and zip everything into the output directory.

The split mirrors the state machine in `batch_job_store`:

    pending → submitting → running → finalizing → done
                                               ↘ failed

Why not async: we're I/O-bound against Anthropic's minutes-to-hours SLA.
A BackgroundTasks-fired sync function with explicit sleeps inside a thread
is simpler than asyncio glue, and blocks nothing because FastAPI runs it
off the main event loop.
"""

from __future__ import annotations

import csv
import io
import json
import logging
import re
import sqlite3
import zipfile
from datetime import date
from pathlib import Path
from typing import Any

from clearai import config
from clearai.adapters.anthropic_batches import (
    AnthropicBatches, BatchRequest, build_row_request,
)
from clearai.services import bayan_xml as bayan
from clearai.services import saudi_edi_mappings as mappings
from clearai.services.batch_job_store import (
    allocate_doc_ref_seq, create_job, get_job, get_rows, update_job,
    upsert_rows,
)
from clearai.services.batch_row_policy import (
    FLAG_LOW_CONFIDENCE_HS, FLAG_NO_ARABIC_DESCRIPTION,
    FLAG_RESOLVER_FAILED, resolve_country_of_manufacture,
)
from clearai.services.bayan_xml import (
    ConsigneeInfo, DeclarationItem, WaybillDeclaration,
)

logger = logging.getLogger("clearai.batch_orchestrator")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
# Where ingested uploads + finalised ZIPs live, per job.
BATCH_ROOT = config.OUTPUT_DIR / "batches"

# Low-confidence cut-off — below this we flag for review. Matches the
# policy used in the live /api/resolve path.
LOW_CONF_THRESHOLD = 0.55


# ---------------------------------------------------------------------------
# ingest
# ---------------------------------------------------------------------------
def ingest(
    conn: sqlite3.Connection,
    *,
    job_id: str,
    input_bytes: bytes,
    input_filename: str,
) -> int:
    """Persist the uploaded spreadsheet as a pending job + row stubs.

    Returns the number of rows loaded. Raises ValueError on an unsupported
    format or an empty sheet.
    """
    rows = _load_rows(input_bytes, input_filename)
    if not rows:
        raise ValueError("input contained zero rows")

    create_job(conn, job_id=job_id, row_count=len(rows),
               input_filename=input_filename)

    # Persist the raw payload so re-running finalize doesn't need the
    # original upload to still be in memory.
    job_dir = BATCH_ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    (job_dir / f"input{Path(input_filename).suffix}").write_bytes(input_bytes)

    # Seed batch_rows with waybill + country only — hs_code/arabic come later.
    seeds = []
    for i, row in enumerate(rows, start=1):
        country_result = resolve_country_of_manufacture(row.get("CountryofManufacture"))
        seeds.append({
            "row_idx": i,
            "waybill_no": str(row.get("WaybillNo") or "").strip() or None,
            "country_of_origin": country_result.value,
            "flags": [country_result.flag] if country_result.flag else [],
        })
    upsert_rows(conn, job_id, seeds)
    logger.info("ingest: job=%s rows=%d file=%s", job_id, len(rows), input_filename)
    return len(rows)


# ---------------------------------------------------------------------------
# submit
# ---------------------------------------------------------------------------
def submit(
    conn: sqlite3.Connection,
    *,
    job_id: str,
    batches_client: AnthropicBatches | None = None,
) -> str:
    """Send all row prompts to the Anthropic Batches API.

    Returns the Anthropic batch id. Also advances job state:
      pending → submitting → running.
    """
    job = get_job(conn, job_id)
    if job is None:
        raise ValueError(f"submit: unknown job_id={job_id!r}")
    if job.state not in {"pending"}:
        raise ValueError(f"submit: job state must be 'pending', got {job.state!r}")

    rows = _read_input(job_id, job.input_filename)
    update_job(conn, job_id, state="submitting")

    requests: list[BatchRequest] = []
    for i, row in enumerate(rows, start=1):
        desc = str(row.get("Description") or "").strip()
        declared = str(row.get("CustomsCommodityCode") or "").strip()
        requests.append(build_row_request(
            custom_id=f"row-{i}",
            description=desc,
            declared_code=declared,
        ))

    client = batches_client or AnthropicBatches()
    try:
        anthropic_id = client.submit(requests)
    except Exception as e:  # noqa: BLE001
        update_job(conn, job_id, state="failed", error=f"submit: {e}")
        raise

    update_job(conn, job_id, anthropic_batch_id=anthropic_id, state="running")
    logger.info("submit: job=%s → anthropic=%s (%d rows)",
                job_id, anthropic_id, len(requests))
    return anthropic_id


# ---------------------------------------------------------------------------
# finalize
# ---------------------------------------------------------------------------
def finalize(
    conn: sqlite3.Connection,
    *,
    job_id: str,
    batches_client: AnthropicBatches | None = None,
    today: date | None = None,
) -> Path:
    """Pull results, build XMLs + review.csv + ZIP. Marks job `done`.

    Idempotent once `done` — returns the existing ZIP path.
    """
    job = get_job(conn, job_id)
    if job is None:
        raise ValueError(f"finalize: unknown job_id={job_id!r}")
    if job.state == "done" and job.output_zip_path:
        return Path(job.output_zip_path)
    if job.state not in {"running", "finalizing"}:
        raise ValueError(
            f"finalize: job state must be 'running' or 'finalizing', "
            f"got {job.state!r}"
        )
    if not job.anthropic_batch_id:
        raise ValueError("finalize: job has no anthropic_batch_id")

    update_job(conn, job_id, state="finalizing")

    client = batches_client or AnthropicBatches()
    status = client.status(job.anthropic_batch_id)
    if status.processing_status != "ended":
        # Caller polled too early — leave state untouched.
        update_job(conn, job_id, state="running")
        raise RuntimeError(
            f"finalize: batch {job.anthropic_batch_id} not ended "
            f"(status={status.processing_status})"
        )

    # Re-read the original rows for XML assembly (we need all Excel columns,
    # not just the fields we persisted).
    rows = _read_input(job_id, job.input_filename)

    # Index results by custom_id for ordered walk.
    results: dict[str, Any] = {}
    for item in client.fetch_results(job.anthropic_batch_id):
        results[item.custom_id] = item

    today = today or date.today()
    job_dir = BATCH_ROOT / job_id
    xml_dir = job_dir / "xmls"
    xml_dir.mkdir(parents=True, exist_ok=True)

    row_updates: list[dict[str, Any]] = []
    completed = 0
    flagged = 0
    review_rows: list[dict[str, Any]] = []

    for i, row in enumerate(rows, start=1):
        flags: list[str] = []
        custom_id = f"row-{i}"
        res = results.get(custom_id)

        hs_code = str(row.get("CustomsCommodityCode") or "").replace(".", "").strip()
        arabic = str(row.get("Description") or "")
        row_error: str | None = None

        if res is None:
            flags.append(FLAG_RESOLVER_FAILED)
            row_error = "missing result from Batches API"
        elif res.error:
            flags.append(FLAG_RESOLVER_FAILED)
            row_error = res.error
        else:
            parsed = _parse_row_json(res.text or "")
            if parsed is None:
                flags.append(FLAG_RESOLVER_FAILED)
                row_error = "unparseable JSON"
            else:
                llm_code = (parsed.get("hs_code") or "").strip()
                if llm_code and llm_code.isdigit():
                    hs_code = llm_code
                llm_ar = (parsed.get("arabic_description") or "").strip()
                if llm_ar:
                    arabic = llm_ar
                else:
                    flags.append(FLAG_NO_ARABIC_DESCRIPTION)
                conf = float(parsed.get("confidence") or 0.0)
                if conf < LOW_CONF_THRESHOLD:
                    flags.append(FLAG_LOW_CONFIDENCE_HS)

        # Country-of-origin policy (re-run so the flag lives next to the
        # post-resolve flags in the same row).
        country_result = resolve_country_of_manufacture(row.get("CountryofManufacture"))
        if country_result.flag and country_result.flag not in flags:
            flags.append(country_result.flag)

        waybill = str(row.get("WaybillNo") or "").strip()
        xml_filename = ""
        if waybill and hs_code:
            try:
                xml_str = _build_xml(
                    row=row,
                    conn=conn,
                    today=today,
                    hs_code=hs_code,
                    arabic=arabic,
                    country=country_result.value,
                )
                xml_filename = _extract_filename(xml_str)
                (xml_dir / xml_filename).write_text(xml_str, encoding="utf-8")
                completed += 1
            except Exception as e:  # noqa: BLE001
                flags.append(FLAG_RESOLVER_FAILED)
                row_error = f"xml build: {type(e).__name__}: {e}"
        else:
            # Missing waybill or hs_code — skip the XML but keep the flag trail.
            if not waybill:
                row_error = row_error or "row missing WaybillNo"

        if flags:
            flagged += 1
            review_rows.append({
                "row": i,
                "WaybillNo": waybill,
                "flags": ",".join(flags),
                "error": row_error or "",
                "xml_filename": xml_filename,
            })

        row_updates.append({
            "row_idx": i,
            "waybill_no": waybill or None,
            "hs_code": hs_code or None,
            "arabic_description": arabic or None,
            "country_of_origin": country_result.value,
            "flags": flags,
            "xml_filename": xml_filename or None,
            "error": row_error,
        })

    upsert_rows(conn, job_id, row_updates)

    # review.csv
    review_path = job_dir / "review.csv"
    _write_review_csv(review_path, review_rows)

    # ZIP everything deliverable.
    zip_path = job_dir / f"batch-{job_id}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for xml_file in sorted(xml_dir.glob("*.XML")):
            zf.write(xml_file, arcname=f"xmls/{xml_file.name}")
        zf.write(review_path, arcname="review.csv")

    update_job(conn, job_id,
               state="done",
               completed_count=completed,
               flagged_count=flagged,
               output_zip_path=str(zip_path))
    logger.info("finalize: job=%s done (%d XMLs, %d flagged) → %s",
                job_id, completed, flagged, zip_path)
    return zip_path


# ---------------------------------------------------------------------------
# XML construction — shared helpers
# ---------------------------------------------------------------------------
def _build_xml(
    *,
    row: dict[str, Any],
    conn: sqlite3.Connection,
    today: date,
    hs_code: str,
    arabic: str,
    country: str,
) -> str:
    """Assemble one SaudiEDI XML from a resolved row.

    Mirrors `cli.batch_xml._build_one` but takes pre-resolved HS + Arabic
    since the Batches API already supplied those. Intentionally duplicated
    rather than refactored into a shared helper: the CLI needs the live
    resolver path, the orchestrator needs the batch-results path, and
    conflating the two makes the control flow harder to reason about.
    """
    waybill = str(row.get("WaybillNo") or "").strip()
    reg_port, city_code = mappings.lookup_station(row.get("DestinationStationID"))
    currency_code = mappings.lookup_currency(
        row.get("CurrencyID"), row.get("Currency"),
    )
    unit_code = mappings.lookup_unit_type(row.get("UnitType"))

    item = DeclarationItem(
        seq_no=1,
        country_of_origin=country,
        tariff_code=hs_code,
        goods_description_ar=arabic,
        quantity=float(row.get("Quantity") or 1),
        gross_weight=float(row.get("weight") or 0),
        net_weight=float(row.get("weight") or row.get("ItemWeightValue") or 0),
        unit_invoice_cost=(
            _maybe_float(row.get("Amount"))
            or _maybe_float(row.get("declaredValue"))
            or _maybe_float(row.get("UnitCost"))
        ),
        item_cost=float(row.get("Amount") or row.get("declaredValue") or 0),
        unit_type_code=unit_code,
    )
    consignee = ConsigneeInfo(
        name=str(row.get("ConsigneeName") or "UNKNOWN"),
        national_id=str(row.get("ConsigneeNationalID") or "0"),
        phone=str(row.get("Mobile") or row.get("PhoneNumber") or ""),
        address="",
        city_code=city_code,
    )
    seq = allocate_doc_ref_seq(conn, today)
    doc_ref = bayan.generate_doc_ref_no(today, seq)
    decl = WaybillDeclaration(
        doc_ref_no=doc_ref,
        invoice_no=waybill,
        waybill_no=waybill,
        invoice_date=today,
        invoice_currency_code=currency_code,
        reg_port=reg_port,
        client_id=str(row.get("ClientID") or ""),
        items=(item,),
        consignee=consignee,
    )
    return bayan.build_declaration_xml(decl)


def _extract_filename(xml: str) -> str:
    """Pull the NQD id out of the root and wrap it as `NQD….XML`."""
    m = re.search(r'decsub:id="(NQD[^"]+)"', xml)
    return f"{m.group(1)}.XML" if m else "unknown.XML"


def _write_review_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    headers = ["row", "WaybillNo", "flags", "error", "xml_filename"]
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in headers})


def _maybe_float(v: Any) -> float | None:
    if v is None or str(v).strip() == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# JSON parsing — the Batches result text is supposed to be pure JSON, but
# Sonnet/Opus sometimes wrap it in ```json fences. Tolerate both.
# ---------------------------------------------------------------------------
def _parse_row_json(text: str) -> dict[str, Any] | None:
    text = text.strip()
    if not text:
        return None
    # Strip ```json fences if present.
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        # Last resort: pluck the first {...} block.
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            return None
        try:
            obj = json.loads(m.group(0))
            return obj if isinstance(obj, dict) else None
        except json.JSONDecodeError:
            return None


# ---------------------------------------------------------------------------
# Excel/CSV parsing — kept private so the orchestrator owns its I/O contract
# ---------------------------------------------------------------------------
def _load_rows(input_bytes: bytes, filename: str) -> list[dict[str, Any]]:
    suffix = Path(filename).suffix.lower()
    import pandas as pd
    if suffix in {".xlsx", ".xls"}:
        df = pd.read_excel(io.BytesIO(input_bytes), dtype=str)
    elif suffix == ".csv":
        df = pd.read_csv(io.BytesIO(input_bytes), dtype=str)
    else:
        raise ValueError(f"unsupported input format: {suffix}")
    df = df.fillna("")
    return df.to_dict(orient="records")


def _read_input(job_id: str, filename: str | None) -> list[dict[str, Any]]:
    """Re-hydrate the original upload from disk."""
    if not filename:
        raise ValueError(f"_read_input: job {job_id} has no input_filename")
    job_dir = BATCH_ROOT / job_id
    path = job_dir / f"input{Path(filename).suffix}"
    if not path.exists():
        raise FileNotFoundError(f"_read_input: {path} missing")
    return _load_rows(path.read_bytes(), filename)


__all__ = ["ingest", "submit", "finalize", "BATCH_ROOT"]
