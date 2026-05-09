/**
 * Phase 1 (classification) result types.
 *
 * The dispatch contract — `dispatch(item) -> { finalCode, sanityVerdict, trace }`
 * — is owned by the dispatch-flow agent. Until they ship a concrete
 * implementation, the declaration-runs module depends on the interface shape
 * declared here (mirrored in dispatch.contract.ts).
 */
import type { DispatchV1Response } from '../../pipeline/shared/pipeline.types.js';

export type SanityVerdict = 'PASS' | 'FLAG' | 'BLOCK';

export type ClassificationOutcome = 'succeeded' | 'flagged' | 'blocked' | 'failed';

export interface ItemTrace {
  /** Final pipeline path. Values defined by dispatch. */
  pathTaken: string;
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
   * declaration_run_items.final_code, so the contract carries null.
   */
  finalCode: string | null;
  /**
   * Arabic goods description that feeds `<deccm:goodsDescription>` in the
   * ZATCA Declaration envelope. Null when finalCode is null.
   */
  goodsDescriptionAr: string | null;
  sanityVerdict: SanityVerdict;
  /** HITL intent surfaced by the orchestrator. Null when no review is needed. */
  hitl: { reason: 'verdict_escalate' | 'sanity_flag'; cleaned_description: string } | null;
  /** dispatch-v1 wire response, pre-assembled so callers can record/enqueue. */
  v1: DispatchV1Response;
  trace: ItemTrace;
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
  durationMs: number;
}
