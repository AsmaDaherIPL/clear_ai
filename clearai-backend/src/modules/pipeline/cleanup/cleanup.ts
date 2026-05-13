/**
 * Stage 1 — Cleanup (lightweight LLM, Haiku-tier).
 *
 * Wraps the existing description-cleanup implementation. Emits a
 * CleanupResult with a clarity_verdict that routes downstream:
 *   clear          → Track A proceeds directly to hybrid retrieval
 *   needs_research → Track A runs Researcher before retrieval
 *   unusable       → item rejected here (keyboard mash, etc.)
 *
 * Never throws. Degrades to raw description on LLM failure.
 */
import {
  cleanDescription,
  looksClean,
} from './description-cleanup.js';
import type { CleanupResult, ClarityVerdict } from '../shared/pipeline.types.js';
import type { DescriptionCleanupKind } from '../shared/domain.types.js';

function toClarityVerdict(kind: DescriptionCleanupKind, nounGrounded: boolean): ClarityVerdict {
  if (kind === 'multi_product') return 'unusable';
  if (kind === 'product' && nounGrounded) return 'clear';
  if (kind === 'merchant_shorthand' || kind === 'ungrounded') return 'needs_research';
  // product but noun not grounded — treat as needs_research so Researcher can recover.
  return 'needs_research';
}

export async function runCleanup(
  raw_description: string,
  identifiers: Array<{ type: string; value: string }>,
): Promise<CleanupResult> {
  // Build context string from extracted identifiers to help LLM correlate
  // SKU/ASIN/EAN with the product noun.
  const idContext =
    identifiers.length > 0
      ? ` [identifiers: ${identifiers.map((id) => `${id.type}:${id.value}`).join(', ')}]`
      : '';

  const inputForLlm = idContext ? `${raw_description}${idContext}` : raw_description;

  const result = await cleanDescription(inputForLlm);

  const clarity_verdict = toClarityVerdict(result.kind, result.nounGrounded);
  const degraded =
    result.invoked === 'llm_failed' || result.invoked === 'llm_unparseable';

  // Tokens: split effective description on whitespace.
  const tokens = result.effective
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .slice(0, 16);

  return {
    cleaned_description: result.effective,
    language: 'unk',  // language detection is not yet wired; placeholder
    tokens,
    clarity_verdict,
    degraded,
    latency_ms: degraded ? result.latencyMs : result.latencyMs,
    tariff_expansion_en: result.tariffExpansionEn,
    identity_tokens: result.identityTokens,
    attempts: result.attempts,
    retried_reasons: result.retriedReasons,
  };
}

/** Expose the looksClean short-circuit for callers that want to skip LLM. */
export { looksClean };
