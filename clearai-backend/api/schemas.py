"""Request / response schemas for the ClearAI HTTP surface.

Pydantic v2. These are the ONLY shapes the frontend is allowed to rely on —
the internal `Resolution` / `Candidate` dataclasses may evolve; the API
contract stays stable.

Design notes:
- `ResolveRequest.description` is optional at the schema level but at least
  one of (description, hs_code) must be populated; the router enforces this
  rather than the schema so the error message is user-friendly.
- `ResolveResponse.justification` mirrors the 7-section Case 001 shape from
  tracker/TEST_CASES.md — the frontend renders these sections in fixed order.
- `EvidenceItem` is a trimmed `Candidate` (drops the discriminated-source
  union internal reasoning uses) for deterministic JSON output.
- v5 UI fields (`trace_id`, `plain_summary`, `rationale_steps`, `stages`,
  `meta`, `product_description_ar`) are always populated on a successful
  resolve so the frontend never has to fallback.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Request
# ---------------------------------------------------------------------------
class ResolveRequest(BaseModel):
    """One merchant line item awaiting HS classification.

    Matches the 5-line test-case input format from TEST_CASES.md:
    Description / HS code / Value / Origin / Destination.
    """

    description: str = Field(default="", max_length=2000)
    hs_code: str = Field(default="", max_length=12)
    value: float | None = Field(default=None, ge=0)
    currency: str = Field(default="USD", min_length=3, max_length=3)
    origin: str = Field(default="", max_length=2)
    destination: str = Field(default="SA", max_length=2)
    # When False (default), skip the ~14s Sonnet justifier call. The UI
    # fetches the full justification on-click via /api/justify. This makes
    # the default classify feel snappy (~5s) while preserving the rich
    # 7-section rationale as a progressive disclosure.
    with_justification: bool = False


class JustifyRequest(BaseModel):
    """On-click backing for the 'Full customs justification' accordion.

    Re-hits the Sonnet justifier for a previously-resolved code, returning
    ONLY the justification payload so the UI can merge it into the existing
    result card without replacing other fields (ladder, closest_alt, etc.)."""
    hs_code: str = Field(min_length=1, max_length=12)
    description: str = Field(default="", max_length=2000)
    value: float | None = Field(default=None, ge=0)
    currency: str = Field(default="USD", min_length=3, max_length=3)
    origin: str = Field(default="", max_length=2)
    destination: str = Field(default="SA", max_length=2)


class JustifyResponse(BaseModel):
    """Just the justification-shaped payload. Frontend merges into the
    existing ResolveResponse state — it doesn't replace it."""
    hs_code: str
    justification: "Justification | None" = None
    rationale_steps: list["RationaleStep"] = Field(default_factory=list)
    evidence: list["EvidenceItem"] = Field(default_factory=list)
    duration_ms: int = 0
    tokens_in: int = 0
    tokens_out: int = 0


class FeedbackRequest(BaseModel):
    """Backing for the 'Flag error' action in HSResultCard."""
    trace_id: str
    hs_code: str
    reason: str = Field(default="", max_length=2000)


class ReclassifyRequest(BaseModel):
    """Backing for the 'Pick →' action in the process panel. Re-runs the
    justification against a user-picked alternative code."""
    trace_id: str
    hs_code: str = Field(min_length=1, max_length=12)
    description: str = Field(default="", max_length=2000)


class BayanXMLRequest(BaseModel):
    """Backing for 'Generate ZATCA integration XML' button."""
    trace_id: str = ""
    hs_code: str = Field(min_length=1, max_length=12)
    description_en: str = ""
    description_ar: str = ""
    duty_rate_pct: float | None = None
    value: float | None = None
    currency: str = "USD"
    origin: str = ""
    destination: str = "SA"


# ---------------------------------------------------------------------------
# Response — evidence
# ---------------------------------------------------------------------------
class EvidenceItem(BaseModel):
    """One row of the FAISS top-K evidence trail.

    v5 UI uses `source` / `title` / `snippet` for the 'Sources cited' block.
    When the justifier hasn't produced a snippet for a given candidate, the
    API synthesises a default from the FAISS metadata so the UI never sees
    an empty card.
    """

    rank: int
    score: float
    hs_code: str
    description_en: str
    description_ar: str
    duty_rate_pct: float | None = None
    source: str = "ZATCA Tariff"
    title: str = ""
    snippet: str = ""


