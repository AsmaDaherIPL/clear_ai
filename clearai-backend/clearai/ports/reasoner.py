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
class ComplexityHint:
    """Per-call signals describing how hard the LLM's task is likely to be.

    Computed deterministically by `clearai.services.complexity` from inputs
    the resolver already has (description length, Arabic-script ratio, FAISS
    top-1/top-2 score gap, candidate count). Lives in `ports/` so adapters
    can receive it without depending on `services/`. See ADR-010.

    Carries evidence, NOT policy. Escalation decisions are made by the
    resolver using explicit, logged rules — not by the hint itself.
    """

    token_count: int                  # whitespace-split word count
    arabic_ratio: float               # fraction of letters that are Arabic (0..1)
    has_chinese: bool                 # whether CJK ideographs were detected
    faiss_top1_score: float | None    # cosine similarity of top FAISS hit, or None
    faiss_top2_gap: float | None      # top1 - top2, or None if <2 candidates
    candidate_count: int              # candidates passed (prefix tie width or FAISS K)


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
    complexity_hint: ComplexityHint | None = None


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
    complexity_hint: ComplexityHint | None = None


@dataclass(frozen=True)
class ReasonerResult:
    """Output of the three classification tasks. Shape is uniform on purpose —
    the resolver treats all three as evidence producers gated by confidence."""

    hs_code: str                 # for translate_to_arabic, this is echoed / empty
    confidence: float            # in [0.0, 1.0]
    rationale: str               # short natural-language justification
    agrees_with_naqel: bool | None = None    # only set by infer_hs_code
    arabic_description: str = ""             # only set by translate_to_arabic
    model_used: str = ""                     # which tier ran this call
    tokens_in: int = 0                       # prompt tokens consumed
    tokens_out: int = 0                      # completion tokens emitted


@dataclass(frozen=True)
class JustificationInput:
    """Bundle of everything a justifier needs to produce a 7-section
    classification rationale (TEST_CASES.md Case 001 format).

    Passed as a single object (not many positional args) so adding fields
    later — e.g. customs-broker notes, duty exemptions — doesn't churn
    every caller.
    """

    hs_code: str
    description_en: str
    customs_description_en: str = ""
    customs_description_ar: str = ""
    duty_rate_pct: float | None = None
    origin: str = ""
    destination: str = ""
    value: float | None = None
    currency: str = ""
    faiss_candidates: Sequence[Candidate] = field(default_factory=tuple)


@dataclass(frozen=True)
class RationaleStep:
    """One rung of the v5 3-step narrative (Chapter → Heading → Subheading).

    Each step cites a WCO GIR or ZATCA note, gives both a technical detail and
    a plain-English paraphrase, and is suitable for non-specialist review.
    """

    title: str          # e.g. "Chapter 49 — Printed matter"
    detail: str         # one-sentence technical explanation
    plain_explanation: str  # plain-English rephrasing ("What this means: ...")
    reference: str      # e.g. "WCO GIR 1", "GIR 3(a)", "ZATCA Note 4901"


@dataclass(frozen=True)
class EvidenceSnippet:
    """Justifier-produced citation for the "Sources cited" UI block.

    Attached to a specific FAISS candidate by hs_code so the UI can merge it
    with the structured evidence trail.
    """

    hs_code: str        # which FAISS candidate this snippet belongs to
    source: str         # "ZATCA Tariff" | "WCO Notes" | "Bayan ruling"
    title: str          # human-readable title for the card header
    snippet: str        # 1-2 sentence quotation / paraphrase


@dataclass(frozen=True)
class ClosestAlternativeResult:
    """Output of the standalone closest-alternative Haiku call.

    Carries the rejected FAISS-competitor's code and a one-sentence plain-
    English discriminator. Separate from JustificationResult so the UI can
    render the "Why not a similar code?" card even when the big Sonnet
    justifier is skipped (e.g. direct path with code-only input).
    """

    hs_code: str
    why_not: str
    model_used: str = ""
    tokens_in: int = 0
    tokens_out: int = 0


