"""
AnthropicReasoner — the single concrete HSReasoner implementation for V1.

Routes each method to its declared model tier:

  translate_to_arabic  →  config.TRANSLATION_MODEL  (Haiku)
  rank_candidates      →  config.RANKER_MODEL       (Sonnet)
  infer_hs_code        →  config.REASONER_MODEL     (Opus)

All prompts request JSON responses at temperature 0. Malformed responses or
validation failures raise ReasonerError so the resolver routes the row to
review.csv rather than crashing the batch.

The prompts enforce ClearAI's classification framing from ADR-007:
Naqel's bucket hint is treated as an advisory signal, never as the answer key.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from anthropic import Anthropic, APIError

from clearai import config
from clearai.ports.reasoner import (
    Candidate,
    ClosestAlternativeResult,
    EvidenceSnippet,
    HSReasoner,
    JustificationInput,
    JustificationResult,
    RankerInput,
    RationaleStep,
    ReasonerError,
    ReasonerInput,
    ReasonerResult,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Prompt constants
# ---------------------------------------------------------------------------
_SYSTEM_CLASSIFIER = (
    "You are an expert Saudi customs HS classifier. You resolve merchant product "
    "descriptions and partial codes into precise 12-digit Saudi ZATCA tariff codes, "
    "following WCO General Rules of Interpretation (GRI 1–6). You reason from the "
    "product's essential character, not from historical shortcuts. When evidence "
    "disagrees, you say so explicitly. You always respond in valid JSON, no prose "
    "before or after the JSON object."
)

_SYSTEM_TRANSLATOR = (
    "You are an expert translator of product descriptions into Saudi customs-tariff "
    "Arabic. You use the terminology conventions of the ZATCA tariff nomenclature "
    "(Harmonized System Arabic), not casual or marketing Arabic. You always respond "
    "in valid JSON, no prose before or after the JSON object."
)

_SYSTEM_JUSTIFIER = (
    "You are an expert Saudi customs HS classifier. You write structured "
    "classification justifications following ClearAI's 7-section test-case format. "
    "You cite WCO GRI 1–6 by number and reference heading exclusions explicitly. "
    "You respond in valid JSON — no prose before or after the JSON object."
)

_JUSTIFY_USER_TEMPLATE = """\
You are writing a structured classification justification for a resolved HS code.
ONE response must produce BOTH the Case 001 rationale AND the v5 UI extensions
(plain_summary, 3-step narrative, source snippets).

Resolved code: {hs_code}
Customs description (EN): {customs_en}
Customs description (AR): {customs_ar}
Duty rate (%): {duty_rate}

Merchant description: "{description}"
Origin: {origin}
Destination: {destination}
Declared value: {value} {currency}

FAISS evidence (top-K semantic neighbours from the ZATCA master):
{evidence_block}

Return a JSON object with EXACTLY these keys (no others, no nesting beyond what is shown):

