/**
 * Typed contracts for the pick stage (PR-A-4).
 *
 * Declared in PR-A-1 alongside the stub so the contract is locked
 * before the implementation lands.
 */
import type { IdentifyResult } from '../identify/identify.types.js';
import type { ConstrainResult } from '../constrain/constrain.types.js';

export interface PickInput {
  identify: IdentifyResult;
  constrain: ConstrainResult;
}

export type PickResult =
  | {
      kind: 'accepted';
      final_code: string;
      confidence: number;
      /** Which GIR rule the picker cited, if any. */
      gir_applied: string | null;
    }
  | {
      kind: 'escalate';
      reason:
        | 'no_candidate_fits'
        | 'identify_uninformative_no_merchant'
        | 'multi_product'
        | 'constrain_escalated';
    };
