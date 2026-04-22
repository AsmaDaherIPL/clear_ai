"""Unit tests for clearai.services.complexity (ADR-010).

These tests lock in the deterministic-escalation contract: the `ComplexityHint`
must be computed identically for identical inputs, and each escalation rule
must fire on exactly the conditions documented in the rule's reason code.

No I/O, no LLM — pure functions only.
"""

from __future__ import annotations

from clearai.ports.reasoner import ComplexityHint
from clearai.services.complexity import (
    ARABIC_RATIO_THRESHOLD,
    FAISS_GAP_AMBIGUOUS,
    LONG_TOKEN_THRESHOLD,
    WIDE_TIE_CANDIDATES,
    as_log_dict,
    compute_complexity_hint,
    faiss_is_ambiguous,
    is_arabic_heavy,
    is_long,
    prefix_tie_is_wide,
    should_escalate_ranker,
)


# ---------------------------------------------------------------------------
# compute_complexity_hint — input shape + edge cases
# ---------------------------------------------------------------------------
class TestComputeComplexityHint:
    def test_empty_text_returns_zero_signals(self) -> None:
        hint = compute_complexity_hint(text="", candidate_count=0)
        assert hint.token_count == 0
        assert hint.arabic_ratio == 0.0
        assert hint.has_chinese is False
        assert hint.faiss_top1_score is None
        assert hint.faiss_top2_gap is None
        assert hint.candidate_count == 0

    def test_counts_whitespace_tokens(self) -> None:
        hint = compute_complexity_hint(text="cotton  blouse,  size   medium")
        assert hint.token_count == 4

    def test_arabic_ratio_pure_arabic(self) -> None:
        hint = compute_complexity_hint(text="قميص قطني")
        assert hint.arabic_ratio == 1.0

    def test_arabic_ratio_mixed(self) -> None:
        # 6 Latin letters, 4 Arabic letters → 40%
        hint = compute_complexity_hint(text="Cotton قميص")
        assert 0.39 < hint.arabic_ratio < 0.41

    def test_arabic_ratio_ignores_digits_and_punct(self) -> None:
        # Digits and % should not dilute the letter-only ratio.
        plain = compute_complexity_hint(text="Cotton")
        mixed = compute_complexity_hint(text="Cotton 100%")
        assert plain.arabic_ratio == mixed.arabic_ratio == 0.0

    def test_has_chinese_detects_cjk(self) -> None:
        assert compute_complexity_hint(text="棉质衬衫").has_chinese is True
        assert compute_complexity_hint(text="cotton shirt").has_chinese is False

    def test_faiss_scores_populate_top1_and_gap(self) -> None:
        hint = compute_complexity_hint(
            text="whatever",
            candidate_scores=[0.91, 0.88, 0.70],
            candidate_count=3,
        )
        assert hint.faiss_top1_score == 0.91
        assert abs(hint.faiss_top2_gap - 0.03) < 1e-9  # type: ignore[operator]

    def test_faiss_single_score_sets_gap_to_none(self) -> None:
        hint = compute_complexity_hint(
            text="whatever",
            candidate_scores=[0.91],
            candidate_count=1,
        )
        assert hint.faiss_top1_score == 0.91
        assert hint.faiss_top2_gap is None

    def test_deterministic_same_inputs_same_output(self) -> None:
        a = compute_complexity_hint(text="cotton shirt", candidate_scores=[0.9, 0.8])
        b = compute_complexity_hint(text="cotton shirt", candidate_scores=[0.9, 0.8])
        assert a == b