{{
  "product_name": "<short noun phrase naming the product>",
  "plain_summary": "<ONE sentence, markdown-style **bold** on the product + final code, e.g. 'This is a **children's comic book**, classified as **4901.10.00.00.00.00** (printed books).'>",
  "understanding_the_product": "<EXACTLY 1 sentence describing the product. Do not exceed 30 words.>",
  "relevant_tariff_headings": [
    "<bulleted item: Chapter/Heading/Subheading — description. 2-3 entries total, each under 15 words.>"
  ],
  "exclusions_of_other_subheadings": [
    "<bulleted item: heading — one-sentence reason. 2-3 entries total, each under 15 words.>"
  ],
  "correct_classification": "<EXACTLY 2-3 sentences applying GRI 1 through 6 by number. Do not exceed 60 words.>",
  "conclusion": "<EXACTLY 1 sentence restating the final code + Arabic description. Do not exceed 25 words.>",
  "rationale_steps": [
    {{
      "title": "<e.g. 'Chapter 49 — Printed matter'>",
      "detail": "<one-sentence technical explanation for WHY this chapter applies>",
      "plain_explanation": "<plain-English rephrasing starting with 'What this means:'>",
      "reference": "<WCO GIR or ZATCA note, e.g. 'WCO GIR 1' or 'ZATCA Note 4901'>"
    }},
    {{ "title": "<Heading-level step, e.g. '4901 — Printed books'>", "detail": "...", "plain_explanation": "...", "reference": "..." }},
    {{ "title": "<Subheading-level step, e.g. '4901.10 — In single sheets'>", "detail": "...", "plain_explanation": "...", "reference": "..." }}
  ],
  "evidence_snippets": [
    {{
      "hs_code": "<12-digit code from the FAISS evidence block above>",
      "source": "<ZATCA Tariff | WCO Notes | Bayan ruling>",
      "title": "<short heading, e.g. 'ZATCA Tariff — Heading 4901'>",
      "snippet": "<1-2 sentence quotation or paraphrase of the authority>"
    }}
  ]
}}

Rules:
- "rationale_steps" has EXACTLY 3 entries (Chapter, Heading, Subheading — in that order).
  Each entry's "detail" and "plain_explanation" must be 1 sentence, under 25 words.
- "evidence_snippets" has EXACTLY 3 entries (not more), each referencing a candidate from the FAISS block.
  Each "snippet" is 1 sentence, under 25 words.
- "relevant_tariff_headings" and "exclusions_of_other_subheadings" each have 2-3 entries (not 5).
- "plain_summary" is a SINGLE sentence with markdown **bold** on the key nouns.
- Do not add fields. Do not nest beyond shown. All required and non-empty.
- BREVITY IS CRITICAL. Total output MUST stay under 1100 tokens — respond concisely; prefer the shortest form that preserves accuracy.
"""

_CLOSEST_ALT_USER_TEMPLATE = """\
A Saudi HS code has been resolved. Pick the NEAREST rejected competitor from
the FAISS candidate list and explain in ONE plain sentence (no jargon, no GRI
citation, no heading number) why the picked code was chosen over it.

Picked code: {picked_code}
Picked description: {picked_desc}

FAISS candidates (the picked code is excluded from this list):
{evidence_block}

Return ONLY a JSON object of this exact shape:
{{
  "hs_code": "<12-digit code of the rejected competitor you considered second-most-plausible, or empty string if no candidate is close enough to mention>",
  "why_not": "<ONE plain-English sentence explaining the concrete discriminating fact. No GRI citation, no chapter/heading number, no customs jargon. Under 30 words. Empty string if hs_code is empty.>"
}}

