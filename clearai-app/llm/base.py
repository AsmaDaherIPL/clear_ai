"""
HSReasoner — abstract interface for the three LLM-touching tasks in ClearAI.

V1 has one concrete implementation (api_backend.py, Anthropic-only). The interface
exists so the resolver is decoupled from the provider: if a future deployment
genuinely justifies a second backend (offline inference, a different vendor),
it's an additive change — no resolver churn.

Each method maps to one of the three model tiers declared in config.py. See
tracker/ARCHITECTURE.md ADR-004 for the rationale behind the three-tier split.

  translate_to_arabic  →  TRANSLATION_MODEL  (Haiku   — cheapest tier)
  rank_candidates      →  RANKER_MODEL       (Sonnet  — middle tier)
  infer_hs_code        →  REASONER_MODEL     (Opus    — top tier)

All methods return typed result dataclasses carrying a confidence score so the
resolver can gate on CONFIDENCE_THRESHOLD. LLM failures raise ReasonerError —
callers decide whether to flag-for-review or retry.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Sequence


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------
class ReasonerError(RuntimeError):
    """Raised when an LLM call fails in a way the resolver must handle.

    Examples: provider API error, malformed JSON response, validation failure
    (e.g. returned code is not 12 digits). The resolver catches this to route
    the row to review.csv rather than crashing the batch.
    """


# ---------------------------------------------------------------------------
# Input / output shapes
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Candidate:
    """One HS-code candidate surfaced to the Ranker or Reasoner as evidence.

    Sources differ by path: prefix traversal yields candidates from HSCodeMaster
    by longest-prefix match; FAISS yields semantic neighbours by cosine similarity.
    The `source` tag lets the LLM weigh signals differently if it chooses.
    """

    hs_code: str                # 12-digit normalized Saudi code
    description_en: str         # English name from master
    description_ar: str = ""    # Arabic name from master (if present)
    duty_rate: float | None = None
    source: str = "prefix"      # "prefix" | "faiss" | "ledger_hint"
    score: float | None = None  # cosine similarity (faiss) or prefix length


@dataclass(frozen=True)
class RankerInput:
    """Evidence bundle for the ranking task.

    Used when prefix traversal produced multiple plausible candidates and we
    need a comparison judgement to pick one.
    """

    description_en: str
    description_ar: str = ""
    description_cn: str = ""
    declared_code: str = ""
    candidates: Sequence[Candidate] = field(default_factory=tuple)


@dataclass(frozen=True)
class ReasonerInput:
    """Evidence bundle for the hardest path — full inference from description.

    Called when deterministic paths fail entirely or produce conflicting signals.
    Naqel's bucket hint is passed as advisory context, not as the answer key
    (see ADR-007).
    """

    description_en: str
    description_ar: str = ""
    description_cn: str = ""
    declared_code: str = ""                  # merchant-declared, may be partial/wrong
    faiss_candidates: Sequence[Candidate] = field(default_factory=tuple)
    prefix_candidates: Sequence[Candidate] = field(default_factory=tuple)
    naqel_bucket_hint: str | None = None     # e.g. "Naqel historically declares 620442000000 for items like this"


@dataclass(frozen=True)
class ReasonerResult:
    """Output of any of the three tasks. Shape is uniform on purpose — the
    resolver treats all three as evidence producers gated by confidence."""

    hs_code: str                 # for translate_to_arabic, this is echoed / empty
    confidence: float            # in [0.0, 1.0]
    rationale: str               # short natural-language justification
    agrees_with_naqel: bool | None = None    # only set by infer_hs_code
    arabic_description: str = ""             # only set by translate_to_arabic
    model_used: str = ""                     # which tier ran this call


# ---------------------------------------------------------------------------
# Interface
# ---------------------------------------------------------------------------
class HSReasoner(ABC):
    """Abstract base for any LLM provider backing ClearAI's three tasks.

    Implementations must route each method to its declared model tier and must
    return ReasonerResult — never raw provider responses. All JSON parsing,
    validation, and retry logic lives inside the implementation.
    """

    @abstractmethod
    def translate_to_arabic(self, description_en: str) -> ReasonerResult:
        """Translate an English product description to Saudi tariff Arabic.

        Called when HSCodeMaster has no Arabic name for a resolved code and
        the invoice row didn't supply one either. Routes to TRANSLATION_MODEL.

        Returns ReasonerResult with `arabic_description` populated. `hs_code`
        is echoed empty. Confidence reflects translation quality, not code
        correctness.
        """
        raise NotImplementedError

    @abstractmethod
    def rank_candidates(self, payload: RankerInput) -> ReasonerResult:
        """Pick the best HS code from a shortlist of prefix-matched candidates.

        Called when the longest-prefix-wins traversal returns multiple rows
        with the same prefix length and we need a comparison judgement to
        break the tie. Routes to RANKER_MODEL.

        Returns ReasonerResult with `hs_code` = chosen candidate. Confidence
        reflects how clearly the description matches the chosen one over the
        alternatives.
        """
        raise NotImplementedError

    @abstractmethod
    def infer_hs_code(self, payload: ReasonerInput) -> ReasonerResult:
        """Infer a 12-digit Saudi HS code from description + all evidence.

        The hardest path — runs only when deterministic resolution has failed
        (no usable declared code, no confident prefix match). Aggregates FAISS
        candidates, prefix candidates, and Naqel's bucket hint as evidence,
        and returns a precise classification with an explicit flag for whether
        the chosen code agrees with Naqel's historical bucket. Routes to
        REASONER_MODEL.

        Returns ReasonerResult with `hs_code`, `confidence`, `rationale`, and
        `agrees_with_naqel` populated.
        """
        raise NotImplementedError
