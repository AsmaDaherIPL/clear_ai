"""
Arabic description resolution for the XML builder.

The Bayan XML requires every item to carry an Arabic `goodsDescription`. The
resolution order, cheapest to most expensive:

  1. Invoice row's own Arabic description, if the merchant supplied one
     (any field on the row whose value is recognizably Arabic — checked first).
  2. Master row's `arabic_name` for the resolved HS code, if present.
  3. Ledger `arabic_name` tied to the merchant's declared raw code — cached
     institutional knowledge, free lookup.
  4. LLM translation via TRANSLATION_MODEL (Haiku) over the English description.
     In-process cache keyed by English description so the same phrase is not
     re-translated per row.

Failure mode: if all four paths fail, returns an empty string and flags the
caller — the XML builder must decide whether to fall back to English or hold
the row. This engine never raises on a single row.

Environment: uses TRANSLATION_MODEL from config.py (default Haiku, the cheapest
tier) — see ADR-004 for why translation is its own tier.
"""

from __future__ import annotations

import logging
import sqlite3
from dataclasses import dataclass
from typing import Any

from clearai.ports.reasoner import HSReasoner, ReasonerError

logger = logging.getLogger("clearai.arabic_translation_engine")

# Arabic Unicode ranges (base block + presentation forms). If any char of a
# string falls in these, we call it Arabic.
_ARABIC_RANGES = (
    (0x0600, 0x06FF),
    (0x0750, 0x077F),
    (0x08A0, 0x08FF),
    (0xFB50, 0xFDFF),
    (0xFE70, 0xFEFF),
)

SOURCE_INVOICE = "invoice"
SOURCE_MASTER = "master"
SOURCE_LEDGER = "ledger"
SOURCE_LLM = "llm_translation"
SOURCE_MISSING = "missing"


@dataclass(frozen=True)
class ArabicResolution:
    arabic: str
    source: str           # one of SOURCE_* constants
    cache_hit: bool = False


class ArabicTranslationEngine:
    """Resolves an Arabic goodsDescription for a given invoice row + HS code.

    One instance per batch run. Call `resolve()` per item. Owns its own
    in-process translation cache; does not own the SQLite connection.
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        reasoner: HSReasoner,
    ) -> None:
        self._conn = conn
        if self._conn.row_factory is not sqlite3.Row:
            self._conn.row_factory = sqlite3.Row
        self._reasoner = reasoner
        self._translation_cache: dict[str, str] = {}

    # ---- public entrypoint ------------------------------------------
    def resolve(
        self,
        *,
        row: dict[str, Any],
        hs_code: str,
        declared_code: str = "",
    ) -> ArabicResolution:
        """Resolve one item's Arabic description. Never raises."""
        # Path 1 — invoice row already contains Arabic.
        invoice_ar = _first_arabic_field(row)
        if invoice_ar:
            return ArabicResolution(arabic=invoice_ar, source=SOURCE_INVOICE)

        # Path 2 — master row Arabic name for the resolved HS code.
        if hs_code:
            master_ar = self._master_arabic(hs_code)
            if master_ar:
                return ArabicResolution(arabic=master_ar, source=SOURCE_MASTER)

        # Path 3 — ledger Arabic by declared raw code.
        if declared_code:
            ledger_ar = self._ledger_arabic(declared_code)
            if ledger_ar:
                return ArabicResolution(arabic=ledger_ar, source=SOURCE_LEDGER)

        # Path 4 — LLM translation fallback (TRANSLATION_MODEL / Haiku).
        description_en = (row.get("Description") or "").strip()
        if not description_en:
            logger.warning("arabic resolve: no description to translate; row=%r",
                           row.get("WayBillNo"))
            return ArabicResolution(arabic="", source=SOURCE_MISSING)

        cached = self._translation_cache.get(description_en)
        if cached is not None:
            return ArabicResolution(
                arabic=cached, source=SOURCE_LLM, cache_hit=True
            )

        try:
            result = self._reasoner.translate_to_arabic(description_en)
        except ReasonerError as e:
            logger.warning("arabic resolve: TRANSLATION_MODEL failed for %r: %s",
                           description_en[:80], e)
            return ArabicResolution(arabic="", source=SOURCE_MISSING)

        arabic = (result.arabic_description or "").strip()
        if not arabic:
            return ArabicResolution(arabic="", source=SOURCE_MISSING)

        self._translation_cache[description_en] = arabic
        return ArabicResolution(arabic=arabic, source=SOURCE_LLM)

    # ---- helpers ----------------------------------------------------
    def _master_arabic(self, hs_code: str) -> str:
        cur = self._conn.execute(
            "SELECT arabic_name FROM hs_code_master WHERE hs_code = ?",
            (hs_code,),
        )
        row = cur.fetchone()
        if row is None:
            return ""
        return (row["arabic_name"] or "").strip()

    def _ledger_arabic(self, declared_code: str) -> str:
        cur = self._conn.execute(
            "SELECT arabic_name FROM hs_decision_ledger "
            "WHERE raw_code = ? AND arabic_name IS NOT NULL "
            "LIMIT 1",
            (declared_code,),
        )
        row = cur.fetchone()
        if row is None:
            return ""
        return (row["arabic_name"] or "").strip()


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------
def _is_arabic(text: str) -> bool:
    if not text:
        return False
    for ch in text:
        o = ord(ch)
        for lo, hi in _ARABIC_RANGES:
            if lo <= o <= hi:
                return True
    return False


