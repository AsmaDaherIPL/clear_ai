/**
 * Phase 1 (classification) result types.
 *
 * The dispatch contract — `dispatch(item) -> { finalCode, sanityVerdict, trace }`
 * — is owned by the dispatch-flow agent. Until they ship a concrete
 * implementation, the declaration-sets module depends on the interface shape
 * declared here (mirrored in dispatch.contract.ts).
 */

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
  finalCode: string;
  sanityVerdict: SanityVerdict;
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
