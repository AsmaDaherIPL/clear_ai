/**
 * Typed contracts for the pick stage (PR-A-4).
 *
 * Replaces the legacy retrieval + threshold + picker chain with one
 * scope-anchored retrieval + one Sonnet picker call. The picker
 * prompt simplifies to a 3-value fit verdict (fits | partial |
 * does_not_fit) because constrain has already anchored retrieval to
 * the right chapter neighborhood — chapter_adjacent and
 * partial_family verdicts (legacy PR4) are no longer needed.
 */
import type { IdentifyResult } from '../identify/identify.types.js';
import type { ConstrainResult } from '../constrain/constrain.types.js';

export interface PickInput {
  identify: IdentifyResult;
  constrain: ConstrainResult;
}

/**
 * Per-call audit metadata for the pick stage. Every code path
 * produces a trace row (matches the pattern from identify and
 * constrain) so PR-A-5's orchestrator can record audit fields
 * uniformly.
 */
export interface PickCallTrace {
  /** Whether the picker LLM call fired. False on escalate-without-LLM paths. */
  llm_called: boolean;
  /** Total wall-clock latency for retrieval + LLM in milliseconds. */
  latency_ms: number;
  /** Number of candidates returned by retrieval. 0 when retrieval was skipped. */
  candidate_count: number;
  /**
   * Status of the picker LLM call:
   *  - 'ok'       — LLM returned text and verdicts
   *  - 'error'    — transport-level error
   *  - 'timeout'  — request timed out
   *  - 'parse'    — LLM returned ok but verdicts could not be parsed
   *  - 'skipped'  — no LLM call (escalate-without-LLM path)
   */
  status: 'ok' | 'error' | 'timeout' | 'parse' | 'skipped';
  /**
   * Model identifier returned by the LLM transport. Null when no
   * call fired (skipped) or when the transport produced no model
   * string.
   */
  model: string | null;
  /**
   * Propagated from the scope: when true, the orchestrator should
   * flag this row for audit (e.g. dirty-override-overridden-by-
   * identify, LLM-pick-failed-on-merchant-prefix).
   */
  audit_flag: boolean;
}

/**
 * Population summary of picker verdicts. Surfaced on PickResult.accepted
 * so PR-A-5 can compute spread-aware confidence (per PR1's design) by
 * combining (fits, partial, does_not_fit) counts with the scope kind
 * and identity-token signal — without re-querying the picker.
 */
export interface VerdictPopulation {
  fits: number;
  partial: number;
  does_not_fit: number;
}

export type PickResult =
  | {
      kind: 'accepted';
      final_code: string;
      /**
       * Confidence in [0, 1] reflecting picker's verdict strength.
       * `fits` → FITS_CONFIDENCE; `partial` → PARTIAL_CONFIDENCE.
       * Coarse scalar today; PR-A-5 can compute a spread-aware
       * value from `verdict_population` without re-querying.
       */
      confidence: number;
      /**
       * Short string naming the decisive GIR rule, when the picker
       * cited one. Empty string when no GIR was the deciding factor.
       */
      gir_applied: string;
      /**
       * The verdict's fit level. Carried into the trace for audit.
       * 'fits' = picker endorsed this leaf; 'partial' = best
       * available, leaf might be right but description didn't
       * fully confirm.
       */
      fit: 'fits' | 'partial';
      /**
       * Counts of each verdict label across the candidate set the
       * picker scored. Used by PR-A-5 to compute spread-aware
       * confidence (preserves PR1's picker_confidence semantics).
       */
      verdict_population: VerdictPopulation;
      trace: PickCallTrace;
    }
  | {
      kind: 'escalate';
      reason:
        /** Scope said "escalate" before retrieval — no defensible anchor */
        | 'scope_escalate'
        /** Retrieval returned zero candidates */
        | 'no_candidates'
        /**
         * No description-side signal to drive the picker. Fired when
         * identify produced kind='uninformative' or 'multi_product'
         * AND scope routed retrieval (i.e. there's a merchant prefix
         * to anchor on). Avoids an empty-query LLM call that would
         * waste budget and produce unauditable guesses. Matches the
         * pattern PR-A-3 established in resolve-merchant.ts.
         */
        | 'identify_no_query'
        /** LLM returned all does_not_fit verdicts or no positive verdict */
        | 'no_candidate_fits'
        /**
         * LLM transport failure (error/timeout) OR unparseable
         * response. Discriminator on the underlying cause lives in
         * `trace.status` ('error' | 'timeout' | 'parse'). HITL
         * routing and metrics should read trace.status to split
         * model-health from data-quality drift.
         */
        | 'picker_unavailable';
      /**
       * Human-readable reason for the escalation. Helpful for HITL
       * queue triage when paired with the structured `reason` above.
       */
      detail: string;
      trace: PickCallTrace;
    };
