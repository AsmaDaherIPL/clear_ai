"""
complexity.py — deterministic, testable signals for tier-escalation decisions.

ClearAI routes LLM calls by task (translate/rank/infer) per ADR-004. Within a
task there are still hard and easy cases: a 3-word Latin-alphabet translation
is not the same workload as an 80-token Arabic-heavy technical description.
Model routers (e.g. Azure Foundry's `model-router`) solve this by picking a
model dynamically, but their decisions are opaque and non-auditable — a
non-starter for a pipeline whose output is a customs declaration (ADR-010).

Instead, ClearAI surfaces the signals the resolver already has as an explicit
`ComplexityHint` (defined in `clearai.ports.reasoner`). The resolver applies
deterministic, logged escalation rules (e.g. "Ranker below confidence
threshold on a wide tie → escalate to Reasoner tier"). Each escalation is a
line in the audit log, not a cloud heuristic.

This module is pure: no I/O, no LLM calls, no state.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Sequence

from clearai.ports.reasoner import ComplexityHint

# ---------------------------------------------------------------------------
# Thresholds — tuned for ClearAI's merchant-description workload, not
# general-purpose. Moving any of these materially changes the escalation
# rate and should be treated as a policy change (bump ADR-010).
# ---------------------------------------------------------------------------
LONG_TOKEN_THRESHOLD = 60                # translations/rankings "long" above this
ARABIC_RATIO_THRESHOLD = 0.30            # mixed- or Arabic-dominant input
FAISS_GAP_AMBIGUOUS = 0.03               # top1-top2 gap below this = ambiguous
WIDE_TIE_CANDIDATES = 5                  # prefix tie wider than this = hard rank

_WORD_RE = re.compile(r"\S+")
_ARABIC_BLOCK = re.compile(
    r"[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]"
)


# ---------------------------------------------------------------------------
# Derived predicates — kept here (not on the dataclass) so `ports/` stays pure.
# ---------------------------------------------------------------------------
def is_long(hint: ComplexityHint) -> bool:
    """True when the primary text exceeds the long-token threshold."""
    return hint.token_count >= LONG_TOKEN_THRESHOLD


def is_arabic_heavy(hint: ComplexityHint) -> bool:
    """True when Arabic script dominates or meaningfully mixes with Latin."""
    return hint.arabic_ratio >= ARABIC_RATIO_THRESHOLD


def faiss_is_ambiguous(hint: ComplexityHint) -> bool:
    """True when the top two FAISS candidates are near-tied. None-safe."""
    if hint.faiss_top2_gap is None:
        return False
    return hint.faiss_top2_gap < FAISS_GAP_AMBIGUOUS


def prefix_tie_is_wide(hint: ComplexityHint) -> bool:
    """True when a prefix tie has more than WIDE_TIE_CANDIDATES candidates."""
    return hint.candidate_count > WIDE_TIE_CANDIDATES


def as_log_dict(hint: ComplexityHint) -> dict[str, object]:
    """Flat dict for structured logging / audit trails."""
    return {
        "token_count": hint.token_count,
        "arabic_ratio": round(hint.arabic_ratio, 3),
        "has_chinese": hint.has_chinese,
        "faiss_top1_score": (
            round(hint.faiss_top1_score, 4)
            if hint.faiss_top1_score is not None
            else None
        ),
        "faiss_top2_gap": (
            round(hint.faiss_top2_gap, 4)
            if hint.faiss_top2_gap is not None
            else None
        ),
        "candidate_count": hint.candidate_count,
        "is_long": is_long(hint),
        "is_arabic_heavy": is_arabic_heavy(hint),
        "faiss_is_ambiguous": faiss_is_ambiguous(hint),
        "prefix_tie_is_wide": prefix_tie_is_wide(hint),
    }


# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------
def compute_complexity_hint(
    *,
    text: str,
    candidate_scores: Sequence[float] | None = None,
    candidate_count: int = 0,
) -> ComplexityHint:
    """Build a `ComplexityHint` from inputs the resolver already has.

    Args:
        text: The primary description being classified (richer of EN/CN/AR).
        candidate_scores: FAISS cosine scores, descending. Drives top1/gap.
            Pass `None` when no FAISS step was run (e.g. pure translation).
        candidate_count: Tie width (for prefix rank) or FAISS K (for reasoner).

    Returns:
        A fully populated `ComplexityHint`. Never raises on empty / malformed
        input — degrades to a hint describing "no signal".
    """
    normalized = _normalize(text)
    token_count = _count_tokens(normalized)
    arabic_ratio = _arabic_ratio(normalized)
    has_chinese = _contains_cjk(normalized)

    top1: float | None = None
    gap: float | None = None
    if candidate_scores:
        scores = [float(s) for s in candidate_scores]
        if len(scores) >= 1:
            top1 = scores[0]
        if len(scores) >= 2:
            gap = scores[0] - scores[1]

    return ComplexityHint(
        token_count=token_count,
        arabic_ratio=arabic_ratio,
        has_chinese=has_chinese,
        faiss_top1_score=top1,
        faiss_top2_gap=gap,
        candidate_count=int(candidate_count),
    )


# ---------------------------------------------------------------------------
# Escalation rules — deterministic, logged, per-call-site
# ---------------------------------------------------------------------------
def should_escalate_ranker(
    *,
    hint: ComplexityHint,
    ranker_confidence: float,
    confidence_threshold: float,
) -> tuple[bool, str]:
    """Decide whether a Ranker-tier result should be redone at Reasoner tier.

    Escalation triggers (any one is sufficient):
      R1. Ranker confidence below threshold AND wide tie (>5 candidates).
          Indicates the mid-tier conceded on a broad ambiguity.
      R2. Ranker confidence below threshold AND input is long AND Arabic-heavy.
          Known weak spot of the mid-tier on ClearAI's dataset.

    Returns:
        (should_escalate, reason_code). `reason_code` is one of
        {"none", "R1_wide_tie_low_conf", "R2_long_arabic_low_conf"} — logged
        so escalation frequency can be audited in production.
    """
    low_conf = ranker_confidence < confidence_threshold

    if low_conf and prefix_tie_is_wide(hint):
        return True, "R1_wide_tie_low_conf"

    if low_conf and is_long(hint) and is_arabic_heavy(hint):
        return True, "R2_long_arabic_low_conf"

    return False, "none"


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------
def _normalize(text: str) -> str:
    if not text:
        return ""
    # NFC so combined Arabic characters count consistently.
    return unicodedata.normalize("NFC", text).strip()


def _count_tokens(text: str) -> int:
    if not text:
        return 0
    return len(_WORD_RE.findall(text))


def _arabic_ratio(text: str) -> float:
    """Fraction of alphabetic chars that are Arabic script.

    Non-letters (digits, punctuation, whitespace) are excluded so
    "Cotton 100%" and "Cotton" produce the same ratio.
    """
    if not text:
        return 0.0
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return 0.0
    arabic_count = sum(1 for c in letters if _ARABIC_BLOCK.match(c))
    return arabic_count / len(letters)


def _contains_cjk(text: str) -> bool:
    if not text:
        return False
    for c in text:
        cp = ord(c)
        if 0x4E00 <= cp <= 0x9FFF:      # CJK Unified Ideographs
            return True
        if 0x3400 <= cp <= 0x4DBF:      # CJK Unified Ideographs Extension A
            return True
    return False
