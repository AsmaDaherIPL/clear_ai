/**
 * Typed contracts for the constrain stage (PR-A-3).
 *
 * Declared in PR-A-1 alongside the stub so the contract is locked
 * before the implementation lands.
 */
import type { IdentifyResult } from '../identify/identify.types.js';

/**
 * What `resolveMerchantCode` produced from the merchant-supplied code
 * walked through the ZATCA codebook + the per-operator override table.
 *
 * Each `state` value is a different terminal of the walk; downstream
 * code branches on `state` (discriminated union) and reads only the
 * fields valid for that state.
 */
export type MerchantResolution =
  | { state: 'absent' }
  | { state: 'active'; resolved_code: string }
  | { state: 'replaced_single'; resolved_code: string; source_code: string }
  | {
      state: 'override_applied';
      resolved_code: string;
      source_code: string;
      override_id: string;
    }
  | {
      state: 'llm_picked_replacement';
      resolved_code: string;
      source_code: string;
      candidates: string[];
    }
  | {
      state: 'expanded_prefix';
      resolved_code: string;
      valid_prefix: string;
    }
  | { state: 'unknown'; source_code: string }
  | { state: 'malformed'; source_code: string };

/**
 * The retrieval scope `constrain` decides. Drives the prefix filter
 * passed to retrievCandidates() in the pick stage.
 */
export type RetrievalScope =
  | {
      kind: 'merchant_prefix';
      /** Prefix to filter retrieval (6+ digits = subheading anchor). */
      prefix: string;
      source: 'merchant' | 'merchant_replacement_picked';
      /** True when retrieval pool will be wider than usual due to picker ambiguity. */
      audit_flag: boolean;
    }
  | {
      kind: 'family_chapter';
      chapter: string;
      source: 'identify';
    }
  | { kind: 'unconstrained'; reason: string }
  | { kind: 'escalate'; reason: string };

export interface ConstrainResult {
  resolution: MerchantResolution;
  scope: RetrievalScope;
}

export interface ConstrainInput {
  identify: IdentifyResult;
  raw_merchant_code: string | null;
}