# ---------------------------------------------------------------------------
# Response — justification (Case 001 format, 7 labelled sections)
# ---------------------------------------------------------------------------
class Justification(BaseModel):
    """Structured classification rationale. Shape is fixed by TEST_CASES.md —
    the frontend renders these in this order with these exact headings."""

    product_name: str
    understanding_the_product: str
    relevant_tariff_headings: list[str]
    exclusions_of_other_subheadings: list[str]
    wco_hs_explanatory_notes: str
    correct_classification: str
    conclusion: str


class RationaleStep(BaseModel):
    """One rung of the v5 3-step narrative (Chapter → Heading → Subheading)."""
    title: str
    detail: str
    plain_explanation: str
    reference: str


class HSLadderRow(BaseModel):
    """One rung of the plain-English HS hierarchy ladder shown to non-experts.

    Populated directly from `hs_code_master` by digit-slice SQL lookups —
    no LLM involvement, no invention. `level` uses plain-English labels
    ("The big category", "The family", ...) rather than WCO jargon so
    non-specialists can follow the classification chain.
    """
    level: str               # e.g. "The big category" | "The family" | "The sub-family" | "Your exact item"
    code: str                # 2 / 4 / 6 / 12 digits
    description_en: str
    description_ar: str = ""


class ClosestAlternative(BaseModel):
    """The nearest FAISS competitor the justifier considered but rejected,
    with a ONE-SENTENCE plain-English reason why. Used by the 'Why not this
    one?' card in the simplified UI."""
    hs_code: str
    description_en: str
    description_ar: str = ""
    why_not: str             # one plain sentence, no GRI citation, no heading number


class PipelineStage(BaseModel):
    """Per-stage pipeline timing for the process panel.

    v5.1: key is an open string so the API can emit fine-grained sub-stages
    (e.g. `justify`, `translate_ar`, `refine_en`, `reason_infer`) without
    a schema migration. UI renders whatever the backend sends in order.
    """
    key: str
    label: str
    duration_ms: int


class ProcessMeta(BaseModel):
    """Diagnostic metadata. Rendered in the UI's "Dev view" panel — NOT a
    customer-facing quality signal.

    Cost intentionally omitted: Anthropic's SDK does not return a billed
    cost in the response, and hardcoding list prices would be misleading
    when traffic is billed through Azure Foundry. If/when Anthropic adds
    a live cost field to `Usage`, add it here.
    """
    model: str
    latency_ms: int
    tokens_in: int
    tokens_out: int
    candidates_considered: int   # # of FAISS candidates cited by the justifier
    candidates_retrieved: int    # # of FAISS candidates retrieved (= FAISS_TOP_K)


# ---------------------------------------------------------------------------
# Response — top-level
# ---------------------------------------------------------------------------
class ResolveResponse(BaseModel):
    """Everything the UI needs to render the result card + justification.

    Fields mirror `Resolution` plus the master-row lookups and FAISS evidence
    that the Case 001 format demands. When `path == "failed"`, most string
    fields are empty and `error` is populated; the UI should render a
    failure banner in that case.
    """

    # Core classification
    hs_code: str
    customs_description_en: str = ""
    customs_description_ar: str = ""
    duty_rate_pct: float | None = None

    confidence: float
    path: Literal["direct", "prefix", "reasoner", "failed"]
    model_used: str = ""
    flagged_for_review: bool = False
    agrees_with_naqel: bool | None = None
    naqel_bucket_hint: str | None = None
    rationale: str = ""
    error: str = ""

    justification: Justification | None = None
    evidence: list[EvidenceItem] = Field(default_factory=list)

    # v5 UI additions
    trace_id: str = ""
    plain_summary: str = ""
    product_description_en: str = ""
    product_description_ar: str = ""
    rationale_steps: list[RationaleStep] = Field(default_factory=list)
    stages: list[PipelineStage] = Field(default_factory=list)
    meta: ProcessMeta | None = None

    # Non-expert-friendly extensions (plain-English classification ladder
    # + "why not the closest competitor?" card). Always populated on a
    # successful resolve — ladder from DB, closest_alternative from justifier.
    hs_code_ladder: list[HSLadderRow] = Field(default_factory=list)
    closest_alternative: ClosestAlternative | None = None


# ---------------------------------------------------------------------------
# Other endpoints
# ---------------------------------------------------------------------------
class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"] = "ok"
    version: str
    anthropic_base_url: str = ""
    db_path: str
    faiss_index_path: str
    faiss_index_present: bool
    zatca_version: str = "2024.3"


class FeedbackResponse(BaseModel):
    ok: bool = True
    trace_id: str
    recorded_at: str  # ISO-8601 UTC


class BayanXMLResponse(BaseModel):
    xml: str
    filename: str
    trace_id: str = ""
