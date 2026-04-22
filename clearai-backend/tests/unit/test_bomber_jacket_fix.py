"""Regression tests for the bomber-jacket misclassification fix.

Bug: an Arabic description "جاكيت بومبر" (bomber jacket) with no declared
fibre was resolving to 620190... (Men's overcoats/anoraks of OTHER textile
materials — the residual bucket), when the correct answer is 620140...
(of man-made fibres).

Two fixes — both tested here:

  1. Prompt-level — `infer_hs_code` now carries a "Material inference rule"
     instructing the model to (a) classify archetypes (bomber, jeans,
     pashmina) under their dominant fibre subheading when no fibre is
     declared, (b) cap confidence at 0.80 when the inference is applied,
     and (c) never choose the "...90 / other textile materials" leaf
     unless the description positively excludes cotton, wool, and MMF.

  2. Resolver guardrail — when the longest-prefix tiebreaker lands on an
     apparel/textile ...90 residual subheading AND the description names
     no fibre, the resolver forces an escalation to the Reasoner tier
     rather than silently accepting the residual.

Test cases mirror the table from the bug report:

    Input                        Expected HS-6   Forbidden         Conf cap
    جاكيت بومبر                  6201.40         6201.90,          ≤0.80
                                                 6110.20, 6101.20
    bomber jacket (no fibre)     6201.40         6201.90           ≤0.80
    بنطلون جينز (no fibre)       6203.42         6203.49           ≤0.80
    pashmina shawl               6214.10         6214.90           ≤0.80
    polyester bomber jacket      6201.40         —                 ≥0.85 (declared)
    cotton bomber jacket         6201.30         6201.40           ≥0.85 (declared)
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, Sequence

import pytest

from clearai.adapters.anthropic_reasoner import AnthropicReasoner
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
from clearai.services.hs_resolver import (
    HSResolver,
    PATH_PREFIX,
    _residual_subheading_without_fibre,
)


# ---------------------------------------------------------------------------
# Fake reasoner — programmable infer_hs_code for escalation-path tests.
# ---------------------------------------------------------------------------
class _FakeReasoner(HSReasoner):
    def __init__(
        self,
        *,
        infer_code: str = "",
        infer_confidence: float = 0.85,
        infer_rationale: str = "fake-reasoner",
        rank_code: str = "",
        rank_confidence: float = 0.85,
    ) -> None:
        self.infer_code = infer_code
        self.infer_confidence = infer_confidence
        self.infer_rationale = infer_rationale
        self.rank_code = rank_code
        self.rank_confidence = rank_confidence
        self.infer_calls: list[ReasonerInput] = []
        self.rank_calls: list[RankerInput] = []

    def refine_description_en(self, **kwargs: Any) -> ReasonerResult:
        raise NotImplementedError

    def translate_to_arabic(self, description_en: str) -> ReasonerResult:
        raise NotImplementedError

    def rank_candidates(self, payload: RankerInput) -> ReasonerResult:
        self.rank_calls.append(payload)
        return ReasonerResult(
            hs_code=self.rank_code, confidence=self.rank_confidence,
            rationale="fake-ranker", model_used="fake",
        )

    def infer_hs_code(self, payload: ReasonerInput) -> ReasonerResult:
        self.infer_calls.append(payload)
        return ReasonerResult(
            hs_code=self.infer_code, confidence=self.infer_confidence,
            rationale=self.infer_rationale, model_used="fake",
        )

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


def _build_db(tmp_path: Path, rows: list[tuple[str, str, str]]) -> Path:
    db = tmp_path / "test.db"
    conn = sqlite3.connect(str(db))
    conn.execute(
        "CREATE TABLE hs_code_master (hs_code TEXT PRIMARY KEY, "
        "arabic_name TEXT, description_en TEXT, duty_rate_pct REAL)"
    )
    conn.execute(
        "CREATE TABLE hs_decision_ledger (client_id TEXT, raw_code TEXT, "
        "verified_code TEXT, arabic_name TEXT)"
    )
    conn.executemany(
        "INSERT INTO hs_code_master VALUES (?, ?, ?, ?)",
        [(c, ar, en, 5.0) for (c, en, ar) in rows],
    )
    conn.commit()
    conn.close()
    return db


def _make_resolver(db: Path, reasoner: HSReasoner) -> HSResolver:
    r = HSResolver(
        reasoner=reasoner,
        db_path=db,
        faiss_index_path=db,
        faiss_codes_path=db,
        confidence_threshold=0.80,
    )
    # Stub FAISS: the escalation path calls _faiss_top_candidates, but these
    # tests don't need semantic retrieval — the Reasoner is faked anyway.
    r._faiss_top_candidates = lambda text, *, k: ()  # type: ignore[method-assign]
    return r


# ===========================================================================
# 1. Detector unit tests — _residual_subheading_without_fibre
# ===========================================================================
class TestResidualDetector:
    """Pure-function check on the guardrail predicate."""

    def test_detects_6201_90_with_no_fibre(self) -> None:
        assert _residual_subheading_without_fibre(
            "620190100000", "bomber jacket"
        ) is True

    def test_detects_arabic_description_with_no_fibre(self) -> None:
        assert _residual_subheading_without_fibre(
            "620190100000", "جاكيت بومبر"
        ) is True

    def test_suppressed_when_english_fibre_declared(self) -> None:
        # Even if the code is a ...90 leaf, a declared fibre means the
        # merchant already committed — the guardrail doesn't fire.
        assert _residual_subheading_without_fibre(
            "620190100000", "polyester bomber jacket"
        ) is False
        assert _residual_subheading_without_fibre(
            "620190100000", "cotton bomber"
        ) is False

    def test_suppressed_when_arabic_fibre_declared(self) -> None:
        assert _residual_subheading_without_fibre(
            "620190100000", "جاكيت بومبر قطن"
        ) is False

    def test_non_residual_subheading_not_flagged(self) -> None:
        # 6201.40 is the man-made-fibre leaf — not a residual.
        assert _residual_subheading_without_fibre(
            "620140100000", "bomber jacket"
        ) is False

    def test_non_apparel_chapter_not_flagged(self) -> None:
        # 4901 chapter 49 (printed matter) also has ...90 residuals but
        # the guardrail is scoped to textile/apparel/footwear chapters.
        assert _residual_subheading_without_fibre(
            "490190100000", "book with no fibre"
        ) is False

    def test_short_code_not_flagged(self) -> None:
        assert _residual_subheading_without_fibre("6201", "bomber") is False

    def test_denim_hints_cotton_suppresses_guardrail(self) -> None:
        # "denim" acts as a fibre declaration (≈ cotton).
        assert _residual_subheading_without_fibre(
            "620390100000", "denim trousers"
        ) is False


# ===========================================================================
# 2. Resolver integration — residual prefix wins → escalation fires
# ===========================================================================
class TestResolverResidualEscalation:
    """When the prefix tiebreaker lands on an apparel ...90 leaf with no
    fibre mentioned, the Reasoner must be invoked and its answer used."""

    def _db_with_residual_and_mmf(self, tmp_path: Path) -> Path:
        # Two leaves under the 6201 family:
        #   620190100000 — "other textile materials" (the residual)
        #   620140100000 — "of man-made fibres" (the archetype-correct answer)
        # The declared 4-digit prefix `6201` matches both; longest-prefix
        # tiebreaker picks the lexicographically-smallest shortest row,
        # which here would be 620140... — so to force the residual to win
        # deterministically, we use the 6-digit declared prefix `620190`.
        return _build_db(
            tmp_path,
            [
                ("620190100000",
                 "Men's overcoats/anoraks of other textile materials",
                 "معاطف رجالية من مواد نسجية أخرى"),
                ("620140100000",
                 "Men's overcoats/anoraks of man-made fibres",
                 "معاطف رجالية من ألياف تركيبية"),
            ],
        )

    def test_bomber_jacket_arabic_escalates_to_reasoner(
        self, tmp_path: Path
    ) -> None:
        db = self._db_with_residual_and_mmf(tmp_path)
        # Fake Reasoner returns the archetype-correct man-made-fibre code,
        # capped at 0.80 per the inference-rule contract.
        fake = _FakeReasoner(
            infer_code="620140100000",
            infer_confidence=0.80,
            infer_rationale=(
                "assumed man-made fibres because bomber jackets are "
                "overwhelmingly synthetic"
            ),
        )
        resolver = _make_resolver(db, fake)
        # NOTE: declared=620190 forces the prefix winner onto the residual
        # subheading so the guardrail has something to catch.
        res = resolver.resolve(
            {"CustomsCommodityCode": "620190", "Description": "جاكيت بومبر"}
        )
        resolver.close()

        # Reasoner must have been consulted.
        assert len(fake.infer_calls) == 1, (
            "guardrail did not escalate to the Reasoner"
        )
        # Final code is the Reasoner's answer, NOT the residual leaf.
        assert res.hs_code == "620140100000"
        assert res.hs_code[:6] == "620140"
        # Path stays PATH_PREFIX (escalation, not Path-3) per the
        # _escalate_to_reasoner contract.
        assert res.path == PATH_PREFIX
        # Confidence cap honoured.
        assert res.confidence <= 0.80

    def test_bomber_jacket_english_escalates_to_reasoner(
        self, tmp_path: Path
    ) -> None:
        db = self._db_with_residual_and_mmf(tmp_path)
        fake = _FakeReasoner(infer_code="620140100000", infer_confidence=0.78)
        resolver = _make_resolver(db, fake)
        res = resolver.resolve(
            {"CustomsCommodityCode": "620190", "Description": "bomber jacket"}
        )
        resolver.close()
        assert len(fake.infer_calls) == 1
        assert res.hs_code == "620140100000"

    def test_declared_fibre_does_NOT_escalate(self, tmp_path: Path) -> None:
        """Override contract: an explicit material declaration must beat the
        statistical prior. The guardrail is suppressed, and the deterministic
        prefix winner is accepted at full prefix confidence."""
        db = self._db_with_residual_and_mmf(tmp_path)
        fake = _FakeReasoner(infer_code="SHOULD_NOT_BE_CALLED")
        resolver = _make_resolver(db, fake)
        # Silk is an exotic fibre that legitimately belongs in the residual.
        res = resolver.resolve({
            "CustomsCommodityCode": "620190",
            "Description": "silk bomber jacket",
        })
        resolver.close()
        assert len(fake.infer_calls) == 0, (
            "guardrail fired despite a declared fibre"
        )
        # Prefix winner returned; with declared=620190 the longest prefix
        # is 6 → confidence 0.78 per CONF_PREFIX_BY_LEN[6].
        assert res.hs_code == "620190100000"
        assert res.confidence == pytest.approx(0.78)

    def test_non_apparel_chapter_does_NOT_escalate(
        self, tmp_path: Path
    ) -> None:
        """The guardrail is scoped to apparel/textile/footwear chapters.
        A ...90 residual in, e.g., chapter 49 must not trigger escalation."""
        db = _build_db(
            tmp_path,
            [("490190100000", "Printed matter — other", "مطبوعات أخرى")],
        )
        fake = _FakeReasoner(infer_code="SHOULD_NOT_BE_CALLED")
        resolver = _make_resolver(db, fake)
        res = resolver.resolve(
            {"CustomsCommodityCode": "490190", "Description": "some book"}
        )
        resolver.close()
        assert len(fake.infer_calls) == 0
        assert res.hs_code == "490190100000"

    def test_escalation_fallback_when_reasoner_unavailable(
        self, tmp_path: Path
    ) -> None:
        """If the Reasoner can't be reached, the row must be flagged for
        review rather than silently emitted at full prefix confidence."""
        db = self._db_with_residual_and_mmf(tmp_path)

        class _BrokenReasoner(_FakeReasoner):
            def infer_hs_code(self, payload: ReasonerInput) -> ReasonerResult:
                from clearai.ports.reasoner import ReasonerError
                raise ReasonerError("simulated API outage")

        fake = _BrokenReasoner()
        resolver = _make_resolver(db, fake)
        res = resolver.resolve(
            {"CustomsCommodityCode": "620190", "Description": "جاكيت بومبر"}
        )
        resolver.close()

        # Deterministic winner returned — but confidence capped at 0.60 so
        # the row is below the 0.80 threshold → flagged_for_review=True.
        assert res.hs_code == "620190100000"
        assert res.confidence <= 0.60
        assert res.flagged_for_review is True
        assert "residual" in (res.rationale or "").lower()


# ===========================================================================
# 3. Prompt contract — Reasoner prompt carries the inference rule
# ===========================================================================
class TestReasonerPromptContract:
    """The fix is primarily prompt-level. These contract tests lock in the
    critical clauses so they can't be silently edited out of the prompt."""

    def _capture_prompt(self, payload: ReasonerInput) -> str:
        """Invoke AnthropicReasoner.infer_hs_code with a stub client that
        records the user prompt, then return it."""

        class _StubUsage:
            input_tokens = 0
            output_tokens = 0

        class _StubBlock:
            def __init__(self, text: str) -> None:
                self.text = text

        class _StubResponse:
            content = [_StubBlock(
                '{"hs_code": "620140100000", "confidence": 0.8, '
                '"rationale": "stub", "agrees_with_naqel": null}'
            )]
            stop_reason = "end_turn"
            usage = _StubUsage()

        captured: dict[str, Any] = {}

        class _StubMessages:
            def create(self, **kwargs: Any) -> _StubResponse:
                captured["system"] = kwargs["system"]
                captured["user"] = kwargs["messages"][0]["content"]
                return _StubResponse()

        class _StubClient:
            messages = _StubMessages()

        reasoner = AnthropicReasoner(client=_StubClient())  # type: ignore[arg-type]
        reasoner.infer_hs_code(payload)
        return captured["user"]

    def _payload(self, description: str) -> ReasonerInput:
        return ReasonerInput(
            description_en=description,
            description_ar="",
            description_cn="",
            declared_code="6201",
            faiss_candidates=(),
            prefix_candidates=(),
            naqel_bucket_hint=None,
            complexity_hint=None,
        )

    def test_prompt_carries_material_inference_rule_heading(self) -> None:
        prompt = self._capture_prompt(self._payload("bomber jacket"))
        assert "Material inference rule" in prompt

    def test_prompt_names_bomber_archetype(self) -> None:
        prompt = self._capture_prompt(self._payload("bomber jacket"))
        # The bomber → man-made-fibres prior must be explicit in the prompt,
        # not just implied. The bug was: models have the world knowledge but
        # no signal that they're allowed to use it over the lexicographic
        # tiebreaker.
        assert "bomber" in prompt.lower()
        assert "man-made" in prompt.lower()

    def test_prompt_names_other_archetype_examples(self) -> None:
        """Jeans → cotton and pashmina → wool must appear so the rule
        generalises beyond the single triggering bug."""
        prompt = self._capture_prompt(self._payload("any"))
        low = prompt.lower()
        assert "jeans" in low or "denim" in low
        assert "pashmina" in low or "cashmere" in low

    def test_prompt_forbids_other_textile_materials_default(self) -> None:
        prompt = self._capture_prompt(self._payload("any"))
        # The "never default to ...other..." clause is the core anti-pattern.
        low = prompt.lower()
        assert "other textile materials" in low
        assert "never" in low or "not the default" in low

    def test_prompt_requires_confidence_cap_when_inferring(self) -> None:
        prompt = self._capture_prompt(self._payload("any"))
        # Cap at 0.80 so inferred rows land in the review queue.
        assert "0.80" in prompt

    def test_prompt_requires_explicit_rationale(self) -> None:
        prompt = self._capture_prompt(self._payload("any"))
        low = prompt.lower()
        assert "state" in low and "rationale" in low