Example good why_not: "That code is for hardcover reference books, but this product is a softcover comic."
Example good why_not: "That code is for standard virgin olive oil with a defined quality grade, while this product is a generic 'olive oil' falling in the broader other-virgin bucket."
"""

# 12-digit Saudi HS code — digits only, no separators
_HS_CODE_PATTERN = re.compile(r"^\d{12}$")

# Reasonable hard caps on output length — nothing we ask for is long
_MAX_TOKENS_TRANSLATION = 256
_MAX_TOKENS_RANK = 512
_MAX_TOKENS_REASON = 1024
_MAX_TOKENS_JUSTIFY = 1536  # 6 sections + 3 steps + snippets (wco_notes removed)
_MAX_TOKENS_CLOSEST_ALT = 256  # hs_code + ≤30-word sentence


# ---------------------------------------------------------------------------
# Backend
# ---------------------------------------------------------------------------
class AnthropicReasoner(HSReasoner):
    """Anthropic-backed reasoner. Lazy client; one instance per run."""

    def __init__(self, client: Anthropic | None = None) -> None:
        if client is not None:
            self._client = client
        else:
            client_kwargs: dict[str, str] = {"api_key": config.ANTHROPIC_API_KEY}
            # Route through Azure AI Foundry (or any Anthropic-compatible
            # proxy) only when ANTHROPIC_BASE_URL is explicitly set. Empty
            # string → SDK default → api.anthropic.com.
            if config.ANTHROPIC_BASE_URL:
                client_kwargs["base_url"] = config.ANTHROPIC_BASE_URL
                logger.info(
                    "AnthropicReasoner: using custom base_url=%s",
                    config.ANTHROPIC_BASE_URL,
                )
            self._client = Anthropic(**client_kwargs)

    # -- Task 1a: English description refinement (TRANSLATION_MODEL / Haiku) ---
    def refine_description_en(
        self,
        *,
        merchant_description: str,
        zatca_description: str,
    ) -> ReasonerResult:
        """Merge merchant wording with ZATCA tariff wording into one cleaner
        EN line. Deliberately constrained so Haiku is the right tier.
        """
        merchant = (merchant_description or "").strip()
        zatca = (zatca_description or "").strip()
        if not merchant and not zatca:
            raise ReasonerError("refine_description_en: both inputs empty")

        user_prompt = (
            "Rewrite the merchant's product description into ONE cleaner English "
            "sentence that blends:\n"
            "  (a) the merchant's OWN words, tone, and level of detail — DO NOT "
            "inflate or marketise it, and\n"
            "  (b) the more precise nouns / qualifiers from the ZATCA customs "
            "description for the classified code.\n\n"
            "Rules:\n"
            "- Keep it to ONE sentence, under 25 words.\n"
            "- Match the merchant's register (casual stays casual; technical "
            "stays technical).\n"
            "- Do NOT invent facts (materials, certifications, origins) that "
            "appear in neither input.\n"
            "- Do NOT add marketing adjectives (premium, high-quality, etc.) "
            "unless the merchant used them.\n"
            "- Prefer the merchant's nouns; borrow ZATCA's nouns only where "
            "they add precision (e.g. merchant 'shirt' + ZATCA 'knitted "
            "cotton shirt' → 'knitted cotton shirt').\n\n"
            f"Merchant description: {merchant or '(none)'}\n"
            f"ZATCA tariff description: {zatca or '(none)'}\n\n"
            "Respond with a JSON object:\n"
            '{"refined": "<one-sentence refined description>", '
            '"confidence": <0.0-1.0>}'
        )

        data, tokens_in, tokens_out = self._call_json(
            model=config.TRANSLATION_MODEL,
            system=_SYSTEM_TRANSLATOR,  # same tariff-register translator system
            user=user_prompt,
            max_tokens=_MAX_TOKENS_TRANSLATION,
            task="refine_en",
        )
        refined = str(data.get("refined", "")).strip()
        if not refined:
            raise ReasonerError("refine_description_en: model returned empty 'refined' field")
        return ReasonerResult(
            hs_code="",
            confidence=_coerce_confidence(data.get("confidence")),
            rationale=refined,  # carries the refined line
            model_used=config.TRANSLATION_MODEL,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
        )

    # -- Task 1: Arabic translation (TRANSLATION_MODEL / Haiku) --------------
    def translate_to_arabic(self, description_en: str) -> ReasonerResult:
        if not description_en or not description_en.strip():
            raise ReasonerError("translate_to_arabic: empty English description")

        user_prompt = (
            "Translate the following English product description into Saudi "
            "customs-tariff Arabic. Use ZATCA tariff-nomenclature conventions, "
            "not casual Arabic. Respond with a JSON object of the form:\n"
            '{"arabic": "<translation>", "confidence": <0.0-1.0>, '
            '"rationale": "<one-sentence justification>"}\n\n'
            f"English description: {description_en.strip()}"
        )

        data, tokens_in, tokens_out = self._call_json(
            model=config.TRANSLATION_MODEL,
            system=_SYSTEM_TRANSLATOR,
            user=user_prompt,
            max_tokens=_MAX_TOKENS_TRANSLATION,
            task="translate",
        )

        arabic = str(data.get("arabic", "")).strip()
        if not arabic:
            raise ReasonerError("translate_to_arabic: model returned empty 'arabic' field")

        return ReasonerResult(
            hs_code="",
            confidence=_coerce_confidence(data.get("confidence")),
            rationale=str(data.get("rationale", "")).strip(),
            arabic_description=arabic,
            model_used=config.TRANSLATION_MODEL,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
        )

    # -- Task 2: Candidate ranking (RANKER_MODEL / Sonnet) -------------------
    def rank_candidates(self, payload: RankerInput) -> ReasonerResult:
        if not payload.candidates:
            raise ReasonerError("rank_candidates: empty candidates list")

        candidates_block = _format_candidates(payload.candidates)
        user_prompt = (
            "Pick the single best 12-digit Saudi HS code for this shipment line. "
            "Compare the description against each candidate and choose based on "
            "essential character (GRI 1). Respond with JSON of the form:\n"
            '{"hs_code": "<12-digit>", "confidence": <0.0-1.0>, '
            '"rationale": "<one-sentence justification>"}\n\n'
            f"Declared code (may be partial or wrong jurisdiction): "
            f"{payload.declared_code or '(none)'}\n"
            f"English description: {payload.description_en.strip()}\n"
            f"Arabic description: {payload.description_ar or '(none)'}\n"
            f"Chinese description: {payload.description_cn or '(none)'}\n\n"
            f"Candidates:\n{candidates_block}"
        )

        data, tokens_in, tokens_out = self._call_json(
            model=config.RANKER_MODEL,
            system=_SYSTEM_CLASSIFIER,
            user=user_prompt,
            max_tokens=_MAX_TOKENS_RANK,
            task="rank",
        )

        hs_code = _normalize_hs(str(data.get("hs_code", "")))
        if not _HS_CODE_PATTERN.match(hs_code):
            raise ReasonerError(
                f"rank_candidates: model returned invalid hs_code {data.get('hs_code')!r}"
            )

        return ReasonerResult(
            hs_code=hs_code,
            confidence=_coerce_confidence(data.get("confidence")),
            rationale=str(data.get("rationale", "")).strip(),
            model_used=config.RANKER_MODEL,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
        )

    # -- Task 3: Full inference (REASONER_MODEL / Opus) ----------------------
    def infer_hs_code(self, payload: ReasonerInput) -> ReasonerResult:
        faiss_block = (
            _format_candidates(payload.faiss_candidates)
            if payload.faiss_candidates else "(none)"
        )
        prefix_block = (
            _format_candidates(payload.prefix_candidates)
            if payload.prefix_candidates else "(none)"
        )
        naqel_line = (
            f"Naqel's operations team historically declares this for items like this: "
            f"{payload.naqel_bucket_hint}\n"
            "Treat this as ONE advisory signal, not the answer key. "
            "If the description clearly indicates a different chapter, say so and "
            "set agrees_with_naqel=false."
            if payload.naqel_bucket_hint
            else "(no Naqel bucket hint for this merchant code prefix)"
        )

        user_prompt = (
            "Classify this shipment line into a precise 12-digit Saudi ZATCA HS code. "
            "Aggregate evidence from all signals below. Apply GRI 1–6. Respond with "
            "JSON of the form:\n"
            '{"hs_code": "<12-digit>", "confidence": <0.0-1.0>, '
            '"rationale": "<short justification citing the decisive signals>", '
            '"agrees_with_naqel": <true|false|null>}\n\n'
            "Material inference rule (apparel, footwear, textiles):\n"
            "- Many garment archetypes carry a strong real-world fibre prior (e.g.\n"
            "  bomber / flight jacket → man-made fibres [polyester, nylon];\n"
            "  jeans / denim → cotton; pashmina / cashmere shawl → wool/fine animal hair;\n"
            "  fleece → man-made fibres; parka / puffer shell → man-made fibres).\n"
            "- When the description names such an archetype and the merchant has NOT\n"
            "  declared a fibre, classify under the DOMINANT fibre subheading, not\n"
            "  the residual \"of other textile materials\" bucket.\n"
            "- NEVER choose the \"other textile materials\" leaf (typically the\n"
            "  ...90 subheading within a garment heading) unless the description\n"
            "  positively excludes cotton, wool, and man-made fibres (e.g. silk,\n"
            "  ramie, jute are named explicitly). \"Other\" is the residual for\n"
            "  exotic fibres, not the default when fibre is unknown.\n"
            "- State the inference explicitly in the rationale (e.g. \"assumed\n"
            "  man-made fibres because bomber jackets are overwhelmingly synthetic\").\n"
            "- When you apply the material-inference rule (fibre INFERRED, not\n"
            "  declared), CAP confidence at 0.80 so the row lands in the review\n"
            "  queue. When the fibre IS declared in the description, use full\n"
            "  confidence as normal.\n\n"
            f"Merchant declared code (may be partial, wrong jurisdiction, or HS-6): "
            f"{payload.declared_code or '(none)'}\n"
            f"English description: {payload.description_en.strip()}\n"
            f"Arabic description: {payload.description_ar or '(none)'}\n"
            f"Chinese description: {payload.description_cn or '(none)'}\n\n"
            f"FAISS semantic candidates from ZATCA tariff master:\n{faiss_block}\n\n"
            f"Prefix-traversal candidates from ZATCA tariff master:\n{prefix_block}\n\n"
            f"Naqel bucket hint: {naqel_line}"
        )

        data, tokens_in, tokens_out = self._call_json(
            model=config.REASONER_MODEL,
            system=_SYSTEM_CLASSIFIER,
            user=user_prompt,
            max_tokens=_MAX_TOKENS_REASON,
            task="infer",
        )

        hs_code = _normalize_hs(str(data.get("hs_code", "")))
        if not _HS_CODE_PATTERN.match(hs_code):
            raise ReasonerError(
                f"infer_hs_code: model returned invalid hs_code {data.get('hs_code')!r}"
            )

        raw_agrees = data.get("agrees_with_naqel")
        agrees: bool | None
        if isinstance(raw_agrees, bool):
            agrees = raw_agrees
        elif raw_agrees is None:
            agrees = None
        else:
            # Tolerate string "true"/"false"/"null" — some models stringify
            s = str(raw_agrees).strip().lower()
            agrees = True if s == "true" else False if s == "false" else None

        return ReasonerResult(
            hs_code=hs_code,
            confidence=_coerce_confidence(data.get("confidence")),
            rationale=str(data.get("rationale", "")).strip(),
            agrees_with_naqel=agrees,
            model_used=config.REASONER_MODEL,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
        )

    # -- Task 5: Closest-alternative discriminator (TRANSLATION_MODEL / Haiku) ---
    def build_closest_alternative(
        self,
        *,
        picked_code: str,
        picked_description_en: str,
        faiss_candidates,
    ) -> ClosestAlternativeResult | None:
        """Haiku one-shot: pick the nearest rejected FAISS competitor and
        emit a single plain-English discriminator sentence. Returns None on
        any failure; the UI simply hides the "Why not a similar code?" card.
        """
        if not picked_code:
            return None
        # Filter the picked code out of the candidate list so Haiku can't
        # pick it back as its own alternative.
        rivals = tuple(c for c in faiss_candidates if c.hs_code != picked_code)
        if not rivals:
            return None

        user_prompt = _CLOSEST_ALT_USER_TEMPLATE.format(
            picked_code=picked_code,
            picked_desc=picked_description_en or "(not in master)",
            evidence_block=_format_candidates(rivals),
        )

        try:
            data, tokens_in, tokens_out = self._call_json(
                model=config.TRANSLATION_MODEL,
                system=_SYSTEM_CLASSIFIER,
                user=user_prompt,
                max_tokens=_MAX_TOKENS_CLOSEST_ALT,
                task="closest_alt",
            )
        except ReasonerError as e:
            logger.warning("build_closest_alternative: failed for %s: %s", picked_code, e)
            return None

        try:
            alt_code = _normalize_hs(str(data.get("hs_code", "")))
            alt_why = str(data.get("why_not", "")).strip()
            # Both-or-neither: partial is useless to the UI.
            if not alt_code or not alt_why:
                return None
            if not _HS_CODE_PATTERN.match(alt_code):
                return None
            return ClosestAlternativeResult(
                hs_code=alt_code,
                why_not=alt_why,
                model_used=config.TRANSLATION_MODEL,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
            )
        except (KeyError, TypeError, ValueError) as e:
            logger.warning("build_closest_alternative: malformed JSON: %s", e)
            return None

    # -- Task 4: 7-section justification (REASONER_MODEL / Opus) -------------
    def build_justification(
        self, payload: JustificationInput
    ) -> JustificationResult | None:
        """Produce the Case 001 7-section justification. Returns None on any
        failure (API error, malformed JSON, missing required keys).

        This method is deliberately lenient — justification is UI candy; if
        it fails, the API still returns the resolved code. The resolver's
        three tasks, by contrast, raise ReasonerError because they gate on
        confidence and the caller must know when output is unreliable.
        """
        if not payload.hs_code:
            return None

        user_prompt = _JUSTIFY_USER_TEMPLATE.format(
            hs_code=payload.hs_code,
            customs_en=payload.customs_description_en or "(not in master)",
            customs_ar=payload.customs_description_ar or "(not in master)",
            duty_rate=(
                f"{payload.duty_rate_pct}" if payload.duty_rate_pct is not None else "(unknown)"
            ),
            description=payload.description_en or "(none provided)",
            origin=payload.origin or "(unknown)",
            destination=payload.destination or "(unknown)",
            value=f"{payload.value}" if payload.value is not None else "(unknown)",
            currency=payload.currency or "",
            evidence_block=_format_candidates(payload.faiss_candidates) or "(no FAISS candidates)",
        )

        try:
            data, tokens_in, tokens_out = self._call_json(
                model=config.REASONER_MODEL,
                system=_SYSTEM_JUSTIFIER,
                user=user_prompt,
                max_tokens=_MAX_TOKENS_JUSTIFY,
                task="justify",
            )
        except ReasonerError as e:
            logger.warning("build_justification: failed for %s: %s", payload.hs_code, e)
            return None

        try:
            # v5 extensions — parse leniently; missing fields default to empty
            # so a partial response still yields a usable justification.
            steps_raw = data.get("rationale_steps") or []
            rationale_steps = tuple(
                RationaleStep(
                    title=str(s.get("title", "")).strip(),
                    detail=str(s.get("detail", "")).strip(),
                    plain_explanation=str(s.get("plain_explanation", "")).strip(),
                    reference=str(s.get("reference", "")).strip(),
                )
                for s in steps_raw
                if isinstance(s, dict) and s.get("title")
            )
            snippets_raw = data.get("evidence_snippets") or []
            evidence_snippets = tuple(
                EvidenceSnippet(
                    hs_code=_normalize_hs(str(s.get("hs_code", ""))),
                    source=str(s.get("source", "")).strip(),
                    title=str(s.get("title", "")).strip(),
                    snippet=str(s.get("snippet", "")).strip(),
                )
                for s in snippets_raw
                if isinstance(s, dict) and s.get("snippet")
            )

            # wco_hs_explanatory_notes was dropped from the default Sonnet
            # payload to cut output tokens (~300-500 saved). We still accept
            # it optionally so callers that opt in later (e.g. "expand full
            # justification" endpoint) can wire it back without a schema bump.
            # closest_alternative moved to a dedicated Haiku call — the fields
            # on JustificationResult remain for backwards compatibility but
            # the justifier no longer populates them.
            return JustificationResult(
                product_name=str(data["product_name"]).strip(),
                understanding_the_product=str(data["understanding_the_product"]).strip(),
                relevant_tariff_headings=tuple(
                    str(x).strip()
                    for x in data["relevant_tariff_headings"]
                    if str(x).strip()
                ),
                exclusions_of_other_subheadings=tuple(
                    str(x).strip()
                    for x in data["exclusions_of_other_subheadings"]
                    if str(x).strip()
                ),
                wco_hs_explanatory_notes=str(data.get("wco_hs_explanatory_notes", "")).strip(),
                correct_classification=str(data["correct_classification"]).strip(),
                conclusion=str(data["conclusion"]).strip(),
                plain_summary=str(data.get("plain_summary", "")).strip(),
                rationale_steps=rationale_steps,
                evidence_snippets=evidence_snippets,
                closest_alternative_code="",
                closest_alternative_why_not="",
                model_used=config.REASONER_MODEL,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
            )
        except (KeyError, TypeError, ValueError) as e:
            logger.warning(
                "build_justification: malformed JSON for %s: %s", payload.hs_code, e
            )
            return None

    # -- Internal: API call + JSON parse -------------------------------------
    def _call_json(
        self,
        *,
        model: str,
        system: str,
        user: str,
        max_tokens: int,
        task: str = "unknown",
    ) -> tuple[dict[str, Any], int, int]:
        """Single API call, temperature 0, JSON response, validated to dict.

        `task` is a short tag ("translate" | "rank" | "infer" | "justify")
        included in failure logs so we can filter parse failures by call site
        without grepping Python stack traces.
        """
        import time as _time
        _t0 = _time.perf_counter()
        try:
            resp = self._client.messages.create(
                model=model,
                max_tokens=max_tokens,
                temperature=0,
                system=system,
                messages=[{"role": "user", "content": user}],
            )
        except APIError as e:
            _dur_ms = int((_time.perf_counter() - _t0) * 1000)
            logger.warning(
                "[timing] task=%s model=%s FAILED dur_ms=%d err=%s",
                task, model, _dur_ms, e,
            )
            raise ReasonerError(f"Anthropic API error on {model}: {e}") from e
        _dur_ms = int((_time.perf_counter() - _t0) * 1000)
        # Emit wall-clock-per-call so the UI's stage panel and the ops
        # dashboard can show WHICH LLM call was slow without re-doing the
        # math client-side. Keyed so grep 'task=justify' filters one tier.
        _usage = getattr(resp, "usage", None)
        _tin = getattr(_usage, "input_tokens", 0) or 0
        _tout = getattr(_usage, "output_tokens", 0) or 0
        logger.info(
            "[timing] task=%s model=%s dur_ms=%d tokens_in=%d tokens_out=%d",
            task, model, _dur_ms, _tin, _tout,
        )

        # Concatenate all text blocks defensively — normally there's one.
        text_parts: list[str] = []
        for block in resp.content:
            block_text = getattr(block, "text", None)
            if block_text:
                text_parts.append(block_text)
        text = "".join(text_parts).strip()
        if not text:
            logger.warning(
                "[%s] %s: empty response body (stop_reason=%s)",
                task, model, getattr(resp, "stop_reason", "?"),
            )
            raise ReasonerError(f"{model}: empty response body")

        # Models sometimes wrap JSON in ```json fences despite instructions —
        # strip those before parsing.
        text = _strip_code_fence(text)
        # Some multilingual prompts (Arabic/Chinese) occasionally produce a
        # prose preamble before the JSON and/or trailing commentary. Try to
        # recover a single top-level JSON object before giving up.
        candidate = _extract_json_object(text)

        try:
            data = json.loads(candidate)
        except json.JSONDecodeError as e:
            # Full-body capture on parse failure: we need the entire response
            # to diagnose prompt/model drift. Log in three forms so grep and
            # structured log collectors both work:
            #   1. A one-line summary with task + model + error location.
            #   2. The raw response text, line-prefixed so multi-line JSON
            #      attempts survive logging pipelines that trim long lines.
            #   3. Length + stop_reason for quick sanity (was it truncated?).
            stop_reason = getattr(resp, "stop_reason", "?")
            logger.error(
                "[%s] %s: JSON decode failed at line %d col %d (body_len=%d, "
                "stop_reason=%s): %s",
                task, model, e.lineno, e.colno, len(text), stop_reason, e.msg,
            )
            for i, line in enumerate(text.splitlines() or [text], start=1):
                logger.error("[%s] %s raw[%d]: %s", task, model, i, line)
            raise ReasonerError(
                f"{model}: response was not valid JSON "
                f"(task={task}, body_len={len(text)}, stop_reason={stop_reason})"
            ) from e

        if not isinstance(data, dict):
            logger.error(
                "[%s] %s: JSON response was not an object — got %s | body=%r",
                task, model, type(data).__name__, text[:1000],
            )
            raise ReasonerError(f"{model}: JSON response was not an object")

        # Capture token usage so the API can surface latency/cost panels. The
        # Anthropic SDK puts usage on resp.usage with input_tokens / output_tokens.
        usage = getattr(resp, "usage", None)
        tokens_in = int(getattr(usage, "input_tokens", 0) or 0) if usage else 0
        tokens_out = int(getattr(usage, "output_tokens", 0) or 0) if usage else 0
        return data, tokens_in, tokens_out


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _normalize_hs(raw: str) -> str:
    """Strip non-digit characters — matches resolver-side normalization."""
    return re.sub(r"\D", "", raw or "")


def _coerce_confidence(raw: Any) -> float:
    """Clamp confidence into [0.0, 1.0]. Missing/malformed → 0.0 (forces review)."""
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return 0.0
    if v < 0.0:
        return 0.0
    if v > 1.0:
        return 1.0
    return v


def _format_candidates(cands: "tuple[Candidate, ...] | list[Candidate]" | Any) -> str:
    """Render candidates as a numbered block the model can reference."""
    lines: list[str] = []
    for i, c in enumerate(cands, start=1):
        bits = [f"  {i}. {c.hs_code}  —  {c.description_en}"]
        if c.description_ar:
            bits.append(f"     AR: {c.description_ar}")
        meta: list[str] = [f"source={c.source}"]
        if c.duty_rate is not None:
            meta.append(f"duty={c.duty_rate}")
        if c.score is not None:
            meta.append(f"score={c.score:.3f}")
        bits.append(f"     ({', '.join(meta)})")
        lines.append("\n".join(bits))
    return "\n".join(lines)


def _extract_json_object(text: str) -> str:
    """Return the first balanced {...} span from `text`, honouring string
    escapes so braces inside strings don't throw off the brace counter.

    Models sometimes emit prose before/after the JSON despite instructions
    (especially on non-Latin inputs). This recovers the JSON without
    blocking on the preamble. Falls back to the original text if no
    balanced object is found — `json.loads` will then produce the proper
    error.
    """
    start = text.find("{")
    if start < 0:
        return text
    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return text  # unbalanced — let json.loads surface it


def _strip_code_fence(text: str) -> str:
    """If the model wrapped JSON in ```json ... ``` fences, unwrap it."""
    stripped = text.strip()
    if stripped.startswith("```"):
        # Drop the opening fence (and optional language tag)
        first_newline = stripped.find("\n")
        if first_newline != -1:
            stripped = stripped[first_newline + 1 :]
        # Drop the closing fence
        if stripped.rstrip().endswith("```"):
            stripped = stripped.rstrip()[: -3].rstrip()
    return stripped
