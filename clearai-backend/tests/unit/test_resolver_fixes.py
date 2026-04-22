"""Regression tests for the four P1/P2 code-review fixes.

Each test is a targeted micro-test — not a full integration exercise. They
lock in the specific bug signature so it cannot silently regress.

Fixes covered:
  1. `_longest_prefix_match` no longer skips the declared code's own length
     (max_len was `len(declared) - 1`).
  2. Prefix SQL no longer applies `LIMIT 25` (which dropped correct leaves
     on broad 4–6 digit prefixes).
  3. `_first_arabic_field` does not return Arabic from PII/metadata fields
     (consignee, address, city, phone, name, id, notes …).
  4. `rank_candidates` returning an out-of-set HS code is rejected and the
     resolver falls back to the first tied candidate at <=0.60 confidence.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, Sequence

import pytest

from clearai.ports.reasoner import (
    Candidate,
    ClosestAlternativeResult,
    HSReasoner,
    JustificationInput,
    JustificationResult,
    RankerInput,
    ReasonerInput,
    ReasonerResult,
)
from clearai.services.arabic_translation_engine import _first_arabic_field
from clearai.services.hs_resolver import (
    CONF_PREFIX_BY_LEN,
    HSResolver,
    PATH_PREFIX,
)


# ---------------------------------------------------------------------------
# Fake reasoner — programmable rank_candidates, everything else raises.
# ---------------------------------------------------------------------------
class _FakeReasoner(HSReasoner):
    def __init__(self, rank_code: str, rank_confidence: float = 0.85) -> None:
        self._rank_code = rank_code
        self._rank_confidence = rank_confidence

    def refine_description_en(self, **kwargs: Any) -> ReasonerResult:  # noqa: D401
        raise NotImplementedError

    def translate_to_arabic(self, description_en: str) -> ReasonerResult:
        raise NotImplementedError

    def rank_candidates(self, payload: RankerInput) -> ReasonerResult:
        return ReasonerResult(
            hs_code=self._rank_code,
            confidence=self._rank_confidence,
            rationale="fake-ranker",
            model_used="fake",
        )

    def infer_hs_code(self, payload: ReasonerInput) -> ReasonerResult:
        raise NotImplementedError

    def build_closest_alternative(
        self,
        *,
        picked_code: str,
        picked_description_en: str,
        faiss_candidates: Sequence[Candidate],
    ) -> ClosestAlternativeResult | None:
        return None

    def build_justification(
        self, payload: JustificationInput
    ) -> JustificationResult | None:
        return None


# ---------------------------------------------------------------------------
# SQLite fixture — minimal hs_code_master + hs_decision_ledger.
# ---------------------------------------------------------------------------
def _build_db(tmp_path: Path, rows: list[tuple[str, str, str]]) -> Path:
    """rows = [(hs_code, description_en, arabic_name), ...]"""
    db = tmp_path / "test.db"
    conn = sqlite3.connect(str(db))
    conn.execute(
        """CREATE TABLE hs_code_master (
            hs_code TEXT PRIMARY KEY,
            arabic_name TEXT,
            description_en TEXT,
            duty_rate_pct REAL
        )"""
    )
    conn.execute(
        """CREATE TABLE hs_decision_ledger (
            client_id TEXT,
            raw_code TEXT,
            verified_code TEXT,
            arabic_name TEXT
        )"""
    )
    conn.executemany(
        "INSERT INTO hs_code_master VALUES (?, ?, ?, ?)",
        [(c, ar, en, 5.0) for (c, en, ar) in rows],
    )
    conn.commit()
    conn.close()
    return db


def _make_resolver(db: Path, reasoner: HSReasoner) -> HSResolver:
    # Pass explicit (unused) faiss paths; prefix-path tests never touch FAISS.
    return HSResolver(
        reasoner=reasoner,
        db_path=db,
        faiss_index_path=db,   # dummy — lazy-loaded only on reasoner path
        faiss_codes_path=db,
        confidence_threshold=0.80,
    )


# ---------------------------------------------------------------------------
# P1 fix #1 — prefix off-by-one
# ---------------------------------------------------------------------------
class TestPrefixOffByOne:
    """The declared code's OWN length must be queried. Previously skipped."""

    def test_8digit_declared_matches_at_len_8(self, tmp_path: Path) -> None:
        # One leaf under prefix `61082100`. Before the fix, `_longest_prefix_match`
        # queried lengths 7,6,5,4 and never 8 — so the single-leaf row at 8
        # digits was not found via an 8-digit prefix, only via shorter ones.
        db = _build_db(
            tmp_path,
            [
                ("610821001234", "Cotton bra, women's", "حمالة صدر قطنية"),
                ("610822000000", "Man-made-fibre bra", "حمالة صدر صناعية"),
            ],
        )
        resolver = _make_resolver(db, _FakeReasoner(rank_code="610821001234"))
        row = {"CustomsCommodityCode": "61082100", "Description": "cotton bra"}
        res = resolver.resolve(row)
        resolver.close()

        assert res.hs_code == "610821001234"
        assert res.path == PATH_PREFIX
        # Winning prefix length is 8 → top of CONF_PREFIX_BY_LEN table.
        assert res.confidence == pytest.approx(CONF_PREFIX_BY_LEN[8])

    def test_4digit_declared_matches_at_len_4(self, tmp_path: Path) -> None:
        db = _build_db(
            tmp_path, [("150930000000", "Extra-virgin olive oil", "زيت زيتون")]
        )
        resolver = _make_resolver(db, _FakeReasoner(rank_code="150930000000"))
        res = resolver.resolve({"CustomsCommodityCode": "1509", "Description": "olive oil"})
        resolver.close()
        assert res.hs_code == "150930000000"
        assert res.path == PATH_PREFIX


