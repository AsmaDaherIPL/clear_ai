/**
 * Stage 5 + heading-level promotion (ADR-0011, ADR-0019, V3-tightened).
 *
 * Runs the best-effort fallback when the main pipeline didn't reach an
 * `accepted` decision and the feature flag is on, then optionally
 * promotes a 4-digit heading match to `accepted` when retrieval agrees
 * (V3 family-agreement gate, ADR-0020).
 *
 * Tail end of the route's LLM work — pulled out of describe.ts so the
 * 100+ lines of state-mutation around `accepted` / `decision` /
 * `headingLevelPromoted` live in one place. The route applies the
 * returned mutations to its `decision` object so downstream alternatives
 * + response builders see the promoted state.
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

/**
 * What the route needs to apply after the stage runs. The stage doesn't
 * mutate the caller's `decision` directly — it returns a patch so
 * mutation stays explicit at the call site.
 */
export interface DecisionPatch {
  decisionStatus?: ResolveOutput['decisionStatus'];
  decisionReason?: ResolveOutput['decisionReason'];
  confidenceBand?: ResolveOutput['confidenceBand'];
  chosenCode?: string;
  rationale?: string;
}

export interface BestEffortStageResult {
  bestEffort: BestEffortOutcome | null;
  /** The best-effort outcome IFF still active (i.e. not promoted, not no-signal). */
  accepted: Extract<BestEffortOutcome, { kind: 'ok' }> | null;
  /** True when best-effort returned an all-zero code — route to needs_clarification. */
  noSignalBestEffort: boolean;
  /** Populated IFF heading-level promotion fired. The route uses this for description lookups. */
  headingLevelPromoted: HeadingLevelPromotion | null;
  /** When non-empty, route mutates its decision object with these fields. */
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
    // Best-effort is an extraction task — "given this text, pick a
    // 2/4-digit HS chapter." It's not legal reasoning. Haiku handles it
    // ~3-5x faster than Sonnet (~1-2s vs 5-8s) with no quality loss
    // (verified against the eval set). Saves a noticeable chunk of the
    // worst-case latency tail on inputs that miss the gate.
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

  // If the fallback succeeded, the intermediate `accepted` variable
  // narrows the discriminated union for downstream use.
  let accepted: Extract<BestEffortOutcome, { kind: 'ok' }> | null =
    bestEffort && bestEffort.kind === 'ok' ? bestEffort : null;

  // No-signal guard: an all-zero code (e.g. "00", "0000", "000000000000")
  // is the LLM saying "no product cue here" (typical for a personal
  // name). Route as needs_clarification, not best_effort.
  let noSignalBestEffort = false;
  if (accepted && /^0+$/.test(accepted.code)) {
    noSignalBestEffort = true;
    accepted = null;
  }

  // Heading-level promotion: when best-effort identified a 4-digit
  // chapter heading AND retrieval agrees on the same heading family,
  // ZATCA accepts <heading>00000000 as a valid declaration with a
  // published duty rate — promote to a real accepted result.
  let headingLevelPromoted: HeadingLevelPromotion | null = null;
  const decisionPatch: DecisionPatch = {};

  if (accepted && accepted.specificity === 4 && /^\d{4}$/.test(accepted.code)) {
    // V3 family-agreement gate: retrieval must have surfaced at least one
    // candidate in the same heading family. Stops the trust-laundering
    // path (best-effort overrules retrieval, promotion launders that into
    // accepted).
    const acceptedCode = accepted.code;
    const familyAgreement = candidates.some((c) => c.code.slice(0, 4) === acceptedCode);
    const headingCode = `${acceptedCode}00000000`;
    const pool = getPool();
    const r = await pool.query<{
      description_en: string | null;
      description_ar: string | null;
    }>(
      `SELECT description_en, description_ar FROM hs_codes WHERE code = $1 AND is_leaf = true`,
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
      // Suppress the best_effort path so downstream code emits the
      // standard accepted envelope instead.
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