def _first_arabic_field(row: dict[str, Any]) -> str:
    """Scan the row for an Arabic product description.

    Bug-fix (P1 code-review): previously scanned ALL string fields and
    returned the first Arabic-looking value. Real shipments commonly have
    Arabic consignee names, addresses, cities, notes — those would leak
    into goodsDescription (PII + wrong-description customs filing).

    Policy now:
    1. **Allow-list first.** If any of the known product-description keys
       contains Arabic text, return that. Covers the Naqel/ZATCA columns
       we've observed in the field.
    2. **Deny-list fallback.** If no allow-list key matched, scan the
       remaining fields but SKIP anything whose key matches known PII /
       non-product patterns (consignee, address, city, phone, email, id,
       name, contact, shipper, sender, postal, region).
    3. Return "" if nothing found. Better to translate EN than leak PII.
    """
    # Keys that are legitimate product-description carriers. Case-insensitive,
    # substring match. Order matters — the first allow-list hit wins.
    _ALLOW = (
        "arabicdescription", "arabic_name", "arabicname", "ar_description",
        "descriptionar", "description_ar", "descar", "goodsdescription",
        "goods_description", "productdescription", "product_description",
        "itemdescription", "item_description", "description",
    )
    # Keys that MUST NEVER source the product description — they carry PII
    # or shipping metadata. Substring match on lower-cased key.
    _DENY = (
        "consignee", "shipper", "sender", "receiver", "recipient",
        "address", "addr", "street", "city", "region", "province",
        "country", "postal", "zip", "po_box", "pobox",
        "phone", "tel", "mobile", "fax", "email", "contact",
        "name", "company", "merchant_name", "client_name",
        "id", "natid", "nationalid", "passport", "iqama", "crnumber",
        "note", "remarks", "comment", "instruction",
    )

    def _key_norm(k: Any) -> str:
        return str(k).lower().replace("-", "_").replace(" ", "_")

    # Pass 1: allow-list
    for key, value in row.items():
        if not isinstance(value, str) or not value.strip():
            continue
        k = _key_norm(key)
        if any(a in k for a in _ALLOW) and _is_arabic(value):
            return value.strip()

    # Pass 2: any other field, but skip deny-listed keys
    for key, value in row.items():
        if not isinstance(value, str) or not value.strip():
            continue
        k = _key_norm(key)
        if any(d in k for d in _DENY):
            continue
        if any(a in k for a in _ALLOW):
            continue  # already checked in pass 1
        if _is_arabic(value):
            return value.strip()

    return ""
