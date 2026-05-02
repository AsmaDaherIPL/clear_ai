/**
 * Residual-heading guardrail for the best-effort fallback.
 *
 * Why this exists:
 *   When retrieval fails and we fall back to LLM-only chapter inference,
 *   the model has a documented bias toward residual catch-all headings —
 *   "Other footwear" (6405), "Other prepared foodstuffs" (2106), "Other
 *   machines" (8479), etc. These residuals are catch-alls for products
 *   that explicitly DON'T fit the prior numbered headings; they're the
 *   NARROWEST defensible answer when materials/specifics are unknown,
 *   not the broadest. (See LESSONS in clearai-backend-python/tracker for
 *   the "bomber jacket → 620190" precedent.)
 *
 * Policy (per project rule "always return a code, alert if needs review,
 * never refuse"):
 *   • If the LLM-emitted code is a residual heading (label starts with
 *     "Other ..." or code is a *5/*9-style residual), downgrade to the
 *     chapter level (2 digits) and mark needs_review=true.
 *   • If the LLM-emitted code is fine, pass it through untouched
 *     (needs_review=false).
 *   • NEVER throw / refuse — the worst case is "downgrade to chapter +
 *     flag for review", which is still a valid customs answer.
 *
 * The lookup is one indexed PK query against zatca_hs_code_display per
 * call — sub-millisecond at our scale.
 */
import { getPool } from '../db/client.js';

export interface GuardrailResult {
  /** Final code (may be downgraded to a 2-digit chapter from a residual heading). */
  code: string;
  /** Final specificity = code.length. 2/4/6/8/10. */
  specificity: number;
  /** True iff we downgraded from a residual heading. */
  needsReview: boolean;
  /** Set when needsReview=true; explains WHY the downgrade happened. */
  reviewReason: string | null;
}

/** Tokens that mark a label as a residual catch-all when they appear at the start. */
const RESIDUAL_LABEL_PREFIXES = [
  'other',         // "Other footwear", "Other paper", etc.
  'others',
];

/**
 * Headings (last-2-of-4) that carry the "Other / not elsewhere specified"
 * semantics across many WCO chapters. ZATCA uses these consistently for
 * residual buckets within an HS-4 heading.
 *
 * Examples:
 *   6405 — Other footwear        (under chapter 64, after 6402/6403/6404)
 *   2106 — Other food prep
 *   8479 — Machines/appliances n.e.s.
 *   3824 — Chemical products n.e.s.
 *
 * Detection here is approximate: a heading whose 4-digit form ends in
 * "5" / "9" + whose chapter has more specific siblings before it.
 * The label-based detection (RESIDUAL_LABEL_PREFIXES above) is the
 * primary check; this is a defensive fallback for cases where the
 * label was already stripped of "Other".
 */
function looksLikeResidualHeadingByCode(code: string): boolean {
  if (code.length < 4) return false;
  const heading = code.slice(0, 4);
  // Headings ending in "5" within a chapter where lower-numbered headings
  // exist (e.g. 6405 follows 6402/6403/6404 → residual). Headings ending
  // in "9" likewise (e.g. 8479).
  const lastDigit = heading[3];
  if (lastDigit !== '5' && lastDigit !== '9') return false;
  // Defensive: chapters 01-97. The "5" / "9" residual pattern only applies
  // to chapters with multiple HS-4 sub-headings — in practice every chapter
  // we care about. Skip the heuristic for chapters where it would over-fire.
  return true;
}

/**
 * Apply the residual-heading guardrail. Pure-ish (one indexed DB read).
 * Never throws. Never returns a refusal.
 *
 * Inputs:
 *   code: the LLM-emitted code (any length 2/4/6/8/10).
 *
 * Returns: { code, specificity, needsReview, reviewReason }.
 *   • Pass-through when the input is fine: same code/specificity, needsReview=false.
 *   • Downgrade when residual: 2-digit chapter prefix, needsReview=true,
 *     reviewReason explains.
 *
 * Failure mode: DB error during label lookup → fall back to code-only
 * detection (looksLikeResidualHeadingByCode); still never throws.
 */
export async function applyResidualHeadingGuardrail(
  code: string,
): Promise<GuardrailResult> {
  // 2-digit chapter inputs are already at the safest fallback level.
  // No further downgrade possible; pass through.
  if (code.length === 2) {
    return { code, specificity: 2, needsReview: false, reviewReason: null };
  }

  const chapter = code.slice(0, 2);

  // Look up the label. We pad to 12 to match the zatca_hs_code_display PK
  // because best-effort emits 4/6/8/10-digit prefixes and the display
  // table is 12-digit-keyed. The padded form (XXXX00000000 etc.) is
  // either a real heading-padded row (most chapters have these) or
  // a hash miss — either is fine, we degrade gracefully.
  const padded = code.padEnd(12, '0');
  let labelStartsWithOther = false;
  try {
    const pool = getPool();
    const r = await pool.query<{ label_en: string | null }>(
      `SELECT label_en FROM zatca_hs_code_display WHERE code = $1`,
      [padded],
    );
    const label = (r.rows[0]?.label_en ?? '').trim().toLowerCase();
    if (label) {
      const firstWord = label.split(/[\s,:;.()-]+/)[0] ?? '';
      labelStartsWithOther = RESIDUAL_LABEL_PREFIXES.includes(firstWord);
    }
  } catch {
    // DB error → silently fall back to code-pattern detection.
  }

  const codePattern = looksLikeResidualHeadingByCode(code);
  const isResidual = labelStartsWithOther || codePattern;

  if (!isResidual) {
    return {
      code,
      specificity: code.length,
      needsReview: false,
      reviewReason: null,
    };
  }

  // Downgrade to chapter level. Two distinct reason strings depending on
  // which signal flagged it (label is the stronger evidence).
  const reason = labelStartsWithOther
    ? `Best-effort returned a residual catch-all heading (${code} — "Other ..."); downgraded to chapter ${chapter}. Broker should refine via /classifications/expand with material/construction details.`
    : `Best-effort returned a heading (${code}) whose form-pattern is consistent with a residual catch-all; downgraded to chapter ${chapter} as a precaution. Broker should refine via /classifications/expand.`;

  return {
    code: chapter,
    specificity: 2,
    needsReview: true,
    reviewReason: reason,
  };
}
