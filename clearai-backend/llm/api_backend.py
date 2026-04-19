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

import config
from llm.base import (
    Candidate,
    HSReasoner,
    RankerInput,
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

# 12-digit Saudi HS code — digits only, no separators
_HS_CODE_PATTERN = re.compile(r"^\d{12}$")

# Reasonable hard caps on output length — nothing we ask for is long
_MAX_TOKENS_TRANSLATION = 256
_MAX_TOKENS_RANK = 512
_MAX_TOKENS_REASON = 1024


# ---------------------------------------------------------------------------
# Backend
# ---------------------------------------------------------------------------
class AnthropicReasoner(HSReasoner):
    """Anthropic-backed reasoner. Lazy client; one instance per run."""

    def __init__(self, client: Anthropic | None = None) -> None:
        self._client = client or Anthropic(api_key=config.ANTHROPIC_API_KEY)

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

        data = self._call_json(
            model=config.TRANSLATION_MODEL,
            system=_SYSTEM_TRANSLATOR,
            user=user_prompt,
            max_tokens=_MAX_TOKENS_TRANSLATION,
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

        data = self._call_json(
            model=config.RANKER_MODEL,
            system=_SYSTEM_CLASSIFIER,
            user=user_prompt,
            max_tokens=_MAX_TOKENS_RANK,
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
            f"Merchant declared code (may be partial, wrong jurisdiction, or HS-6): "
            f"{payload.declared_code or '(none)'}\n"
            f"English description: {payload.description_en.strip()}\n"
            f"Arabic description: {payload.description_ar or '(none)'}\n"
            f"Chinese description: {payload.description_cn or '(none)'}\n\n"
            f"FAISS semantic candidates from ZATCA tariff master:\n{faiss_block}\n\n"
            f"Prefix-traversal candidates from ZATCA tariff master:\n{prefix_block}\n\n"
            f"Naqel bucket hint: {naqel_line}"
        )

        data = self._call_json(
            model=config.REASONER_MODEL,
            system=_SYSTEM_CLASSIFIER,
            user=user_prompt,
            max_tokens=_MAX_TOKENS_REASON,
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
        )

    # -- Internal: API call + JSON parse -------------------------------------
    def _call_json(
        self,
        *,
        model: str,
        system: str,
        user: str,
        max_tokens: int,
    ) -> dict[str, Any]:
        """Single API call, temperature 0, JSON response, validated to dict."""
        try:
            resp = self._client.messages.create(
                model=model,
                max_tokens=max_tokens,
                temperature=0,
                system=system,
                messages=[{"role": "user", "content": user}],
            )
        except APIError as e:
            raise ReasonerError(f"Anthropic API error on {model}: {e}") from e

        # Concatenate all text blocks defensively — normally there's one.
        text_parts: list[str] = []
        for block in resp.content:
            block_text = getattr(block, "text", None)
            if block_text:
                text_parts.append(block_text)
        text = "".join(text_parts).strip()
        if not text:
            raise ReasonerError(f"{model}: empty response body")

        # Models sometimes wrap JSON in ```json fences despite instructions —
        # strip those before parsing.
        text = _strip_code_fence(text)

        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            logger.warning("%s: JSON decode failure: %s | body=%r", model, e, text[:500])
            raise ReasonerError(f"{model}: response was not valid JSON") from e

        if not isinstance(data, dict):
            raise ReasonerError(f"{model}: JSON response was not an object")
        return data


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
