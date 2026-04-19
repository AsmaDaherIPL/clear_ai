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

    description: str = Field(
        default="",
        description="Free-text product description (English). "
                    "May be empty when hs_code is a complete 12-digit master code.",
        max_length=2000,
    )
    hs_code: str = Field(
        default="",
        description="Merchant-declared HS code. May be empty, partial (4-11 digits), "
                    "or a full 12-digit Saudi code. Digits only.",
        max_length=12,
    )
    value: float | None = Field(
        default=None,
        description="Declared value. Optional; used downstream for HV/LV gating.",
        ge=0,
    )
    currency: str = Field(
        default="USD",
        description="ISO-4217 currency code of `value`. Defaults to USD.",
        min_length=3,
        max_length=3,
    )
    origin: str = Field(
        default="",
        description="ISO-2 country shipped from. Optional but strongly recommended.",
        max_length=2,
    )
    destination: str = Field(
        default="SA",
        description="ISO-2 destination country. Always SA for the Saudi pipeline.",
        max_length=2,
    )


# ---------------------------------------------------------------------------
# Response — evidence
# ---------------------------------------------------------------------------
class EvidenceItem(BaseModel):
    """One row of the FAISS top-K evidence trail."""

    rank: int
    score: float
    hs_code: str
    description_en: str
    description_ar: str
    duty_rate_pct: float | None = None


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


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"] = "ok"
    version: str
    anthropic_base_url: str = Field(
        default="",
        description="Echoed so operators can confirm Foundry routing is active.",
    )
    db_path: str
    faiss_index_path: str
    faiss_index_present: bool
