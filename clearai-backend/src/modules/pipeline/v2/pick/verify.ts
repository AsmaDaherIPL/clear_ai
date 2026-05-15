/**
 * Pipeline rewrite — Stage 8: verifier (PR 10).
 *
 * PURE FUNCTION. No I/O. No LLM. No async. Deterministic.
 *
 * Per Q4 decisions 2026-05-15: 2 rules only (rule 2 from the original
 * spec — identity_tokens absent from leaf — deferred until tokens are
 * classified into discriminators vs anchors).
 *
 * Rules:
 *   1. identify_chapter_disagreement — fires when identify is
 *      clean_product with confidence ≥ 0.90 AND identify.family_chapter
 *      is set AND pick's chapter ≠ identify's chapter
 *      Rationale: identify is genuinely confident in a different chapter
 *      from the picker → the picker may have chosen from the wrong arm.
 *      Threshold 0.90 (tighter than scope_selection's 0.85) because
 *      verifier vetoes the picker's decision — we want HIGH confidence
 *      before doing that.
 *
 *   2. confidence_inversion — fires when picker confidence is low
 *      (≤ 0.55, i.e. picked a `partial` fit) AND identify confidence is
 *      very high (≥ 0.92)
 *      Rationale: identify is sure what the product is, but picker only
 *      found a partial match → the candidate set may not contain the
 *      right code. Operator review can confirm.
 *
 * Output routing:
 *   PASS       — 0 rules triggered → row routes to ACCEPT (or FLAG if
 *                downstream sanity_check disagrees)
 *   UNCERTAIN  — ≥1 rule triggered → row routes to FLAG (operator review,
 *                separate queue from sanity FLAG)
 *
 * Verifier NEVER changes pick.final_code. It is a routing input only.
 * No FAIL state — that would require rule 3 (identity_tokens absent
 * from leaf) which is deferred.
 */
import type {
  IdentifyResult,
  PickAccepted,
  VerifierResult,
  VerifierRuleId,
} from '../types.js';

/** Confidence threshold for rule 1 (chapter disagreement). Tighter than scope_selection's 0.85. */
const IDENTIFY_CONFIDENCE_THRESHOLD_RULE1 = 0.90;

/** Threshold for rule 2 (confidence inversion). */
const PICKER_CONFIDENCE_LOW_THRESHOLD = 0.55;
const IDENTIFY_CONFIDENCE_HIGH_THRESHOLD = 0.92;

/**
 * Verify a picker's accepted decision against identify's view.
 * Returns PASS or UNCERTAIN. Never overrides the picker's code.
 */
export function verifyClassification(
  pick: PickAccepted,
  identify: IdentifyResult,
): VerifierResult {
  const triggered: VerifierRuleId[] = [];

  // Rule 1: identify high-confidence chapter ≠ picked chapter
  if (
    identify.kind === 'clean_product' &&
    identify.confidence >= IDENTIFY_CONFIDENCE_THRESHOLD_RULE1 &&
    identify.family_chapter !== null
  ) {
    const pickedChapter = pick.final_code.slice(0, 2);
    if (pickedChapter !== identify.family_chapter) {
      triggered.push('identify_chapter_disagreement');
    }
  }

  // Rule 2: confidence inversion (picker partial + identify very confident)
  if (
    pick.confidence <= PICKER_CONFIDENCE_LOW_THRESHOLD &&
    identify.kind === 'clean_product' &&
    identify.confidence >= IDENTIFY_CONFIDENCE_HIGH_THRESHOLD
  ) {
    triggered.push('confidence_inversion');
  }

  return {
    result: triggered.length >= 1 ? 'UNCERTAIN' : 'PASS',
    rules_triggered: triggered,
  };
}