# ---------------------------------------------------------------------------
# Derived predicates
# ---------------------------------------------------------------------------
class TestPredicates:
    @staticmethod
    def _hint(**overrides: object) -> ComplexityHint:
        base = {
            "token_count": 0,
            "arabic_ratio": 0.0,
            "has_chinese": False,
            "faiss_top1_score": None,
            "faiss_top2_gap": None,
            "candidate_count": 0,
        }
        base.update(overrides)
        return ComplexityHint(**base)  # type: ignore[arg-type]

    def test_is_long_respects_threshold(self) -> None:
        assert is_long(self._hint(token_count=LONG_TOKEN_THRESHOLD)) is True
        assert is_long(self._hint(token_count=LONG_TOKEN_THRESHOLD - 1)) is False

    def test_is_arabic_heavy_respects_threshold(self) -> None:
        assert is_arabic_heavy(self._hint(arabic_ratio=ARABIC_RATIO_THRESHOLD)) is True
        assert is_arabic_heavy(self._hint(arabic_ratio=ARABIC_RATIO_THRESHOLD - 0.01)) is False

    def test_faiss_is_ambiguous_none_safe(self) -> None:
        # No gap known → not ambiguous (can't prove it).
        assert faiss_is_ambiguous(self._hint(faiss_top2_gap=None)) is False

    def test_faiss_is_ambiguous_fires_when_gap_small(self) -> None:
        assert faiss_is_ambiguous(self._hint(faiss_top2_gap=0.0)) is True
        assert faiss_is_ambiguous(self._hint(faiss_top2_gap=FAISS_GAP_AMBIGUOUS - 1e-6)) is True
        assert faiss_is_ambiguous(self._hint(faiss_top2_gap=FAISS_GAP_AMBIGUOUS + 0.01)) is False

    def test_prefix_tie_is_wide(self) -> None:
        assert prefix_tie_is_wide(self._hint(candidate_count=WIDE_TIE_CANDIDATES + 1)) is True
        assert prefix_tie_is_wide(self._hint(candidate_count=WIDE_TIE_CANDIDATES)) is False

    def test_as_log_dict_has_all_expected_keys(self) -> None:
        hint = self._hint(token_count=12, arabic_ratio=0.25)
        d = as_log_dict(hint)
        for key in (
            "token_count", "arabic_ratio", "has_chinese",
            "faiss_top1_score", "faiss_top2_gap", "candidate_count",
            "is_long", "is_arabic_heavy",
            "faiss_is_ambiguous", "prefix_tie_is_wide",
        ):
            assert key in d, f"missing log key: {key}"


# ---------------------------------------------------------------------------
# Escalation rules — the policy contract
# ---------------------------------------------------------------------------
class TestShouldEscalateRanker:
    THRESHOLD = 0.75

    def _hint(self, **overrides: object) -> ComplexityHint:
        base = {
            "token_count": 10,
            "arabic_ratio": 0.0,
            "has_chinese": False,
            "faiss_top1_score": None,
            "faiss_top2_gap": None,
            "candidate_count": 3,   # default: narrow tie
        }
        base.update(overrides)
        return ComplexityHint(**base)  # type: ignore[arg-type]

    def test_high_confidence_never_escalates(self) -> None:
        # Even with the ugliest hint, a confident Ranker stands.
        ugly = self._hint(
            token_count=200, arabic_ratio=0.9, candidate_count=20,
        )
        should, reason = should_escalate_ranker(
            hint=ugly, ranker_confidence=0.95,
            confidence_threshold=self.THRESHOLD,
        )
        assert should is False
        assert reason == "none"

    def test_r1_wide_tie_low_conf(self) -> None:
        hint = self._hint(candidate_count=WIDE_TIE_CANDIDATES + 1)
        should, reason = should_escalate_ranker(
            hint=hint, ranker_confidence=0.60,
            confidence_threshold=self.THRESHOLD,
        )
        assert should is True
        assert reason == "R1_wide_tie_low_conf"

    def test_r2_long_arabic_low_conf(self) -> None:
        hint = self._hint(
            token_count=LONG_TOKEN_THRESHOLD + 5,
            arabic_ratio=ARABIC_RATIO_THRESHOLD + 0.1,
        )
        should, reason = should_escalate_ranker(
            hint=hint, ranker_confidence=0.60,
            confidence_threshold=self.THRESHOLD,
        )
        assert should is True
        assert reason == "R2_long_arabic_low_conf"

    def test_low_conf_alone_is_not_enough(self) -> None:
        # Short, Latin, narrow tie — just low conf on an easy case doesn't
        # escalate; that would be overreach and blow the LLM budget.
        hint = self._hint()
        should, reason = should_escalate_ranker(
            hint=hint, ranker_confidence=0.60,
            confidence_threshold=self.THRESHOLD,
        )
        assert should is False
        assert reason == "none"

    def test_long_english_alone_does_not_escalate(self) -> None:
        # Rule R2 requires Arabic-heavy AND long — not one or the other.
        hint = self._hint(token_count=LONG_TOKEN_THRESHOLD + 50, arabic_ratio=0.0)
        should, reason = should_escalate_ranker(
            hint=hint, ranker_confidence=0.60,
            confidence_threshold=self.THRESHOLD,
        )
        assert should is False
