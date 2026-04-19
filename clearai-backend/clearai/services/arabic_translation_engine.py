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
    """Scan the row for any non-empty string field whose content is Arabic.

    The real Naqel file doesn't have a single standard "ArabicDescription"
    column — some rows put Arabic in `Description`, some in other ad-hoc fields.
    We accept the first Arabic-looking value we see.
    """
    for _key, value in row.items():
        if isinstance(value, str) and value.strip():
            if _is_arabic(value):
                return value.strip()
    return ""
