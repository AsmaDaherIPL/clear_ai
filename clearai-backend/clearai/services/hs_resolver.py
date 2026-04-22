"""
HS code resolver — turns a merchant invoice row into a precise 12-digit Saudi
ZATCA code with a confidence score.

Resolution order (deterministic first, LLM last):

  Path 1 · Direct master match
      Merchant declared a full 12-digit code that exists in HSCodeMaster.
      Fast-path, zero LLM cost. Confidence 0.98.

  Path 2 · Longest-prefix-wins traversal
      Partial code (4–11 digits). Generate prefix variants (11..4 digits),
      LEFT JOIN against HSCodeMaster, take the row with the longest matching
      prefix and the shortest resulting HS code. If ties persist at that
      length, RANKER_MODEL picks. Confidence 0.70 – 0.95 by prefix length.

  Path 3 · Reasoner (full inference)
      No usable declared code, or prefix traversal returned nothing. Embed
      the description, pull top-K FAISS candidates, attach Naqel's ledger
      hint (if any) as advisory context, and call REASONER_MODEL. Confidence
      is whatever the model returns, clamped by threshold.

Ledger behaviour (ADR-007):
    The Naqel hs_decision_ledger is NOT a short-circuit cache. A prefix match
    in the ledger is surfaced to the Reasoner as a bucket hint only. If the
    resolver's top candidate (path 1 or 2) disagrees with the Naqel bucket,
    both are recorded via `agrees_with_naqel = False` on the result, which
    the review queue surfaces.

Failure mode: anything that raises — bad LLM output, invalid code returned,
DB error — gets caught, confidence zeroed, and the row is flagged so the batch
continues. The resolver never crashes mid-file.
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from clearai import config
from clearai.ports.reasoner import (
    Candidate,
    HSReasoner,
    RankerInput,
    ReasonerError,
    ReasonerInput,
    ReasonerResult,
)
from clearai.services.complexity import (
    as_log_dict,
    compute_complexity_hint,
    should_escalate_ranker,
)

logger = logging.getLogger("clearai.hs_resolver")

# ---------------------------------------------------------------------------
# Resolution paths + confidence defaults
# ---------------------------------------------------------------------------
PATH_DIRECT = "direct"
PATH_PREFIX = "prefix"
PATH_REASONER = "reasoner"
PATH_FAILED = "failed"

# Deterministic-path confidence levels (ADR-003 / ADR-007).
CONF_DIRECT = 0.98
# Longest-prefix-wins confidence scales with prefix length.
# 12 digits handled by PATH_DIRECT; mapping is for 4..11.
CONF_PREFIX_BY_LEN: dict[int, float] = {
    11: 0.95,
    10: 0.92,
    9: 0.88,
    8: 0.85,
    7: 0.80,
    6: 0.78,
    5: 0.73,
    4: 0.70,
}

# Default FAISS top-K for Reasoner candidate context.
FAISS_TOP_K = 10

# Minimum declared-code length to consider a prefix lookup. Shorter than this,
# the code is too vague to use as a signal (e.g. 2-digit HS chapter is almost
# anything) and we go straight to the Reasoner.
MIN_PREFIX_LEN = 4

_DIGITS_RE = re.compile(r"\D")


# ---------------------------------------------------------------------------
# "Residual subheading" guardrail (bomber-jacket fix)
# ---------------------------------------------------------------------------
# Apparel/textile chapters whose subheading code `XX90` is the "of other
# textile materials" residual. When a prefix-path result lands on one of these
# subheadings AND the description names no fibre, we force an escalation to
# the Reasoner tier rather than silently accepting the residual bucket.
_APPAREL_TEXTILE_CHAPTERS = ("61", "62", "63", "64", "65")

# Fibre vocabulary — any hit suppresses the guardrail because the merchant
# has already declared a material. Tokens are matched as whole words /
# substrings so "all-cotton" still counts. Arabic tokens mirror the English
# set; Chinese is intentionally omitted — the CN pipeline translates first.
_FIBRE_TOKENS_EN = (
    "cotton", "wool", "cashmere", "silk", "linen", "flax", "ramie", "jute",
    "hemp", "polyester", "nylon", "acrylic", "rayon", "viscose", "spandex",
    "elastane", "lycra", "modal", "lyocell", "tencel", "acetate",
    "man-made", "man made", "synthetic", "microfibre", "microfiber",
    "fleece", "denim",  # denim ≈ cotton; fleece ≈ MMF
    "fur", "leather", "suede",
)
_FIBRE_TOKENS_AR = (
    "قطن",     # cotton
    "صوف",     # wool
    "كشمير",   # cashmere
    "حرير",    # silk
    "كتان",    # linen
    "بوليستر", # polyester
    "نايلون",  # nylon
    "أكريلك",  # acrylic
    "فسكوز",   # viscose
    "رايون",   # rayon
    "دنيم",    # denim
    "جلد",     # leather
    "فرو",     # fur
)


def _residual_subheading_without_fibre(
    hs_code: str, description: str
) -> bool:
    """True iff `hs_code` is an apparel/textile ...90 residual subheading AND
    `description` names no fibre.

    Rationale: the "of other textile materials" leaf is the catch-all for
    exotic fibres (silk blends, ramie, etc.), not the default when fibre is
    unknown. When the prefix tie-breaker (shortest-then-lexicographic)
    silently lands here with no fibre signal in the description, we'd rather
    escalate to the Reasoner — which has the material-inference rule and
    the fibre prior for archetypes like bomber jackets.
    """
    code = "".join(c for c in (hs_code or "") if c.isdigit())
    if len(code) < 6:
        return False
    if code[:2] not in _APPAREL_TEXTILE_CHAPTERS:
        return False
    # The "residual" marker sits at subheading level: digits 5-6 == "90".
    if code[4:6] != "90":
        return False
    text = (description or "").lower()
    if any(tok in text for tok in _FIBRE_TOKENS_EN):
        return False
    if any(tok in description for tok in _FIBRE_TOKENS_AR):
        return False
    return True


# ---------------------------------------------------------------------------
# Result shape
# ---------------------------------------------------------------------------
@dataclass
class Resolution:
    """Outcome of resolving one invoice row. Always populated, never raises."""

    hs_code: str                    # 12-digit or "" when path == failed
    confidence: float               # in [0.0, 1.0]
    path: str                       # direct | prefix | reasoner | failed
    rationale: str = ""
    agrees_with_naqel: bool | None = None
    naqel_bucket_hint: str | None = None
    model_used: str = ""
    flagged_for_review: bool = False
    error: str = ""                 # populated on path=failed

    def as_row(self) -> dict[str, Any]:
        """Shape used by review.csv / audit.log writers downstream."""
        return {
            "hs_code": self.hs_code,
            "confidence": round(self.confidence, 4),
            "path": self.path,
            "rationale": self.rationale,
            "agrees_with_naqel": self.agrees_with_naqel,
            "naqel_bucket_hint": self.naqel_bucket_hint,
            "model_used": self.model_used,
            "flagged_for_review": self.flagged_for_review,
            "error": self.error,
        }


# ---------------------------------------------------------------------------
# Resolver
# ---------------------------------------------------------------------------
class HSResolver:
    """Owns the DB connection, FAISS index, and the LLM reasoner.

    Construct once per batch run; call `resolve()` per invoice row.
    """

    def __init__(
        self,
        reasoner: HSReasoner,
        *,
        db_path: Path | None = None,
        faiss_index_path: Path | None = None,
        faiss_codes_path: Path | None = None,
        confidence_threshold: float | None = None,
        faiss_top_k: int = FAISS_TOP_K,
    ) -> None:
        self._reasoner = reasoner
        self._db_path = db_path or config.DB_PATH
        self._faiss_index_path = faiss_index_path or config.FAISS_INDEX_PATH
        self._faiss_codes_path = faiss_codes_path or config.FAISS_CODES_PATH
        self._threshold = (
            confidence_threshold
            if confidence_threshold is not None
            else config.CONFIDENCE_THRESHOLD
        )
        self._faiss_top_k = faiss_top_k

        # check_same_thread=False so FastAPI's threadpool workers can hit
        # the connection. Safe because ClearAI is read-dominant (master +
        # ledger); writes only happen during batch CLI runs that own their
        # own resolver instance. If concurrent writes ever appear, add a
        # threading.Lock around write paths rather than reverting this.
        self._conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row

        # FAISS + embedder are lazy — the first Reasoner call pays the load cost.
        self._faiss_index: Any | None = None
        self._faiss_codes: list[str] | None = None
        self._embedder: Any | None = None

    # ---- lifecycle -----------------------------------------------------
    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()

    def __enter__(self) -> "HSResolver":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ---- public entrypoint --------------------------------------------
    def resolve(self, row: dict[str, Any]) -> Resolution:
        """Resolve one invoice row. Never raises."""
        try:
            return self._resolve_unchecked(row)
        except Exception as e:  # noqa: BLE001 — batch robustness
            logger.exception("Unhandled error resolving row: %s", e)
            return Resolution(
                hs_code="",
                confidence=0.0,
                path=PATH_FAILED,
                flagged_for_review=True,
                error=f"{type(e).__name__}: {e}",
            )

    # ---- core path logic ----------------------------------------------
    def _resolve_unchecked(self, row: dict[str, Any]) -> Resolution:
        declared_raw = row.get("CustomsCommodityCode") or ""
        declared = _normalize_code(declared_raw)
        description_en = (row.get("Description") or "").strip()
        description_cn = (row.get("ChineseDescription") or "").strip()
        client_id = row.get("ClientID")

        # Naqel bucket hint — advisory only. Looked up on the declared raw code,
        # scoped to client_id when available.
        bucket_hint = self._lookup_naqel_bucket(declared, client_id) if declared else None
        bucket_hint_line = _format_bucket_hint(bucket_hint)

        # Path 1 — direct 12-digit match.
        if len(declared) == 12:
            direct = self._direct_match(declared)
            if direct is not None:
                return self._finalize(
                    hs_code=direct["hs_code"],
                    confidence=CONF_DIRECT,
                    path=PATH_DIRECT,
                    rationale="12-digit merchant code exists in HSCodeMaster.",
                    bucket_hint_line=bucket_hint_line,
                    bucket_verified_code=bucket_hint["verified_code"] if bucket_hint else None,
                )

        # Path 2 — longest-prefix-wins.
        if len(declared) >= MIN_PREFIX_LEN:
            prefix_match = self._longest_prefix_match(declared)
            if prefix_match is not None:
                hs_code, prefix_len, ties = prefix_match
                if len(ties) <= 1:
                    # Guardrail (bomber-jacket fix): when the deterministic
                    # winner is an apparel/textile ...90 residual subheading
                    # AND the description names no fibre, the prefix
                    # tiebreaker has silently landed on the "other textile
                    # materials" bucket. Escalate to the Reasoner tier —
                    # its material-inference rule encodes fibre priors for
                    # archetypes like bomber jackets (→ man-made fibres).
                    if _residual_subheading_without_fibre(hs_code, description_en):
                        logger.info(
                            "resolver.residual_escalate hs=%s prefix_len=%d "
                            "reason=residual_subheading_no_fibre",
                            hs_code, prefix_len,
                        )
                        escalated = self._escalate_to_reasoner(
                            description_en=description_en,
                            description_cn=description_cn,
                            declared=declared,
                            prefix_candidates=tuple(
                                Candidate(
                                    hs_code=r["hs_code"],
                                    description_en=r["description_en"] or "",
                                    description_ar=r["arabic_name"] or "",
                                    duty_rate=r["duty_rate_pct"],
                                    source="prefix",
                                    score=float(prefix_len),
                                )
                                for r in ties
                            ),
                            bucket_hint=bucket_hint,
                            bucket_hint_line=bucket_hint_line,
                            escalation_reason="residual_subheading_no_fibre",
                        )
                        if escalated is not None:
                            return escalated
                        # Reasoner unavailable — fall through to return the
                        # deterministic winner at reduced confidence so the
                        # row is flagged for review rather than silently
                        # accepted at full prefix confidence.
                        return self._finalize(
                            hs_code=hs_code,
                            confidence=min(
                                CONF_PREFIX_BY_LEN.get(prefix_len, 0.70), 0.60
                            ),
                            path=PATH_PREFIX,
                            rationale=(
                                f"Longest-prefix-wins at {prefix_len} digits, but "
                                f"landed on residual ...90 subheading with no fibre "
                                f"declared; Reasoner escalation unavailable — "
                                f"flagging for review."
                            ),
                            bucket_hint_line=bucket_hint_line,
                            bucket_verified_code=(
                                bucket_hint["verified_code"] if bucket_hint else None
                            ),
                        )
                    return self._finalize(
                        hs_code=hs_code,
                        confidence=CONF_PREFIX_BY_LEN.get(prefix_len, 0.70),
                        path=PATH_PREFIX,
                        rationale=f"Longest-prefix-wins at {prefix_len} digits "
                                  f"against HSCodeMaster.",
                        bucket_hint_line=bucket_hint_line,
                        bucket_verified_code=(
                            bucket_hint["verified_code"] if bucket_hint else None
                        ),
                    )
                # Path 2a — tie-break via Ranker (Sonnet).
                return self._rank_tied_candidates(
                    description_en=description_en,
                    description_cn=description_cn,
                    declared=declared,
                    ties=ties,
                    prefix_len=prefix_len,
                    bucket_hint=bucket_hint,
                    bucket_hint_line=bucket_hint_line,
                )

        # Path 3 — Reasoner (full inference).
        return self._reason_from_description(
            description_en=description_en,
            description_cn=description_cn,
            declared=declared,
            bucket_hint=bucket_hint,
            bucket_hint_line=bucket_hint_line,
        )

    # ---- DB lookups ----------------------------------------------------
    def _direct_match(self, hs_code: str) -> sqlite3.Row | None:
        cur = self._conn.execute(
            "SELECT hs_code, arabic_name, description_en, duty_rate_pct "
            "FROM hs_code_master WHERE hs_code = ?",
            (hs_code,),
        )
        return cur.fetchone()

    def _longest_prefix_match(
        self, declared: str
    ) -> tuple[str, int, list[sqlite3.Row]] | None:
        """Return (winning_hs_code, prefix_len, tied_rows_at_winning_length).

        Iterates candidate prefixes from longest (full declared length, capped
        at 11 since 12-digit exact hits take the `direct` path) down to
        MIN_PREFIX_LEN, returning the first length that has any master match.

        Bug-fix (P1 code-review): previously `max_len = len(declared) - 1`
        skipped the merchant's actual partial-code length entirely. A 4-digit
        declared code was never queried at len=4, and an 8-digit code like
        `61082100` was searched as `6108210`, `610821`, … never as itself.
        Now we start at the full declared length (capped at 11).

        Bug-fix (P1 code-review): removed `LIMIT 25` on the prefix query.
        For broad 4–6 digit prefixes the correct leaf often falls outside
        a 25-row lexicographically-earliest slice, causing the Ranker to
        never see it and the resolver to return a wrong code. Row count is
        bounded by chapter size (typically <1000 for a 4-digit prefix,
        <100 for 6-digit), which is safe to materialise in memory.
        """
        max_len = min(len(declared), 11)
        for p_len in range(max_len, MIN_PREFIX_LEN - 1, -1):
            prefix = declared[:p_len]
            cur = self._conn.execute(
                "SELECT hs_code, arabic_name, description_en, duty_rate_pct "
                "FROM hs_code_master "
                "WHERE hs_code LIKE ? "
                "ORDER BY LENGTH(hs_code) ASC, hs_code ASC",
                (prefix + "%",),
            )
            rows = cur.fetchall()
            if not rows:
                continue
            # Winner is the first row (shortest hs_code, then lexicographic).
            winner = rows[0]["hs_code"]
            # "Ties" = all rows at this prefix length; Ranker disambiguates if >1.
            return winner, p_len, rows
        return None

    def _lookup_naqel_bucket(
        self, declared: str, client_id: Any
    ) -> dict[str, Any] | None:
        """Return {raw_code, verified_code, arabic_name} bucket hint or None."""
        if not declared:
            return None
        # Scope to client_id when present, else fall back to any-client match.
        if client_id not in (None, ""):
            cur = self._conn.execute(
                "SELECT raw_code, verified_code, arabic_name "
                "FROM hs_decision_ledger "
                "WHERE client_id = ? AND raw_code = ? LIMIT 1",
                (str(client_id), declared),
            )
            row = cur.fetchone()
            if row is not None:
                return dict(row)
        cur = self._conn.execute(
            "SELECT raw_code, verified_code, arabic_name "
            "FROM hs_decision_ledger WHERE raw_code = ? LIMIT 1",
            (declared,),
        )
        row = cur.fetchone()
        return dict(row) if row is not None else None

    # ---- Ranker (tie-break) -------------------------------------------
    def _rank_tied_candidates(
        self,
        *,
        description_en: str,
        description_cn: str,
        declared: str,
        ties: list[sqlite3.Row],
        prefix_len: int,
        bucket_hint: dict[str, Any] | None,
        bucket_hint_line: str | None,
    ) -> Resolution:
        candidates = tuple(
            Candidate(
                hs_code=r["hs_code"],
                description_en=r["description_en"] or "",
                description_ar=r["arabic_name"] or "",
                duty_rate=r["duty_rate_pct"],
                source="prefix",
                score=float(prefix_len),
            )
            for r in ties
        )
        hint = compute_complexity_hint(
            text=description_en or description_cn,
            candidate_scores=None,           # prefix tie has no cosine scores
            candidate_count=len(candidates),
        )
        logger.info("ranker.complexity_hint %s", as_log_dict(hint))
        try:
            result = self._reasoner.rank_candidates(
                RankerInput(
                    description_en=description_en,
                    description_cn=description_cn,
                    declared_code=declared,
                    candidates=candidates,
                    complexity_hint=hint,
                )
            )
        except ReasonerError as e:
            logger.warning("Ranker failed, falling back to first candidate: %s", e)
            # Fallback: accept the first tied candidate with reduced confidence.
            return self._finalize(
                hs_code=candidates[0].hs_code,
                confidence=min(CONF_PREFIX_BY_LEN.get(prefix_len, 0.70), 0.70),
                path=PATH_PREFIX,
                rationale=f"Prefix tie at {prefix_len} digits; Ranker failed "
                          f"({e}), fell back to first candidate.",
                bucket_hint_line=bucket_hint_line,
                bucket_verified_code=(
                    bucket_hint["verified_code"] if bucket_hint else None
                ),
            )
        # The Ranker's code MUST be one of the tied candidates. The prior
        # behaviour was to log and accept — which violates the tie-break
        # contract and can let a hallucinated code escape into production
        # declarations. Bug-fix (P2 code-review): reject the out-of-set
        # answer and fall back to the deterministic first-candidate path
        # with reduced confidence, same as when the Ranker API errors.
        _tied_codes = {c.hs_code for c in candidates}
        if result.hs_code not in _tied_codes:
            logger.warning(
                "Ranker returned out-of-set code %s (tied=%s); rejecting and "
                "falling back to first candidate with reduced confidence",
                result.hs_code, sorted(_tied_codes),
            )
            return self._finalize(
                hs_code=candidates[0].hs_code,
                # Cap at 0.60 so _should_flag auto-routes this to review
                # (below the default 0.80 threshold).
                confidence=min(CONF_PREFIX_BY_LEN.get(prefix_len, 0.70), 0.60),
                path=PATH_PREFIX,
                rationale=(
                    f"Prefix tie at {prefix_len} digits; Ranker returned "
                    f"out-of-set code {result.hs_code!r}, rejected per "
                    f"tie-break contract; fell back to first candidate."
                ),
                bucket_hint_line=bucket_hint_line,
                bucket_verified_code=(
                    bucket_hint["verified_code"] if bucket_hint else None
                ),
            )

        # --- ADR-010: deterministic tier escalation -----------------------
        # If the Ranker's confidence is low AND the input matches a known
        # weak-spot pattern (wide tie or long Arabic-heavy text), redo the
        # call at the Reasoner tier with full evidence. Every escalation is
        # logged with its reason code so we can audit frequency + impact.
        should, reason = should_escalate_ranker(
            hint=hint,
            ranker_confidence=result.confidence,
            confidence_threshold=self._threshold,
        )
        if should:
            logger.info(
                "ranker.escalate reason=%s ranker_conf=%.3f threshold=%.3f",
                reason, result.confidence, self._threshold,
            )
            escalated = self._escalate_to_reasoner(
                description_en=description_en,
                description_cn=description_cn,
                declared=declared,
                prefix_candidates=candidates,
                bucket_hint=bucket_hint,
                bucket_hint_line=bucket_hint_line,
                escalation_reason=reason,
            )
            if escalated is not None:
                return escalated
            # Reasoner also failed — fall through to accept the Ranker's
            # result rather than hard-failing the row.

        return self._finalize_from_result(
            result=result,
            path=PATH_PREFIX,
            bucket_hint_line=bucket_hint_line,
            bucket_verified_code=(bucket_hint["verified_code"] if bucket_hint else None),
            fallback_rationale=f"Ranker disambiguated prefix-{prefix_len} tie.",
        )

    # ---- Tier escalation (Ranker → Reasoner) --------------------------
    def _escalate_to_reasoner(
        self,
        *,
        description_en: str,
        description_cn: str,
        declared: str,
        prefix_candidates: tuple[Candidate, ...],
        bucket_hint: dict[str, Any] | None,
        bucket_hint_line: str | None,
        escalation_reason: str,
    ) -> Resolution | None:
        """Call REASONER_MODEL with both FAISS + prefix candidates, returning
        `None` on failure so the caller can fall back to the Ranker's result.

        Used by the ADR-010 escalation rule at the Ranker site. The path
        stays PATH_PREFIX (not PATH_REASONER) because the resolution still
        originated from a merchant-declared prefix — the escalation just
        raised the tier used to disambiguate.
        """
        faiss_cands = self._faiss_top_candidates(
            description_en or description_cn, k=self._faiss_top_k
        )
        hint = compute_complexity_hint(
            text=description_en or description_cn,
            candidate_scores=[c.score or 0.0 for c in faiss_cands],
            candidate_count=len(faiss_cands),
        )
        try:
            result = self._reasoner.infer_hs_code(
                ReasonerInput(
                    description_en=description_en,
                    description_cn=description_cn,
                    declared_code=declared,
                    faiss_candidates=faiss_cands,
                    prefix_candidates=prefix_candidates,
                    naqel_bucket_hint=bucket_hint_line,
                    complexity_hint=hint,
                )
            )
        except ReasonerError as e:
            logger.warning("Escalated Reasoner call failed: %s", e)
            return None
        return self._finalize_from_result(
            result=result,
            path=PATH_PREFIX,  # escalation ≠ Path-3; see docstring
            bucket_hint_line=bucket_hint_line,
            bucket_verified_code=(bucket_hint["verified_code"] if bucket_hint else None),
            fallback_rationale=(
                f"Ranker tier escalated to Reasoner ({escalation_reason})."
            ),
        )

    # ---- Reasoner (full inference) ------------------------------------
    def _reason_from_description(
        self,
        *,
        description_en: str,
        description_cn: str,
        declared: str,
        bucket_hint: dict[str, Any] | None,
        bucket_hint_line: str | None,
    ) -> Resolution:
        if not description_en and not description_cn:
            return Resolution(
                hs_code="",
                confidence=0.0,
                path=PATH_FAILED,
                flagged_for_review=True,
                naqel_bucket_hint=bucket_hint_line,
                error="No declared code, no description — nothing to classify.",
            )
        faiss_cands = self._faiss_top_candidates(
            description_en or description_cn, k=self._faiss_top_k
        )
        hint = compute_complexity_hint(
            text=description_en or description_cn,
            candidate_scores=[c.score or 0.0 for c in faiss_cands],
            candidate_count=len(faiss_cands),
        )
        logger.info("reasoner.complexity_hint %s", as_log_dict(hint))
        try:
            result = self._reasoner.infer_hs_code(
                ReasonerInput(
                    description_en=description_en,
                    description_cn=description_cn,
                    declared_code=declared,
                    faiss_candidates=faiss_cands,
                    prefix_candidates=(),
                    naqel_bucket_hint=bucket_hint_line,
                    complexity_hint=hint,
                )
            )
        except ReasonerError as e:
            logger.warning("Reasoner failed for row (declared=%r): %s", declared, e)
            return Resolution(
                hs_code="",
                confidence=0.0,
                path=PATH_FAILED,
                flagged_for_review=True,
                naqel_bucket_hint=bucket_hint_line,
                error=f"Reasoner error: {e}",
            )
        return self._finalize_from_result(
            result=result,
            path=PATH_REASONER,
            bucket_hint_line=bucket_hint_line,
            bucket_verified_code=(bucket_hint["verified_code"] if bucket_hint else None),
            fallback_rationale="Reasoner classification from description + FAISS candidates.",
        )

    # ---- FAISS --------------------------------------------------------
    # ------------------------------------------------------------------
    # Public evidence accessors — used by the API to render the Case 001
    # "Evidence trail" table without re-implementing FAISS retrieval.
    # ------------------------------------------------------------------
    def faiss_evidence(self, text: str, *, k: int = FAISS_TOP_K) -> tuple[Candidate, ...]:
        """Return the top-K FAISS candidates for `text` without routing through
        the Reasoner. Read-only; safe to call independently of resolve()."""
        return self._faiss_top_candidates(text, k=k)

    def hs_code_ladder(self, hs_code: str) -> list[dict[str, Any]]:
        """Build a 4-rung plain-English classification ladder for `hs_code`.

        Strategy per rung:
          - 2-digit (chapter): canonical WCO chapter title from hs_chapters.
            The ZATCA master only carries 12-digit tariff lines — it has
            no chapter-level row — so a DB lookup alone would surface an
            arbitrary 15.01 row ("Pig fat") for chapter 15 instead of
            the true title ("Animal/vegetable fats and oils"). See ADR
            note in hs_chapters.py.
          - 4-digit (heading) and 6-digit (subheading): zero-pad the slice
            to 12 digits and look up the master row directly. ZATCA stores
            heading-level text at `####00000000` and subheading-level text
            at `######000000`, so this is always the authoritative title.
          - 12-digit (exact line): the user's resolved code itself.

        Never invents text: if a rung can't be resolved, it is skipped.
        """
        from clearai.services.hs_chapters import chapter_title  # local import

        code = "".join(c for c in hs_code if c.isdigit())
        if len(code) != 12:
            return []

        out: list[dict[str, Any]] = []

        # --- Rung 1: chapter (2-digit) — canonical WCO title -----------
        title = chapter_title(code[:2])
        if title is not None:
            en, ar = title
            out.append(
                {
                    "level": "The big category",
                    "code": code[:2],
                    "description_en": en,
                    "description_ar": ar,
                }
            )

        # --- Rungs 2, 3, 4: heading / subheading / exact line ----------
        for label, n in (("The family", 4), ("The sub-family", 6), ("Your exact item", 12)):
            # Zero-pad to 12 digits so the key matches ZATCA's storage
            # convention (##########0000 for heading-level rows).
            padded = code[:n].ljust(12, "0")
            cur = self._conn.execute(
                "SELECT hs_code, description_en, arabic_name "
                "FROM hs_code_master WHERE hs_code = ? LIMIT 1",
                (padded,),
            )
            row = cur.fetchone()
            if row is None and n < 12:
                # ZATCA's nomenclature sometimes uses a different padding
                # convention for a given heading (e.g. ####10000000 instead
                # of ####00000000). Fall back to the shortest master row
                # under this prefix — it'll be one of the first
                # subheadings, which carries the heading-level text.
                cur = self._conn.execute(
                    "SELECT hs_code, description_en, arabic_name "
                    "FROM hs_code_master WHERE hs_code LIKE ? "
                    "ORDER BY hs_code ASC LIMIT 1",
                    (code[:n] + "%",),
                )
                row = cur.fetchone()
            if row is None:
                continue
            out.append(
                {
                    "level": label,
                    "code": code[:n],
                    "description_en": row["description_en"] or "",
                    "description_ar": row["arabic_name"] or "",
                }
            )
        return out

    def master_row(self, hs_code: str) -> dict[str, Any] | None:
        """Fetch a single master row as a plain dict. Used by the API to
        surface the customs description for a resolved code."""
        cur = self._conn.execute(
            "SELECT hs_code, description_en, arabic_name, duty_rate_pct "
            "FROM hs_code_master WHERE hs_code = ?",
            (hs_code,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        return {
            "hs_code": row["hs_code"],
            "description_en": row["description_en"] or "",
            "arabic_name": row["arabic_name"] or "",
            "duty_rate_pct": row["duty_rate_pct"],
        }

    # ---- internal ----------------------------------------------------
    def _faiss_top_candidates(self, text: str, *, k: int) -> tuple[Candidate, ...]:
        """Embed the description, retrieve top-K from the FAISS index,
        and hydrate each with master metadata."""
        if not text.strip():
            return ()
        index, codes, embedder = self._ensure_faiss_loaded()
        import numpy as np  # lazy

        vec = embedder.encode([text], normalize_embeddings=True)
        vec = np.asarray(vec, dtype="float32")
        scores, indexes = index.search(vec, k)
        picked_codes: list[str] = []
        picked_scores: list[float] = []
        for score, idx in zip(scores[0], indexes[0]):
            if idx < 0 or idx >= len(codes):
                continue
            picked_codes.append(codes[idx])
            picked_scores.append(float(score))
        if not picked_codes:
            return ()

        placeholders = ",".join("?" for _ in picked_codes)
        cur = self._conn.execute(
            f"SELECT hs_code, arabic_name, description_en, duty_rate_pct "
            f"FROM hs_code_master WHERE hs_code IN ({placeholders})",
            tuple(picked_codes),
        )
        by_code = {r["hs_code"]: r for r in cur.fetchall()}
        out: list[Candidate] = []
        for code, score in zip(picked_codes, picked_scores):
            row = by_code.get(code)
            if row is None:
                continue
            out.append(
                Candidate(
                    hs_code=code,
                    description_en=row["description_en"] or "",
                    description_ar=row["arabic_name"] or "",
                    duty_rate=row["duty_rate_pct"],
                    source="faiss",
                    score=score,
                )
            )
        return tuple(out)

    def _ensure_faiss_loaded(self) -> tuple[Any, list[str], Any]:
        if self._faiss_index is not None and self._faiss_codes is not None and self._embedder is not None:
            return self._faiss_index, self._faiss_codes, self._embedder
        import faiss  # lazy — expensive import
        from sentence_transformers import SentenceTransformer  # lazy

        logger.info("Loading FAISS index from %s", self._faiss_index_path)
        self._faiss_index = faiss.read_index(str(self._faiss_index_path))
        meta = json.loads(Path(self._faiss_codes_path).read_text())
        self._faiss_codes = list(meta["codes"])
        self._embedder = SentenceTransformer(meta["model"])
        if self._faiss_index.ntotal != len(self._faiss_codes):
            raise RuntimeError(
                f"FAISS index / codes mismatch: index.ntotal={self._faiss_index.ntotal} "
                f"vs codes={len(self._faiss_codes)}"
            )
        return self._faiss_index, self._faiss_codes, self._embedder

    # ---- Result packaging ---------------------------------------------
    def _finalize(
        self,
        *,
        hs_code: str,
        confidence: float,
        path: str,
        rationale: str,
        bucket_hint_line: str | None,
        bucket_verified_code: str | None,
    ) -> Resolution:
        agrees = _compare_with_bucket(hs_code, bucket_verified_code)
        flagged = _should_flag(
            confidence=confidence,
            threshold=self._threshold,
            agrees_with_naqel=agrees,
        )
        return Resolution(
            hs_code=hs_code,
            confidence=confidence,
            path=path,
            rationale=rationale,
            agrees_with_naqel=agrees,
            naqel_bucket_hint=bucket_hint_line,
            flagged_for_review=flagged,
        )

    def _finalize_from_result(
        self,
        *,
        result: ReasonerResult,
        path: str,
        bucket_hint_line: str | None,
        bucket_verified_code: str | None,
        fallback_rationale: str,
    ) -> Resolution:
        agrees = (
            result.agrees_with_naqel
            if result.agrees_with_naqel is not None
            else _compare_with_bucket(result.hs_code, bucket_verified_code)
        )
        flagged = _should_flag(
            confidence=result.confidence,
            threshold=self._threshold,
            agrees_with_naqel=agrees,
        )
        return Resolution(
            hs_code=result.hs_code,
            confidence=result.confidence,
            path=path,
            rationale=result.rationale or fallback_rationale,
            agrees_with_naqel=agrees,
            naqel_bucket_hint=bucket_hint_line,
            model_used=result.model_used,
            flagged_for_review=flagged,
        )


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------
def _normalize_code(raw: Any) -> str:
    """Strip non-digits from a merchant-declared code."""
    if raw is None:
        return ""
    return _DIGITS_RE.sub("", str(raw))


def _format_bucket_hint(bucket: dict[str, Any] | None) -> str | None:
    if not bucket:
        return None
    vc = bucket.get("verified_code") or ""
    ar = bucket.get("arabic_name") or ""
    if ar:
        return f"Naqel historically declares {vc} ({ar}) for merchant code {bucket.get('raw_code')}"
    return f"Naqel historically declares {vc} for merchant code {bucket.get('raw_code')}"


def _compare_with_bucket(hs_code: str, bucket_code: str | None) -> bool | None:
    if not bucket_code:
        return None
    return hs_code == bucket_code


def _should_flag(
    *,
    confidence: float,
    threshold: float,
    agrees_with_naqel: bool | None,
) -> bool:
    """Flag rule:
    - Below threshold → flag.
    - Above threshold but disagrees with Naqel's bucket → flag (high-value review).
    - Above threshold and either agrees or no bucket to compare → accept.
    """
    if confidence < threshold:
        return True
    if agrees_with_naqel is False:
        return True
    return False
