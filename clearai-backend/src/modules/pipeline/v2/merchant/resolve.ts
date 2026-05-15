/**
 * Pipeline rewrite — Stage 3: merchant_resolution (PR 5).
 *
 * Wraps the existing resolveMerchantCode (from current anchored
 * constrain/) with v2 types. The underlying logic is unchanged —
 * deterministic codebook walk, override lookup, multi-replacement
 * LLM disambiguation. PR 13 will move the implementation into v2/ and
 * delete the legacy file; this wrapper is the migration seam.
 *
 * Why wrap instead of import directly:
 *   - Legacy `resolveMerchantCode` takes a legacy `IdentifyResult`. v2
 *     has its own IdentifyResult (different trace shape). On the fields
 *     resolveMerchantCode actually reads (kind, canonical when
 *     clean_product, identity_tokens), the two types are structurally
 *     compatible — but TypeScript doesn't know that, so the wrapper
 *     converts.
 *   - Forces all v2-stage callers to import from a single v2 namespace,
 *     so PR 13's directory rename is a mechanical mv + grep-replace
 *     instead of touching every caller.
 *
 * The output `MerchantResolution` type is identical between legacy and
 * v2 — no conversion needed on the return side.
 */
import { resolveMerchantCode as resolveMerchantCodeLegacy } from '../../constrain/resolve-merchant.js';
import type { IdentifyResult as IdentifyResultLegacy } from '../../identify/identify.types.js';
import type {
  IdentifyResult as IdentifyResultV2,
  MerchantResolution,
  MerchantResolutionTrace,
} from '../types.js';

/**
 * Convert a v2 IdentifyResult into the shape resolveMerchantCode's
 * legacy signature expects. resolveMerchantCode only reads the
 * non-trace fields (kind, canonical, identity_tokens, family_chapter,
 * confidence, evidence) so the trace shape doesn't matter for the call.
 *
 * We construct a minimal trace stub that satisfies the legacy type
 * without copying the real call metrics. The merchant resolver doesn't
 * inspect the trace.
 */
function toLegacyIdentify(v2: IdentifyResultV2): IdentifyResultLegacy {
  // Legacy IdentifyCallTrace has slightly different fields (no `pass`).
  // We strip ours and synthesize the legacy shape. Structural casts
  // would also work; the explicit conversion documents the intent.
  if (v2.kind === 'clean_product') {
    return {
      kind: 'clean_product',
      canonical: v2.canonical,
      family_chapter: v2.family_chapter,
      identity_tokens: v2.identity_tokens,
      confidence: v2.confidence,
      evidence: v2.evidence,
      trace: {
        llm_called: v2.trace.llm_called,
        latency_ms: v2.trace.latency_ms,
        model: v2.trace.model,
        // Legacy IdentifyCallTrace.status doesn't include 'parse' (a v2
        // addition for the new parse-fail discriminator). Coerce 'parse'
        // → 'error' for the legacy shape; resolveMerchantCode doesn't
        // inspect status anyway, this is purely for type safety.
        status: v2.trace.status === 'parse' ? 'error' : v2.trace.status,
        web_search_used: v2.trace.web_search_used,
        evidence_mismatch: v2.trace.evidence_mismatch,
      },
    };
  }
  if (v2.kind === 'multi_product') {
    return {
      kind: 'multi_product',
      products: v2.products,
      trace: {
        llm_called: v2.trace.llm_called,
        latency_ms: v2.trace.latency_ms,
        model: v2.trace.model,
        // Legacy IdentifyCallTrace.status doesn't include 'parse' (a v2
        // addition for the new parse-fail discriminator). Coerce 'parse'
        // → 'error' for the legacy shape; resolveMerchantCode doesn't
        // inspect status anyway, this is purely for type safety.
        status: v2.trace.status === 'parse' ? 'error' : v2.trace.status,
        web_search_used: v2.trace.web_search_used,
        evidence_mismatch: v2.trace.evidence_mismatch,
      },
    };
  }
  return {
    kind: 'uninformative',
    reason: v2.reason,
    cause: v2.cause,
    trace: {
      llm_called: v2.trace.llm_called,
      latency_ms: v2.trace.latency_ms,
      model: v2.trace.model,
      // Coerce v2-only 'parse' status to 'error' for legacy compat.
      status: v2.trace.status === 'parse' ? 'error' : v2.trace.status,
      web_search_used: v2.trace.web_search_used,
      evidence_mismatch: v2.trace.evidence_mismatch,
    },
  };
}

/**
 * Resolve the merchant code into a discriminated MerchantResolution.
 *
 * Inputs:
 *   raw_code            verbatim merchant string from the carrier
 *   identify            v2 IdentifyResult (used as a tiebreaker when
 *                       multi-replacement or prefix-walk needs an LLM pick)
 *   operator_slug       per-operator key for override lookup
 *   overrides_enabled   boolean toggle from operator_declaration_config
 *
 * Returns: MerchantResolution (v2 type — identical to legacy)
 */
export async function resolveMerchant(
  raw_code: string | null,
  identify: IdentifyResultV2,
  operator_slug: string,
  overrides_enabled: boolean,
): Promise<MerchantResolution> {
  return resolveMerchantCodeLegacy(
    raw_code,
    toLegacyIdentify(identify),
    operator_slug,
    overrides_enabled,
  );
}

/**
 * Build a MerchantResolutionTrace from a resolution outcome + the
 * deterministic facts about how we got there. The legacy
 * resolveMerchantCode doesn't return trace metadata directly; we
 * derive it here from the resolution state.
 *
 * Exported so the orchestrator can attach the trace to PipelineTraceV2.
 */
export function buildResolutionTrace(
  resolution: MerchantResolution,
  startMs: number,
  llmCalled: boolean,
  overrideAttempted: boolean,
): MerchantResolutionTrace {
  return {
    llm_called: llmCalled,
    latency_ms: Date.now() - startMs,
    override_attempted: overrideAttempted,
    override_matched: resolution.state === 'override_applied',
  };
}
