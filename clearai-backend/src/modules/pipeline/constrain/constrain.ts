/**
 * Constrain stage (anchored pipeline, stage 2 of 3).
 *
 * Contract:
 *   input:  ConstrainInput (identify result + parsed merchant code + operator)
 *   output: ConstrainResult (merchant resolution + retrieval scope + trace)
 *   engine: deterministic codebook walk + small LLM-pick for partial
 *           prefixes and multi-replacement merchant codes; deterministic
 *           scope selection over the resolved merchant + identify
 *           output.
 *   absorbs: today's Track B (codebook walk, override lookup,
 *            expandWithFallback, llm_pick_among_replacements, subtree
 *            consistency check) AND the 11-rule reconciliation
 *            classifier — both collapse into a single deterministic
 *            scope decision plus the codebook resolution.
 *
 * Every code path produces a ConstrainCallTrace so PR-A-5's
 * orchestrator can record audit fields uniformly across stages
 * (matches the trace pattern established by PR-A-2's identify stage).
 */
import type {
  ConstrainInput,
  ConstrainResult,
  ConstrainCallTrace,
  MerchantResolution,
} from './constrain.types.js';
import { resolveMerchantCode } from './resolve-merchant.js';
import { scopeFrom } from './scope.js';

/**
 * Did resolveMerchantCode fire at least one LLM call?
 * Both LLM-call sites (multi-replacement pick, prefix-walk pick) are
 * the only paths that produce `llm_picked_replacement` or — via
 * failure — `unknown` with cause `llm_pick_failed_*`.
 */
function llmWasInvoked(resolution: MerchantResolution): boolean {
  if (resolution.state === 'llm_picked_replacement') return true;
  if (
    resolution.state === 'unknown' &&
    (resolution.cause === 'llm_pick_failed_replacement' ||
      resolution.cause === 'llm_pick_failed_prefix')
  ) {
    return true;
  }
  // `expanded_prefix` MAY have fired an LLM (multi-child case) but we
  // cannot distinguish the deterministic single-child case from the
  // multi-child LLM-pick case from the resolution shape alone.
  // Conservatively report true when state is expanded_prefix.
  if (resolution.state === 'expanded_prefix') return true;
  return false;
}

/**
 * Constrain stage entry point. Composes the deterministic codebook
 * walk (resolveMerchantCode) with the deterministic scope selector
 * (scopeFrom). Emits a ConstrainCallTrace for uniform per-row audit.
 */
export async function runConstrain(input: ConstrainInput): Promise<ConstrainResult> {
  const t0 = Date.now();

  const resolution = await resolveMerchantCode(
    input.raw_merchant_code,
    input.identify,
    input.operator_slug,
    input.overrides_enabled,
  );
  const scope = scopeFrom(input.identify, resolution);

  // The override was attempted iff overrides_enabled AND a non-null
  // raw code was supplied. (resolveMerchantCode short-circuits on
  // null/empty without consulting the override table.)
  const override_attempted =
    input.overrides_enabled && input.raw_merchant_code !== null && input.raw_merchant_code.length > 0;
  const override_matched = resolution.state === 'override_applied';

  const trace: ConstrainCallTrace = {
    llm_called: llmWasInvoked(resolution),
    latency_ms: Date.now() - t0,
    override_attempted,
    override_matched,
  };

  return { resolution, scope, trace };
}
