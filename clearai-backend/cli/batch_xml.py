"""
cli/batch_xml.py — offline batch runner for Session 1.

Reads a Naqel-style commercial-invoice Excel, resolves each row's HS code +
Arabic description through the existing ClearAI resolver, and writes one
SaudiEDI H2HDECSUB XML per row to a target directory. No web API, no queue —
just a straight path from `.xlsx` → directory-of-`.XML`.

Purpose:
  - Validate the XML builder against real merchant input before wiring the
    Anthropic Batches API (Session 2).
  - Let you diff generated XML against Naqel's post-processed samples byte
    for byte.
  - Give the frontend team a binary to point at during UI development.

Usage:
    python -m cli.batch_xml INPUT.xlsx OUTPUT_DIR [--dry-run] [--limit N]

Expected Excel columns (from the sample):
    WaybillNo, weight, ClientID, CurrencyID, declaredValue,
    DestinationStationID, Mobile, PhoneNumber, ConsigneeName,
    ConsigneeNationalID, Quantity, UnitType, CountryofManufacture,
    Description, CustomsCommodityCode, UnitCost, Amount, Currency,
    ChineseDescription, SKU, CPC, ItemWeightValue, ItemWeightUnit

Extra columns are ignored. Missing values are tolerated row-by-row — the
builder falls back on constants from `config.BAYAN_CONSTANTS` and flags
unknowns via `saudi_edi_mappings` logging.
"""

from __future__ import annotations

import argparse
import logging
import sqlite3
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Any

from clearai import config
from clearai.adapters.anthropic_reasoner import AnthropicReasoner
from clearai.services import bayan_xml, saudi_edi_mappings as mappings
from clearai.services.arabic_translation_engine import ArabicTranslationEngine
from clearai.services.batch_job_store import allocate_doc_ref_seq
from clearai.services.batch_row_policy import (
    FLAG_LOW_CONFIDENCE_HS, FLAG_NO_ARABIC_DESCRIPTION,
    FLAG_RESOLVER_FAILED, resolve_country_of_manufacture,
)
from clearai.services.bayan_xml import (
    ConsigneeInfo, DeclarationItem, WaybillDeclaration,
)
from clearai.services.hs_resolver import HSResolver

logger = logging.getLogger("clearai.cli.batch_xml")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="batch_xml",
        description="Resolve an Excel of invoice rows to SaudiEDI XML files.",
    )
    ap.add_argument("input", type=Path, help="Input .xlsx / .csv path")
    ap.add_argument("output_dir", type=Path, help="Directory to write XMLs into")
    ap.add_argument(
        "--dry-run", action="store_true",
        help="Build XMLs but do not write files. Useful for regression tests.",
    )
    ap.add_argument(
        "--limit", type=int, default=0,
        help="Process only the first N rows. 0 = all.",
    )
    ap.add_argument(
        "--no-llm", action="store_true",
        help="Skip HS resolver + Arabic LLM (use declared code and raw EN "
             "description). For rapid schema iteration without API cost.",
    )
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    rows = _load_rows(args.input)
    if args.limit:
        rows = rows[: args.limit]
    logger.info("Loaded %d rows from %s", len(rows), args.input)

    args.output_dir.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(config.DB_PATH))
    conn.row_factory = sqlite3.Row
    resolver = None
    ar_engine = None
    if not args.no_llm:
        reasoner = AnthropicReasoner()
        resolver = HSResolver(reasoner=reasoner)
        ar_engine = ArabicTranslationEngine(conn=conn, reasoner=reasoner)

    today = date.today()
    written = 0
    review_rows: list[dict[str, Any]] = []
    for i, row in enumerate(rows, start=1):
        try:
            xml, flags = _build_one(
                row=row,
                conn=conn,
                resolver=resolver,
                ar_engine=ar_engine,
                today=today,
                no_llm=args.no_llm,
            )
        except Exception as e:  # noqa: BLE001 — batch robustness
            logger.error("Row %d (waybill=%s) failed: %s",
                         i, row.get("WaybillNo"), e)
            review_rows.append({
                "row": i,
                "WaybillNo": row.get("WaybillNo", ""),
                "flags": "build_error",
                "error": f"{type(e).__name__}: {e}",
                "xml_filename": "",
            })
            continue
        out_name = f"NQD{_extract_ref_suffix(xml)}.XML"
        if args.dry_run:
            logger.info("[dry-run] would write %s (%d bytes)", out_name, len(xml))
        else:
            (args.output_dir / out_name).write_text(xml, encoding="utf-8")
            logger.info("wrote %s%s",
                        out_name,
                        f"  [flags: {','.join(flags)}]" if flags else "")
        if flags:
            review_rows.append({
                "row": i,
                "WaybillNo": row.get("WaybillNo", ""),
                "flags": ",".join(flags),
                "error": "",
                "xml_filename": out_name,
            })
        written += 1

    # Emit review.csv even when empty so operators always know where to look.
    if not args.dry_run:
        _write_review_csv(args.output_dir / "review.csv", review_rows)
        logger.info("review.csv: %d flagged row(s) of %d",
                    len(review_rows), len(rows))

    logger.info("Done. %d / %d XMLs produced in %s",
                written, len(rows), args.output_dir)
    return 0 if written == len(rows) else 1


