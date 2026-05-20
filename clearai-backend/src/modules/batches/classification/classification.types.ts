/**
 * Phase 1 (classification) result types.
 *
 * The dispatch contract — `dispatch(item) -> { finalCode, sanityVerdict, trace }`
 * — is owned by the dispatch-flow agent. Until they ship a concrete
 * implementation, the batches module depends on the interface shape
 * declared here (mirrored in dispatch.contract.ts).
 */
import type { DispatchV1Response } from '../../pipeline/shared/pipeline.types.js';

/**
 * Sanity verdict surfaced to declaration-runs. Mirrors the pipeline's
 * SanityVerdict shape. Null = sanity did not run (ZERO_SIGNAL escalate
 * or pre-classification short-circuit). The legacy 'BLOCK' value is gone.
 */
export type SanityVerdict = 'PASS' | 'FLAG' | null;

export type ClassificationOutcome = 'succeeded' | 'flagged' | 'blocked' | 'failed' | 'pending_infra';

export interface ItemTrace {
  stages: Array<{
    name: string;
    startedAt: string;
    durationMs: number;
    outcome: 'ok' | 'skipped' | 'failed';
    detail?: unknown;
  }>;
  meta?: Record<string, unknown>;
}

export interface DispatchResult {
  /**
   * 12-digit ZATCA HS code. Null when the pipeline escalated (FLAG via
   * Stage 2 escalate, BLOCK from parse/cleanup) and no code was decided.
   * Persisting empty strings would fail the char(12) + FK on
   * batch_items.final_code, so the contract carries null.
   */
  finalCode: string | null;
  /**
   * Arabic goods description that feeds `<deccm:goodsDescription>` in the
   * ZATCA Declaration envelope. Null when finalCode is null.
   */
  goodsDescriptionAr: string | null;
  sanityVerdict: SanityVerdict;
  /**
   * True when the pipeline short-circuited before classification ran
   * (parse rejection, cleanup unusable). Row maps to item-status
   * 'blocked' in classifyOutcome — distinct from a real 'failed' which
   * is a pipeline error after the LLM stages started. Replaces the
   * legacy sanityVerdict==='BLOCK' marker. Optional for test fixtures;
   * orchestrator output always sets it.
   */
  shortCircuit?: boolean;
  /** HITL intent surfaced by the orchestrator. Null when no review is needed. */
  hitl: {
    reason:
      | 'verdict_escalate'
      | 'sanity_flag'
      | 'low_information'
      | 'verifier_uncertain'
      | 'low_confidence_band'; // PR15
    cleaned_description: string;
  } | null;
  /** dispatch-v1 wire response, pre-assembled so callers can record/enqueue. */
  v1: DispatchV1Response;
  trace: ItemTrace;
  /**
   * True when an LLM-backed stage exhausted its retry budget and the row
   * is being recorded with an infrastructure-degraded marker. Drives the
   * 'pending_infra' status downgrade in the classification service.
   */
  infraDegraded: boolean;
}

export interface ItemClassificationResult {
  itemId: string;
  outcome: ClassificationOutcome;
  finalCode: string | null;
  trace: ItemTrace | null;
  error: string | null;
}

export interface PhaseClassificationSummary {
  total: number;
  succeeded: number;
  flagged: number;
  blocked: number;
  failed: number;
  /** Rows downgraded by an LLM-stage exhaustion rather than a real bad-data result. */
  pending_infra: number;
  durationMs: number;
}
