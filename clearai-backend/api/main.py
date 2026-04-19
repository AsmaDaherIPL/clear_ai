"""ClearAI HTTP surface — FastAPI app.

Endpoints (V1 — two only; keep the surface small):

    GET  /api/health    — liveness + config echo (no auth)
    POST /api/resolve   — resolve one line item, returns code + justification

Rules of engagement:
  - Sync handlers; the resolver + FAISS + Anthropic SDK are all blocking.
    FastAPI runs sync routes on a threadpool, which is the correct pattern
    here until latency data says otherwise (tracker/ARCHITECTURE.md notes
    "Not async until data justifies it").
  - Every handler tolerates partial failure. A failed resolve returns 200
    with `path="failed"` and `error` populated — never 5xx — so the UI can
    render a friendly banner.
  - CORS: opens to the frontend's dev port (3000) and any configured prod
    origin. Prod origin is wired via ANTHROPIC_* style env later.

Run:
    .venv/bin/uvicorn api.main:app --port 8787 --reload
"""

from __future__ import annotations

import logging
import os

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from api.deps import get_reasoner, get_resolver, lifespan
from api.schemas import (
    EvidenceItem,
    HealthResponse,
    Justification as JustificationSchema,
    ResolveRequest,
    ResolveResponse,
)
from clearai import config
from clearai.ports.reasoner import HSReasoner, JustificationInput
from clearai.services.hs_resolver import HSResolver

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
logger = logging.getLogger("clearai.api")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(
    title="ClearAI",
    version="0.1.0",
    description="HS code resolution + Bayan XML generation for Saudi customs.",
    lifespan=lifespan,
)

# CORS — the frontend runs on 3000 in dev; override via env for prod/preview.
_DEFAULT_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"]
_CORS_ORIGINS = [
    o.strip()
    for o in os.getenv("CLEARAI_CORS_ORIGINS", ",".join(_DEFAULT_ORIGINS)).split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


# ---------------------------------------------------------------------------
# GET /api/health
# ---------------------------------------------------------------------------
@app.get("/api/health", response_model=HealthResponse, tags=["ops"])
def health() -> HealthResponse:
    """Liveness + non-secret config echo. Operators use this to confirm
    Foundry routing is active (by checking `anthropic_base_url`) without
    needing to read logs."""
    return HealthResponse(
        status="ok",
        version=app.version,
        anthropic_base_url=config.ANTHROPIC_BASE_URL or "",
        db_path=str(config.DB_PATH),
        faiss_index_path=str(config.FAISS_INDEX_PATH),
        faiss_index_present=config.FAISS_INDEX_PATH.exists(),
    )


# ---------------------------------------------------------------------------
# POST /api/resolve
# ---------------------------------------------------------------------------
@app.post("/api/resolve", response_model=ResolveResponse, tags=["resolve"])
def resolve(
    req: ResolveRequest,
    resolver: HSResolver = Depends(get_resolver),
    reasoner: HSReasoner = Depends(get_reasoner),
) -> ResolveResponse:
    """Resolve one merchant line into a precise 12-digit Saudi HS code plus
    a structured 7-section justification and the FAISS evidence trail.

    Returns 200 even on classification failure — check `path` and `error`.
    Only raises 400 when the request is unusable on its face (no
    description AND no usable hs_code)."""

    # Input guardrail: need SOMETHING to classify from.
    desc = (req.description or "").strip()
    code = (req.hs_code or "").strip()
    if not desc and not code:
        raise HTTPException(
            status_code=400,
            detail="Provide at least one of: `description` or `hs_code`.",
        )
    # Only digits allowed for hs_code
    if code and not code.isdigit():
        raise HTTPException(
            status_code=400,
            detail=f"`hs_code` must be digits only; got {code!r}",
        )

    # Build the row shape the resolver expects (mirrors invoice row keys).
    row = {
        "Description": desc,
        "CustomsCommodityCode": code,
        # Extra context — harmless if the resolver doesn't use it today
        "CurrencyCode": req.currency,
        "CountryofManufacture": req.origin,
    }

    logger.info("POST /api/resolve  description=%r  code=%r", desc[:60], code)
    resolution = resolver.resolve(row=row)

    # Master row lookup (customs description + duty rate for the UI card).
    master = resolver.master_row(resolution.hs_code) if resolution.hs_code else None

    # FAISS evidence — always computed from the merchant description so the
    # UI can render the top-K trail even on Path 1 (where the resolver didn't
    # hit FAISS) and even on Path 3 failures (so reviewers see candidates).
    evidence_cands = resolver.faiss_evidence(desc) if desc else ()
    evidence_items = [
        EvidenceItem(
            rank=i + 1,
            score=round(c.score or 0.0, 4),
            hs_code=c.hs_code,
            description_en=c.description_en,
            description_ar=c.description_ar,
            duty_rate_pct=c.duty_rate,
        )
        for i, c in enumerate(evidence_cands)
    ]

    # Justification — best effort. If REASONER_MODEL is out of credits, the
    # build_justification call returns None and we ship without it.
    justification: JustificationSchema | None = None
    if resolution.hs_code and resolution.path != "failed":
        jres = reasoner.build_justification(
            JustificationInput(
                hs_code=resolution.hs_code,
                description_en=desc,
                customs_description_en=(master or {}).get("description_en", ""),
                customs_description_ar=(master or {}).get("arabic_name", ""),
                duty_rate_pct=(master or {}).get("duty_rate_pct"),
                origin=req.origin,
                destination=req.destination,
                value=req.value,
                currency=req.currency,
                faiss_candidates=evidence_cands,
            )
        )
        if jres is not None:
            justification = JustificationSchema(
                product_name=jres.product_name,
                understanding_the_product=jres.understanding_the_product,
                relevant_tariff_headings=list(jres.relevant_tariff_headings),
                exclusions_of_other_subheadings=list(jres.exclusions_of_other_subheadings),
                wco_hs_explanatory_notes=jres.wco_hs_explanatory_notes,
                correct_classification=jres.correct_classification,
                conclusion=jres.conclusion,
            )

    return ResolveResponse(
        hs_code=resolution.hs_code,
        customs_description_en=(master or {}).get("description_en", ""),
        customs_description_ar=(master or {}).get("arabic_name", ""),
        duty_rate_pct=(master or {}).get("duty_rate_pct"),
        confidence=round(resolution.confidence, 4),
        path=resolution.path,  # type: ignore[arg-type]
        model_used=resolution.model_used,
        flagged_for_review=resolution.flagged_for_review,
        agrees_with_naqel=resolution.agrees_with_naqel,
        naqel_bucket_hint=resolution.naqel_bucket_hint,
        rationale=resolution.rationale,
        error=resolution.error,
        justification=justification,
        evidence=evidence_items,
    )
