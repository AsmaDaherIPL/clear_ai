/**
 * Best-effort fallback stage. Promotes a 4-digit heading to `accepted` when
 * retrieval surfaced a candidate in the same heading family.
 */
import { bestEffortHeading, type BestEffortOutcome } from '../best-effort-fallback.js';
import { isEnabled, type Thresholds } from '../../catalog/setup-meta.js';
import { env } from '../../config/env.js';
import { getPool } from '../../db/client.js';
import type { Candidate } from '../../retrieval/retrieve.js';
import type { ResolveOutput } from '../resolve.js';
import type { ModelCallTrace } from '../../llm/structured-call.js';

export interface HeadingLevelPromotion {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  rationale: string;
  missingHint: string;
}

/** Returned to the caller; applied at the call site to keep mutations explicit. */
export interface DecisionPatch {
  decisionStatus?: ResolveOutput['decisionStatus'];
  decisionReason?: ResolveOutput['decisionReason'];
  confidenceBand?: ResolveOutput['confidenceBand'];
  chosenCode?: string;
  rationale?: string;
}

export interface BestEffortStageResult {
  bestEffort: BestEffortOutcome | null;
  /** Set IFF still active (not promoted, not no-signal). */
  accepted: Extract<BestEffortOutcome, { kind: 'ok' }> | null;
  /** True when best-effort returned an all-zero code. */
  noSignalBestEffort: boolean;
  headingLevelPromoted: HeadingLevelPromotion | null;
  decisionPatch: DecisionPatch;
}

export async function runBestEffortStage(params: {
  description: string;
  thresholds: Thresholds;
  decision: ResolveOutput;
  candidates: Candidate[];
  modelCalls: ModelCallTrace[];
}): Promise<BestEffortStageResult> {
  const { description, thresholds: t, decision, candidates, modelCalls } = params;

  let bestEffort: BestEffortOutcome | null = null;
  const needsFallback =
    isEnabled(t, 'BEST_EFFORT_ENABLED') && decision.decisionStatus !== 'accepted';

  if (needsFallback) {
    bestEffort = await bestEffortHeading({
      rawInput: description,
      maxDigits: t.BEST_EFFORT_MAX_DIGITS,
      maxTokens: t.BEST_EFFORT_MAX_TOKENS,
      model: env().LLM_MODEL,
    });
    modelCalls.push({
      model: bestEffort.model,
      latency_ms: bestEffort.latencyMs,
      stage: 'best_effort',
      status: bestEffort.kind === 'ok' ? 'ok' : 'error',
    });
  }

  let accepted: Extract<BestEffortOutcome, { kind: 'ok' }> | null =
    bestEffort && bestEffort.kind === 'ok' ? bestEffort : null;

  // All-zero code = LLM said "no product cue here" → route to needs_clarification.
  let noSignalBestEffort = false;
  if (accepted && /^0+$/.test(accepted.code)) {
    noSignalBestEffort = true;
    accepted = null;
  }

  // Heading-level promotion: 4-digit chapter + retrieval agrees → padded leaf accepted.
  let headingLevelPromoted: HeadingLevelPromotion | null = null;
  const decisionPatch: DecisionPatch = {};

  if (accepted && accepted.specificity === 4 && /^\d{4}$/.test(accepted.code)) {
    const acceptedCode = accepted.code;
    const familyAgreement = candidates.some((c) => c.code.slice(0, 4) === acceptedCode);
    const headingCode = `${acceptedCode}00000000`;
    const pool = getPool();
    const r = await pool.query<{
      description_en: string | null;
      description_ar: string | null;
    }>(
      // is_leaf filter dropped in 0029 — every hs_codes row is HS-12 leaf.
      `SELECT description_en, description_ar FROM hs_codes WHERE code = $1`,
      [headingCode],
    );
    const row = r.rows[0];
    if (row && familyAgreement) {
      headingLevelPromoted = {
        code: headingCode,
        description_en: row.description_en,
        description_ar: row.description_ar,
        rationale: `${accepted.rationale} Accepted at heading level (${acceptedCode}) — ZATCA accepts this code as a valid declaration. Adding the missing classification attribute (typically material) would refine to a sub-heading.`,
        missingHint:
          'Adding the material (e.g. leather / textile / plastic) to your input would refine this to a sub-heading.',
      };
      accepted = null;
      decisionPatch.decisionStatus = 'accepted';
      decisionPatch.decisionReason = 'heading_level_match';
      decisionPatch.confidenceBand = 'medium';
      decisionPatch.chosenCode = headingCode;
      decisionPatch.rationale = headingLevelPromoted.rationale;
    }
  }

  return {
    bestEffort,
    accepted,
    noSignalBestEffort,
    headingLevelPromoted,
    decisionPatch,
  };
}