# ---------------------------------------------------------------------------
# Per-row builder
# ---------------------------------------------------------------------------
def _build_one(
    *,
    row: dict[str, Any],
    conn: sqlite3.Connection,
    resolver: HSResolver | None,
    ar_engine: ArabicTranslationEngine | None,
    today: date,
    no_llm: bool,
) -> tuple[str, list[str]]:
    """Build one SaudiEDI XML. Returns `(xml_string, flags)` where `flags` is
    a list of review-queue tags (empty when the row is clean)."""
    flags: list[str] = []
    waybill = str(row.get("WaybillNo") or "").strip()
    if not waybill:
        raise ValueError("row missing WaybillNo")

    # HS code: live resolver unless --no-llm.
    if no_llm or resolver is None:
        hs_code = str(row.get("CustomsCommodityCode") or "").replace(".", "").strip()
    else:
        res = resolver.resolve(row)
        hs_code = res.hs_code or str(row.get("CustomsCommodityCode") or "")\
            .replace(".", "").strip()
        if res.flagged_for_review:
            logger.warning("waybill=%s flagged (conf=%.2f path=%s)",
                           waybill, res.confidence, res.path)
            flags.append(FLAG_LOW_CONFIDENCE_HS)
        if res.path == "failed":
            flags.append(FLAG_RESOLVER_FAILED)

    # Arabic description: use engine when available, else EN passthrough.
    if no_llm or ar_engine is None:
        arabic = str(row.get("Description") or "")
    else:
        ar_res = ar_engine.resolve(
            row=row,
            hs_code=hs_code,
            declared_code=str(row.get("CustomsCommodityCode") or ""),
        )
        arabic = ar_res.arabic or str(row.get("Description") or "")
        if not ar_res.arabic:
            flags.append(FLAG_NO_ARABIC_DESCRIPTION)

    # Country of manufacture — policy A: empty → "XX" + flag.
    country_result = resolve_country_of_manufacture(row.get("CountryofManufacture"))
    if country_result.flag:
        flags.append(country_result.flag)

    # Station → (regPort, city)
    reg_port, city_code = mappings.lookup_station(row.get("DestinationStationID"))

    # Currency
    currency_code = mappings.lookup_currency(row.get("CurrencyID"), row.get("Currency"))

    # Unit
    unit_code = mappings.lookup_unit_type(row.get("UnitType"))

    item = DeclarationItem(
        seq_no=1,
        country_of_origin=country_result.value,
        tariff_code=hs_code,
        goods_description_ar=arabic,
        quantity=float(row.get("Quantity") or 1),
        # Baseline samples emit net == gross for single-item shipments; mirror
        # that when no explicit net is given. ItemWeightValue is treated as an
        # override only if it's NOT the literal same as the weight col.
        gross_weight=float(row.get("weight") or 0),
        net_weight=float(row.get("weight") or row.get("ItemWeightValue") or 0),
        # Sample 1 used the settled `Amount` (3426.35) as unit invoice cost
        # rather than the list price `UnitCost` (3500). Mirror that precedence.
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
        # Pre-processed Excel has no address column — the builder falls back
        # to the Arabic city name for the resolved city_code.
        address="",
        city_code=city_code,
    )

    # docRefNo: NQD + yymmdd + 5-digit sequence from the SQLite counter.
    seq = allocate_doc_ref_seq(conn, today)
    doc_ref = bayan_xml.generate_doc_ref_no(today, seq)

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
    return bayan_xml.build_declaration_xml(decl), flags


# ---------------------------------------------------------------------------
# review.csv writer
# ---------------------------------------------------------------------------
def _write_review_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    """Write the operator-facing review queue as CSV.

    Columns: row, WaybillNo, flags, error, xml_filename.
    Always written — an empty file with just the header is a valid
    "no flagged rows" signal.
    """
    import csv
    headers = ["row", "WaybillNo", "flags", "error", "xml_filename"]
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in headers})


# ---------------------------------------------------------------------------
# Input parsing
# ---------------------------------------------------------------------------
def _load_rows(path: Path) -> list[dict[str, Any]]:
    """Read .xlsx or .csv into a list of normalized dicts."""
    suffix = path.suffix.lower()
    if suffix in {".xlsx", ".xls"}:
        import pandas as pd
        df = pd.read_excel(path, dtype=str, engine=None)
    elif suffix == ".csv":
        import pandas as pd
        df = pd.read_csv(path, dtype=str)
    else:
        raise ValueError(f"Unsupported input format: {suffix}")
    df = df.fillna("")
    return df.to_dict(orient="records")


def _maybe_float(v: Any) -> float | None:
    if v is None or str(v).strip() == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _extract_ref_suffix(xml: str) -> str:
    """Pull the `NQD…` id out of the root element so callers can name files."""
    marker = 'decsub:id="NQD'
    i = xml.find(marker)
    if i < 0:
        return datetime.now().strftime("%y%m%d%H%M%S")
    start = i + len(marker)
    end = xml.find('"', start)
    return xml[start:end] if end > start else ""


if __name__ == "__main__":
    sys.exit(main())