# ---------------------------------------------------------------------------
# P1 fix #2 — 25-row prefix LIMIT
# ---------------------------------------------------------------------------
class TestPrefixNoLimit:
    """Broad 4-digit prefixes used to drop candidates past the 25th row
    (lexicographic). The correct leaf frequently sat past the cutoff."""

    def test_ranker_sees_candidate_past_position_25(self, tmp_path: Path) -> None:
        # 40 leaves under `6104`. The "correct" one is lexicographically last
        # (6104_99_99). Pre-fix: LIMIT 25 would hide it; Ranker would never
        # see it and the resolver would accept a wrong code.
        leaves = [
            (f"6104{i:02d}{j:02d}0000", f"Cotton dress variant {i}-{j}", "")
            for i in range(10, 20) for j in range(10, 14)
        ]
        correct = "610499990000"
        leaves.append((correct, "Knitted cotton dress — correct leaf", ""))
        db = _build_db(tmp_path, leaves)

        captured: dict[str, Any] = {}

        class _Capturing(_FakeReasoner):
            def rank_candidates(self, payload: RankerInput) -> ReasonerResult:
                captured["codes"] = [c.hs_code for c in payload.candidates]
                return ReasonerResult(
                    hs_code=correct, confidence=0.9, rationale="picked last leaf",
                )

        resolver = _make_resolver(db, _Capturing(rank_code=correct))
        resolver.resolve({"CustomsCommodityCode": "6104", "Description": "knitted cotton dress"})
        resolver.close()

        assert correct in captured["codes"], (
            f"LIMIT 25 regression — correct leaf {correct} not passed to Ranker"
        )
        assert len(captured["codes"]) > 25


# ---------------------------------------------------------------------------
# P2 fix #4 — Ranker out-of-set code rejected
# ---------------------------------------------------------------------------
class TestOutOfSetRankerRejected:
    """If the Ranker returns a code NOT in the tied set, fall back to the
    first tied candidate with confidence capped at 0.60 (below the 0.80
    review threshold → auto-flagged)."""

    def test_hallucinated_code_is_rejected_and_flagged(self, tmp_path: Path) -> None:
        db = _build_db(
            tmp_path,
            [
                ("610821001111", "Cotton bra A", ""),
                ("610821002222", "Cotton bra B", ""),
            ],
        )
        # The reasoner returns a code NOT in the tied set.
        resolver = _make_resolver(
            db, _FakeReasoner(rank_code="999999999999", rank_confidence=0.95)
        )
        res = resolver.resolve(
            {"CustomsCommodityCode": "61082100", "Description": "cotton bra"}
        )
        resolver.close()

        # Must NOT have accepted the hallucinated code.
        assert res.hs_code != "999999999999"
        # Falls back to the first tied candidate (lexicographically smallest).
        assert res.hs_code == "610821001111"
        # Confidence capped at 0.60, below default 0.80 threshold → flagged.
        assert res.confidence <= 0.60
        assert res.flagged_for_review is True
        assert "out-of-set" in (res.rationale or "").lower()


# ---------------------------------------------------------------------------
# P1 fix #3 — _first_arabic_field PII guard
# ---------------------------------------------------------------------------
class TestArabicPIIGuard:
    AR_PRODUCT = "زيت زيتون بكر ممتاز"   # Extra-virgin olive oil
    AR_NAME = "محمد بن عبدالله"          # person name (PII)
    AR_CITY = "الرياض"                  # Riyadh
    AR_ADDRESS = "شارع الملك فهد ١٢٣"   # King Fahd Street 123

    def test_returns_allow_listed_arabic_description(self) -> None:
        row = {
            "Description": "olive oil",
            "ArabicDescription": self.AR_PRODUCT,
            "ConsigneeName": self.AR_NAME,
        }
        assert _first_arabic_field(row) == self.AR_PRODUCT

    def test_does_not_leak_arabic_from_consignee_name(self) -> None:
        row = {
            "Description": "olive oil",
            "ConsigneeName": self.AR_NAME,
            "City": self.AR_CITY,
            "Address": self.AR_ADDRESS,
        }
        # No allow-listed Arabic field present AND every Arabic-bearing field
        # is deny-listed → must return "" (will fall through to LLM translation).
        assert _first_arabic_field(row) == ""

    def test_description_ar_snake_case_is_allow_listed(self) -> None:
        row = {"description_en": "olive oil", "description_ar": self.AR_PRODUCT}
        assert _first_arabic_field(row) == self.AR_PRODUCT

    def test_latin_only_ignored(self) -> None:
        row = {
            "Description": "olive oil",
            "ArabicDescription": "not actually arabic",
        }
        assert _first_arabic_field(row) == ""

    def test_neutral_key_with_arabic_accepted(self) -> None:
        # A field that's neither allow- nor deny-listed. Pass 2 falls back to
        # any non-deny-listed Arabic value — better than nothing when the
        # merchant uses a custom column name.
        row = {
            "Description": "olive oil",
            "WayBillNo": "WB-123",
            "FreeFormLabel": self.AR_PRODUCT,
        }
        assert _first_arabic_field(row) == self.AR_PRODUCT

    def test_deny_list_wins_over_arabic_value_in_pass2(self) -> None:
        # "SenderName" matches deny (sender, name). Even though it's the only
        # Arabic value on the row, it must NOT be returned.
        row = {
            "Description": "olive oil",
            "SenderName": self.AR_NAME,
        }
        assert _first_arabic_field(row) == ""