@dataclass(frozen=True)
class JustificationResult:
    """Structured output — 7-section Case 001 format PLUS v5 UI extensions
    (plain summary, 3-step narrative, evidence snippets). Delivered in a
    single LLM call so latency stays low and the rationale stays coherent.

    Each list field has 2-5 entries in practice (prompt-enforced, not
    schema-enforced). `rationale_steps` is exactly 3; `evidence_snippets`
    is 2-5.
    """

    product_name: str
    understanding_the_product: str
    relevant_tariff_headings: tuple[str, ...]
    exclusions_of_other_subheadings: tuple[str, ...]
    wco_hs_explanatory_notes: str
    correct_classification: str
    conclusion: str
    # v5 UI additions — all optional at the dataclass level so a degraded
    # model response (missing fields) still yields a usable result rather
    # than dropping the whole justification.
    plain_summary: str = ""
    rationale_steps: tuple[RationaleStep, ...] = ()
    evidence_snippets: tuple[EvidenceSnippet, ...] = ()
    # Non-expert "Why not this one?" card. Justifier picks the nearest
    # FAISS competitor it rejected and writes ONE plain sentence (no GRI
    # citation, no heading number) explaining the discriminating fact.
    # Empty when the justifier had no viable competitor to compare against.
    closest_alternative_code: str = ""
    closest_alternative_why_not: str = ""
    model_used: str = ""
    tokens_in: int = 0
    tokens_out: int = 0


# ---------------------------------------------------------------------------
# Interface
# ---------------------------------------------------------------------------
class HSReasoner(ABC):
    """Abstract base for any LLM provider backing ClearAI's four LLM-touching
    tasks: translate, rank, infer, justify.

    Implementations must route each method to its declared model tier and must
    return typed result dataclasses — never raw provider responses. All JSON
    parsing, validation, and retry logic lives inside the implementation.
    """

    @abstractmethod
    def refine_description_en(
        self,
        *,
        merchant_description: str,
        zatca_description: str,
    ) -> ReasonerResult:
        """Produce a better English product line by merging the merchant's
        own words with the ZATCA tariff description for the resolved code.

        The goal is to keep the MERCHANT'S tone and vocabulary level but
        enrich with the tariff-precise nouns the ZATCA description uses.
        No invention, no marketing language. Routes to TRANSLATION_MODEL
        (Haiku) because it's a constrained rewrite task, not reasoning.

        Returns ReasonerResult with `rationale` carrying the refined EN
        description. `hs_code` and `confidence` are echoed / irrelevant.
        """
        raise NotImplementedError

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

    @abstractmethod
    def build_closest_alternative(
        self,
        *,
        picked_code: str,
        picked_description_en: str,
        faiss_candidates: Sequence[Candidate],
    ) -> "ClosestAlternativeResult | None":
        """Pick the nearest FAISS competitor to the resolved code and write a
        single plain-English sentence explaining the discriminating fact.

        Split out of `build_justification` so it can route to Haiku (cheap,
        fast, focused) instead of occupying tokens inside the Sonnet 7-section
        JSON. Runs in parallel with translate/refine for zero wall-time cost.

        Returns None on any failure — the UI simply hides the "Why not a
        similar code?" card rather than showing a half-finished one.
        """
        raise NotImplementedError

    @abstractmethod
    def build_justification(
        self, payload: "JustificationInput"
    ) -> "JustificationResult | None":
        """Produce a 7-section structured classification rationale.

        Called after a code has already been resolved (by any path) and the
        caller wants the Case 001 justification format — typically the web UI
        or a review report. Not called during batch CLI runs which only need
        code + confidence.

        Routes to REASONER_MODEL (the top tier). Returns None on any failure;
        callers must tolerate absence (the code is still valid without it).
        """
        raise NotImplementedError
