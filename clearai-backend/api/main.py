"""ClearAI HTTP surface — FastAPI app.

Endpoints (v5):

    GET  /api/health              — liveness + config echo
    POST /api/resolve             — resolve one line item (full v5 payload)
    POST /api/resolve/reclassify  — re-run justification against a chosen code
    POST /api/feedback            — flag a classification as incorrect
    POST /api/bayan/xml           — generate ZATCA integration XML

Rules of engagement:
  - Sync handlers; the resolver + FAISS + Anthropic SDK are all blocking.
  - Every /api/resolve handler tolerates partial failure. A failed resolve
    returns 200 with `path="failed"` and `error` populated — never 5xx —
    so the UI can render a friendly banner.
  - Justification + Arabic translation run in parallel (ThreadPoolExecutor)
    because they're independent API calls and this cuts wall time.
  - Every response carries a `trace_id` so the UI can correlate logs / feedback.

Run:
    .venv/bin/uvicorn api.main:app --port 8787 --reload
"""

from __future__ import annotations

import logging
import os
import secrets
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from api.deps import get_reasoner, get_resolver, lifespan
from api.routes_batch import router as batch_router
from api.schemas import (
    BayanXMLRequest,
    BayanXMLResponse,
    ClosestAlternative,
    EvidenceItem,
    FeedbackRequest,
    FeedbackResponse,
    HSLadderRow,
    HealthResponse,
    Justification as JustificationSchema,
    JustifyRequest,
    JustifyResponse,
    PipelineStage,
    ProcessMeta,
    RationaleStep as RationaleStepSchema,
    ReclassifyRequest,
    ResolveRequest,
    ResolveResponse,
)
from clearai import config
from clearai.ports.reasoner import (
    Candidate,
    HSReasoner,
    JustificationInput,
    ReasonerError,
)
from clearai.services import bayan_xml as _bayan
from clearai.services.bayan_xml import (
    ConsigneeInfo, DeclarationItem, WaybillDeclaration,
)
from clearai.services.hs_resolver import HSResolver, Resolution

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
logger = logging.getLogger("clearai.api")

# ZATCA tariff version — surfaced on the UI top bar. Update alongside master
# refreshes. When we wire a real tariff_version column in hs_code_master this
# should be read from there instead.
_ZATCA_TARIFF_VERSION = os.getenv("CLEARAI_ZATCA_VERSION", "2024.3")

# Feedback log location — append-only JSONL so the review queue can later
# ingest flagged rows without coordinating a DB migration.
_FEEDBACK_LOG_PATH = config.OUTPUT_DIR / "feedback.jsonl"

# Thread pool for parallel LLM calls (translate + justify). 4 workers is
# plenty; at steady state we issue at most 2 parallel calls per request.
_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="clearai-api")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(
    title="ClearAI",
    version="0.2.0",
    description="HS code resolution + Bayan XML generation for Saudi customs.",
    lifespan=lifespan,
)

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

# Batch XML pipeline — upload Excel, submit to Anthropic Batches API,
# download a ZIP of SaudiEDI XMLs + review.csv. See api/routes_batch.py.
app.include_router(batch_router)


# ---------------------------------------------------------------------------
# GET /api/health
# ---------------------------------------------------------------------------
@app.get("/api/health", response_model=HealthResponse, tags=["ops"])
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        version=app.version,
        anthropic_base_url=config.ANTHROPIC_BASE_URL or "",
        db_path=str(config.DB_PATH),
        faiss_index_path=str(config.FAISS_INDEX_PATH),
        faiss_index_present=config.FAISS_INDEX_PATH.exists(),
        zatca_version=_ZATCA_TARIFF_VERSION,
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
    a v5 payload (plain summary, 3-step rationale, pipeline stages, meta).

    Returns 200 even on classification failure — check `path` and `error`.
    """
    desc = (req.description or "").strip()
    code = (req.hs_code or "").strip()
    if not desc and not code:
        raise HTTPException(400, "Provide at least one of: `description` or `hs_code`.")
    if code and not code.isdigit():
        raise HTTPException(400, f"`hs_code` must be digits only; got {code!r}")

    trace_id = _new_trace_id()
    req_start = time.perf_counter()
    stage_times: dict[str, int] = {}

    # --- Stage 1: parse (trivial, measured for UI consistency) -----
    t0 = time.perf_counter()
    row = {
        "Description": desc,
        "CustomsCommodityCode": code,
        "CurrencyCode": req.currency,
        "CountryofManufacture": req.origin,
    }
    stage_times["parse"] = _ms_since(t0)

    logger.info("POST /api/resolve trace=%s description=%r code=%r",
                trace_id, desc[:60], code)

    # --- Stage 2: retrieve FAISS evidence ---------------------------
    t0 = time.perf_counter()
    evidence_cands = resolver.faiss_evidence(desc) if desc else ()
    stage_times["retrieve"] = _ms_since(t0)

    # --- Stages 3/4: rank + reason (bundled inside resolver.resolve) ----
    # We record the whole resolver call under a single "classify" timing.
    # The resolver has already logged per-tier wall-clocks via the adapter's
    # [timing] log line; those feed the ops dashboard, not the UI payload.
    t0 = time.perf_counter()
    resolution = resolver.resolve(row=row)
    classify_ms = _ms_since(t0)
    # Attribute to the path that did the heavy lifting. This is exact for
    # fast paths (direct/prefix, no LLM) and approximate when PATH_PREFIX
    # involved a ranker tie-break or an escalation — good enough for the UI
    # bottleneck display, because the resolver's own [timing] log shows the
    # true per-call split when you need it.
    if resolution.path in ("direct", "prefix") and not resolution.model_used:
        stage_times["classify"] = classify_ms
    else:
        stage_times["classify"] = classify_ms

    # --- Stage 5: resolve (master row lookup) -----------------------
    t0 = time.perf_counter()
    master = resolver.master_row(resolution.hs_code) if resolution.hs_code else None
    stage_times["resolve"] = _ms_since(t0)

    # --- Plain-English ladder from DB (no LLM) --------------------------
    ladder_rows: list[HSLadderRow] = []
    if resolution.hs_code:
        for rung in resolver.hs_code_ladder(resolution.hs_code):
            ladder_rows.append(HSLadderRow(**rung))

    # --- Stage 6: emit (parallel: justify + translate_to_arabic + refine) ---
    # Each future is wrapped in _timed() so we record real wall-clocks for
    # each LLM call. The max() of the three is the actual "emit" wall time
    # since they run concurrently; the sum tells us how much headroom we'd
    # recover by fully parallelising or ditching calls.
    t0 = time.perf_counter()
    justification_schema = None
    rationale_steps: list[RationaleStepSchema] = []
    closest_alt: ClosestAlternative | None = None
    plain_summary = ""
    tokens_in = resolution_tokens_in(resolution)
    tokens_out = resolution_tokens_out(resolution)
    product_description_ar = ""
    justify_ms = translate_ms = refine_ms = closest_alt_ms = 0

    # Skip the Sonnet justifier by default — it's the dominant latency cost
    # (~14s) and the UI fetches it on-click via /api/justify for the "Full
    # customs justification" accordion. Keep running it inline only when:
    #   (a) the caller explicitly opted in via with_justification=True
    #   (b) this was ALWAYS skipped regardless: direct path with code-only
    #       input (nothing meaningful to justify anyway).
    skip_justifier = True
    if req.with_justification and not (
        resolution.path == "direct" and not desc
    ):
        skip_justifier = False

    if resolution.hs_code and resolution.path != "failed":
        justify_future = None
        if not skip_justifier:
            justify_future = _POOL.submit(
                _timed,
                reasoner.build_justification,
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
                ),
            )
        translate_future = (
            _POOL.submit(_timed, _safe_translate, reasoner, desc) if desc else None
        )
        # Haiku-level rewrite: merchant wording + ZATCA tariff wording → one
        # refined EN line. Runs in parallel with the (much slower) Sonnet
        # justifier so it adds no wall-time. Skip entirely on the direct path
        # with no merchant description — we just use the ZATCA line verbatim.
        refine_future = None
        if desc:
            refine_future = _POOL.submit(
                _timed,
                _safe_refine_en,
                reasoner,
                desc,
                (master or {}).get("description_en", ""),
            )

        # Closest-alternative is a dedicated Haiku call (split out of the
        # Sonnet justifier to cut output tokens and improve one-liner quality).
        # Runs in parallel so it adds no wall-time. Skipped only when there
        # are no FAISS candidates (e.g. direct path with code-only input).
        closest_alt_future = None
        if evidence_cands and desc:
            closest_alt_future = _POOL.submit(
                _timed,
                _safe_closest_alt,
                reasoner,
                resolution.hs_code,
                (master or {}).get("description_en", ""),
                evidence_cands,
            )

        jres = None
        if justify_future is not None:
            jres, justify_ms = justify_future.result()
        if jres is not None:
            justification_schema = JustificationSchema(
                product_name=jres.product_name,
                understanding_the_product=jres.understanding_the_product,
                relevant_tariff_headings=list(jres.relevant_tariff_headings),
                exclusions_of_other_subheadings=list(jres.exclusions_of_other_subheadings),
                wco_hs_explanatory_notes=jres.wco_hs_explanatory_notes,
                correct_classification=jres.correct_classification,
                conclusion=jres.conclusion,
            )
            plain_summary = jres.plain_summary or _fallback_plain_summary(
                product_name=jres.product_name,
                hs_code=resolution.hs_code,
            )
            rationale_steps = [
                RationaleStepSchema(
                    title=s.title,
                    detail=s.detail,
                    plain_explanation=s.plain_explanation,
                    reference=s.reference,
                )
                for s in jres.rationale_steps
            ]
            tokens_in += jres.tokens_in
            tokens_out += jres.tokens_out
            snippets_by_code = {s.hs_code: s for s in jres.evidence_snippets}
        else:
            snippets_by_code = {}

        # Closest-alternative (standalone Haiku). Hydrate with master row
        # descriptions so the UI doesn't need a second roundtrip. Silently
        # drop if Haiku picked a code not in master.
        if closest_alt_future is not None:
            cares, closest_alt_ms = closest_alt_future.result()
            if cares is not None:
                alt_master = resolver.master_row(cares.hs_code)
                if alt_master is not None:
                    closest_alt = ClosestAlternative(
                        hs_code=cares.hs_code,
                        description_en=alt_master.get("description_en", ""),
                        description_ar=alt_master.get("arabic_name", ""),
                        why_not=cares.why_not,
                    )
                    tokens_in += cares.tokens_in
                    tokens_out += cares.tokens_out

        if translate_future is not None:
            tr, translate_ms = translate_future.result()
            if tr is not None:
                product_description_ar = tr.arabic_description
                tokens_in += tr.tokens_in
                tokens_out += tr.tokens_out

        # AR fallback: when there's no merchant description to translate
        # (code-only submission), reuse the master's canonical Arabic line so
        # the UI isn't left with an empty field.
        if not product_description_ar:
            product_description_ar = (master or {}).get("arabic_name", "") or ""

        if refine_future is not None:
            refined, refine_ms = refine_future.result()
            if refined is not None:
                product_description_en = refined.rationale  # refined line
                tokens_in += refined.tokens_in
                tokens_out += refined.tokens_out
            else:
                product_description_en = desc  # fall back to merchant input
        else:
            # No refine ran — code-only path. Use master EN description.
            product_description_en = (master or {}).get("description_en", "") or desc
    else:
        snippets_by_code = {}
        product_description_en = desc
        if not product_description_ar:
            product_description_ar = (master or {}).get("arabic_name", "") or ""

    stage_times["emit_wall"] = _ms_since(t0)
    stage_times["justify"] = justify_ms
    stage_times["translate_ar"] = translate_ms
    stage_times["refine_en"] = refine_ms
    stage_times["closest_alt"] = closest_alt_ms

    # --- Evidence assembly with justifier-produced snippets -------------
    evidence_items = []
    for i, c in enumerate(evidence_cands):
        snip = snippets_by_code.get(c.hs_code) if snippets_by_code else None
        evidence_items.append(
            EvidenceItem(
                rank=i + 1,
                score=round(c.score or 0.0, 4),
                hs_code=c.hs_code,
                description_en=c.description_en,
                description_ar=c.description_ar,
                duty_rate_pct=c.duty_rate,
                source=(snip.source if snip else "ZATCA Tariff"),
                title=(snip.title if snip else f"ZATCA Tariff — {c.hs_code}"),
                snippet=(snip.snippet if snip else c.description_en),
            )
        )

    # --- Fallbacks for plain_summary when justifier failed -------------
    if not plain_summary and resolution.hs_code:
        plain_summary = _fallback_plain_summary(
            product_name=desc or (master or {}).get("description_en", "item"),
            hs_code=resolution.hs_code,
        )

    # --- Meta panel ---------------------------------------------------
    total_ms = _ms_since(req_start)
    candidates_retrieved = len(evidence_cands)
    # "Considered" = how many FAISS candidates the justifier actually cited
    # (a specific hs_code appears in its `evidence_snippets`). Falls back to 0
    # on failure and to 3 when the justifier produced no snippets but the
    # UI still wants a sensible number.
    candidates_considered = (
        len({s for s in snippets_by_code.keys() if s})
        if snippets_by_code else 0
    )
    meta = ProcessMeta(
        model=resolution.model_used or config.REASONER_MODEL,
        latency_ms=total_ms,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        candidates_considered=candidates_considered,
        candidates_retrieved=candidates_retrieved,
    )

    # --- Pipeline stages list (UI cares about ORDER) -------------------
    # Each stage is a REAL measured wall-clock. justify/translate_ar/refine_en
    # run in parallel so their sum exceeds emit_wall — that's on purpose:
    # the UI shows both so you can see (a) which LLM call dominates (slow
    # row) and (b) whether parallelism is actually helping (emit_wall ≈ max).
    stages = [
        PipelineStage(key="parse",        label="Parse input",       duration_ms=stage_times.get("parse", 0)),
        PipelineStage(key="retrieve",     label="FAISS retrieve",    duration_ms=stage_times.get("retrieve", 0)),
        PipelineStage(key="classify",     label="Classify (resolve HS)", duration_ms=stage_times.get("classify", 0)),
        PipelineStage(key="resolve",      label="Master lookup",     duration_ms=stage_times.get("resolve", 0)),
        PipelineStage(key="justify",      label="Justifier (Sonnet)",     duration_ms=stage_times.get("justify", 0)),
        PipelineStage(key="translate_ar", label="Arabic translate (Haiku)", duration_ms=stage_times.get("translate_ar", 0)),
        PipelineStage(key="refine_en",    label="EN refine (Haiku)", duration_ms=stage_times.get("refine_en", 0)),
        PipelineStage(key="closest_alt",  label="Closest alt (Haiku)", duration_ms=stage_times.get("closest_alt", 0)),
        PipelineStage(key="emit_wall",    label="Emit (parallel wall-clock)", duration_ms=stage_times.get("emit_wall", 0)),
    ]

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
        justification=justification_schema,
        evidence=evidence_items,
        # v5 extensions
        trace_id=trace_id,
        plain_summary=plain_summary,
        product_description_en=product_description_en,
        product_description_ar=product_description_ar,
        rationale_steps=rationale_steps,
        stages=stages,
        meta=meta,
        hs_code_ladder=ladder_rows,
        closest_alternative=closest_alt,
    )


# ---------------------------------------------------------------------------
# POST /api/justify  — progressive-disclosure "Full customs justification"
# ---------------------------------------------------------------------------
@app.post("/api/justify", response_model=JustifyResponse, tags=["resolve"])
def justify(
    req: JustifyRequest,
    resolver: HSResolver = Depends(get_resolver),
    reasoner: HSReasoner = Depends(get_reasoner),
) -> JustifyResponse:
    """Fetch ONLY the Sonnet 7-section justification for a resolved code.

    Called from the UI when the user expands the "Full customs justification"
    accordion — the default /api/resolve response omits this expensive block
    so the classify button feels snappy.
    """
    code = req.hs_code.strip()
    if not code.isdigit():
        raise HTTPException(400, "`hs_code` must be digits only")
    code = code.zfill(12)[:12]

    master = resolver.master_row(code) or {}
    # Re-run FAISS so the justifier has the same evidence block as /resolve
    # would. Cheap compared to the Sonnet call itself.
    evidence_cands = resolver.faiss_evidence(req.description) if req.description else ()

    t0 = time.perf_counter()
    try:
        jres = reasoner.build_justification(
            JustificationInput(
                hs_code=code,
                description_en=req.description,
                customs_description_en=master.get("description_en", ""),
                customs_description_ar=master.get("arabic_name", ""),
                duty_rate_pct=master.get("duty_rate_pct"),
                origin=req.origin,
                destination=req.destination,
                value=req.value,
                currency=req.currency,
                faiss_candidates=evidence_cands,
            )
        )
    except ReasonerError as e:
        logger.warning("justify: reasoner error for %s: %s", code, e)
        raise HTTPException(502, f"Justifier failed: {e}")
    duration_ms = _ms_since(t0)

    if jres is None:
        return JustifyResponse(hs_code=code, duration_ms=duration_ms)

    justification_schema = JustificationSchema(
        product_name=jres.product_name,
        understanding_the_product=jres.understanding_the_product,
        relevant_tariff_headings=list(jres.relevant_tariff_headings),
        exclusions_of_other_subheadings=list(jres.exclusions_of_other_subheadings),
        wco_hs_explanatory_notes=jres.wco_hs_explanatory_notes,
        correct_classification=jres.correct_classification,
        conclusion=jres.conclusion,
    )
    rationale_steps = [
        RationaleStepSchema(
            title=s.title,
            detail=s.detail,
            plain_explanation=s.plain_explanation,
            reference=s.reference,
        )
        for s in jres.rationale_steps
    ]
    snippets_by_code = {s.hs_code: s for s in jres.evidence_snippets}
    evidence_items: list[EvidenceItem] = []
    for i, c in enumerate(evidence_cands):
        snip = snippets_by_code.get(c.hs_code)
        evidence_items.append(
            EvidenceItem(
                rank=i + 1,
                score=round(c.score or 0.0, 4),
                hs_code=c.hs_code,
                description_en=c.description_en,
                description_ar=c.description_ar,
                duty_rate_pct=c.duty_rate,
                source=(snip.source if snip else "ZATCA Tariff"),
                title=(snip.title if snip else f"ZATCA Tariff — {c.hs_code}"),
                snippet=(snip.snippet if snip else c.description_en),
            )
        )

    return JustifyResponse(
        hs_code=code,
        justification=justification_schema,
        rationale_steps=rationale_steps,
        evidence=evidence_items,
        duration_ms=duration_ms,
        tokens_in=jres.tokens_in,
        tokens_out=jres.tokens_out,
    )


# ---------------------------------------------------------------------------
# POST /api/resolve/reclassify
# ---------------------------------------------------------------------------
@app.post("/api/resolve/reclassify", response_model=ResolveResponse, tags=["resolve"])
def reclassify(
    req: ReclassifyRequest,
    resolver: HSResolver = Depends(get_resolver),
    reasoner: HSReasoner = Depends(get_reasoner),
) -> ResolveResponse:
    """Re-run classification against a user-picked alternative code.

    Used by the 'Pick →' button in the process panel. We honour the user's
    pick if it exists in the master, and rebuild the full v5 payload around
    it — so the UI can swap the result card in place.
    """
    code = req.hs_code.strip()
    if not code.isdigit():
        raise HTTPException(400, "`hs_code` must be digits only")
    # Fall back to a normal /resolve if the user's pick exists in master, else
    # just re-dispatch the resolver with the hs_code filled in.
    new_req = ResolveRequest(description=req.description, hs_code=code.zfill(12)[:12])
    return resolve(new_req, resolver=resolver, reasoner=reasoner)


# ---------------------------------------------------------------------------
# POST /api/feedback
# ---------------------------------------------------------------------------
@app.post("/api/feedback", response_model=FeedbackResponse, tags=["ops"])
def feedback(req: FeedbackRequest) -> FeedbackResponse:
    """Record a user's flag on a classification. Append-only JSONL so the
    review queue can pick it up later without a DB migration."""
    now = datetime.now(timezone.utc).isoformat()
    entry = {
        "trace_id": req.trace_id,
        "hs_code": req.hs_code,
        "reason": req.reason,
        "recorded_at": now,
    }
    try:
        config.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        import json
        with _FEEDBACK_LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        logger.info("feedback recorded: %s", entry)
    except OSError as e:
        logger.error("feedback write failed: %s", e)
        raise HTTPException(500, f"Could not persist feedback: {e}")
    return FeedbackResponse(trace_id=req.trace_id, recorded_at=now)


# ---------------------------------------------------------------------------
# POST /api/bayan/xml
# ---------------------------------------------------------------------------
@app.post("/api/bayan/xml", response_model=BayanXMLResponse, tags=["bayan"])
def bayan_xml(req: BayanXMLRequest) -> BayanXMLResponse:
    """Render a minimal ZATCA-integration XML for a resolved classification.

    V1 is a single-item declaration. Phase 3 will extend this to multi-item
    batch XML (see PROGRESS.md).
    """
    if not req.hs_code.isdigit():
        raise HTTPException(400, "`hs_code` must be digits only")
    # Single-item preview XML. The real batch pipeline (POST /api/batch/upload
    # → /run) uses the orchestrator; this endpoint is kept so the live UI's
    # "Generate XML" button on a single classification still works.
    import sqlite3
    from datetime import date
    conn = sqlite3.connect(str(config.DB_PATH))
    try:
        from clearai.services.batch_job_store import allocate_doc_ref_seq
        today = date.today()
        seq = allocate_doc_ref_seq(conn, today)
    finally:
        conn.close()
    doc_ref = _bayan.generate_doc_ref_no(today, seq)
    waybill = req.trace_id or doc_ref  # no real waybill at single-item time
    item = DeclarationItem(
        seq_no=1,
        country_of_origin=(req.origin or "XX").upper()[:2],
        tariff_code=req.hs_code,
        goods_description_ar=req.description_ar or req.description_en,
        quantity=1.0,
        gross_weight=0.0,
        net_weight=0.0,
        unit_invoice_cost=req.value,
        item_cost=req.value or 0.0,
    )
    consignee = ConsigneeInfo(name="PREVIEW", national_id="0", phone="",
                              address="", city_code=None)
    decl = WaybillDeclaration(
        doc_ref_no=doc_ref, invoice_no=waybill, waybill_no=waybill,
        invoice_date=today,
        invoice_currency_code=100,  # default SAR for single preview
        reg_port=23, client_id="", items=(item,), consignee=consignee,
    )
    xml = _bayan.build_declaration_xml(decl)
    return BayanXMLResponse(
        xml=xml,
        filename=f"{doc_ref}.XML",
        trace_id=req.trace_id,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _new_trace_id() -> str:
    """6-hex-char id — short enough for the UI 'trace · 7f3a9c' chip."""
    return secrets.token_hex(3)


def _ms_since(t0: float) -> int:
    return int((time.perf_counter() - t0) * 1000)


def _timed(fn, *args, **kwargs):
    """Wrap a callable to return (result, elapsed_ms). Used by the resolve
    handler to capture real per-future wall-clocks while the futures run
    concurrently. Never raises — exceptions propagate from the inner fn."""
    t0 = time.perf_counter()
    try:
        return fn(*args, **kwargs), int((time.perf_counter() - t0) * 1000)
    except BaseException:
        # Re-raise — the caller's future.result() will surface the error.
        raise


def _safe_refine_en(reasoner: HSReasoner, merchant: str, zatca: str):
    """Wrap refine_description_en so a Haiku failure doesn't kill the
    whole request. Falls back to the merchant description at the call site."""
    if not merchant and not zatca:
        return None
    try:
        return reasoner.refine_description_en(
            merchant_description=merchant,
            zatca_description=zatca,
        )
    except ReasonerError as e:
        logger.warning("refine_description_en failed: %s", e)
        return None
    except Exception as e:  # noqa: BLE001
        logger.warning("refine_description_en unexpected error: %s", e)
        return None


def _safe_closest_alt(reasoner: HSReasoner, picked_code: str, picked_desc_en: str, cands):
    """Wrap build_closest_alternative so a Haiku failure just hides the
    'Why not a similar code?' card — it's nice-to-have, not critical."""
    try:
        return reasoner.build_closest_alternative(
            picked_code=picked_code,
            picked_description_en=picked_desc_en,
            faiss_candidates=cands,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("build_closest_alternative unexpected error: %s", e)
        return None


def _safe_translate(reasoner: HSReasoner, description_en: str):
    """Wrap translate_to_arabic so a failure in the parallel translate path
    doesn't bubble up and kill the justification — which is the far more
    expensive call. Returns None on any error."""
    try:
        return reasoner.translate_to_arabic(description_en)
    except ReasonerError as e:
        logger.warning("translate_to_arabic failed: %s", e)
        return None
    except Exception as e:  # noqa: BLE001 — best-effort
        logger.warning("translate_to_arabic unexpected error: %s", e)
        return None


def resolution_tokens_in(res: Resolution) -> int:
    """The `Resolution` dataclass doesn't carry tokens yet — so per-call
    token accounting is aggregated at the API layer from each reasoner
    result. This helper exists so a future resolver change that DOES carry
    tokens (e.g. for audit.log) has a single point to update."""
    return 0


def resolution_tokens_out(res: Resolution) -> int:
    return 0


def _fallback_plain_summary(*, product_name: str, hs_code: str) -> str:
    """Use when the justifier didn't return a plain_summary. Keeps the UI
    top card from falling back to the long rationale."""
    formatted = _format_hs_display(hs_code)
    name = (product_name or "this item").strip()
    return f"This is **{name}**, classified as **{formatted}**."


def _format_hs_display(hs_code: str) -> str:
    """12-digit → dotted display format used in the UI: 12.34.56.78.90.12."""
    code = "".join(c for c in hs_code if c.isdigit())
    if len(code) != 12:
        return hs_code
    return ".".join([code[0:2], code[2:4], code[4:6], code[6:8], code[8:10], code[10:12]])
