/**
 * Branch-rank — Sonnet ranks every leaf under the picker's chosen branch
 * with one-line per-leaf reasoning, optionally overriding the picker's
 * choice if a sibling fits better.
 *
 * Phase 3 of the v3 alternatives redesign (ADR-0014). Sits AFTER the
 * picker, BEFORE the response is assembled. Mutually exclusive with the
 * best-effort fallback path (no chosen code → nothing to enumerate under).
 *
 * Why this exists:
 *   The picker (Sonnet) sees only PICKER_CANDIDATES_describe (default 8)
 *   RRF top hits. That can miss a sibling under the chosen branch that
 *   wasn't in retrieval's top-K. Branch-rank gives the model the FULL
 *   HS-8 branch and lets it reconsider with the wider context. Common
 *   case: rank stays the same as the picker, branch-rank adds reasoning
 *   per leaf for the UI. Edge case: branch-rank overrides — logged as
 *   `branch_rank_overrode` for offline review (the picker should
 *   eventually learn from these).
 *
 * Feature-flagged via setup_meta.BRANCH_RANK_ENABLED. Default 0 (off) so
 * common-path latency stays unchanged until we measure quality and decide
 * to flip it on.
 *
 * Hallucination guard: every code in the model's output must appear in
 * the enumerated branch leaves. If the set differs (model invented or
 * dropped a code), we discard the override and return the original picker
 * choice with a `guard_tripped` flag.
 */
import { z } from 'zod';
import { structuredLlmCall } from '../llm/structured-call.js';
import { env } from '../config/env.js';
import type { BranchLeaf } from './branch-enumerate.js';

export type BranchRankFit = 'fits' | 'partial' | 'excludes';

export interface BranchRankRow {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  rank: number;
  fit: BranchRankFit;
  reason: string;
}

export interface BranchRankResult {
  /** Whether the LLM ran or we short-circuited. */
  invoked: 'disabled' | 'not_enough_leaves' | 'llm' | 'llm_failed' | 'guard_tripped';
  /**
   * Re-ranked leaves with reasoning. Empty array when invoked is anything
   * other than 'llm'. Always includes every leaf from the input branch in
   * rank order (rank 1 is the best fit) when populated.
   */
  ranking: BranchRankRow[];
  /**
   * The code branch-rank chose as #1. Equals the picker's chosen code on
   * the common path; differs on overrides.
   */
  topPick: string | null;
  /** True when the model's #1 == the picker's chosen code. */
  agreesWithPicker: boolean;
  /**
   * Final code to ship to the user. Equals topPick when invoked='llm' and
   * the guard didn't trip; otherwise equals the picker's chosen code so
   * branch-rank failures degrade gracefully (the picker's pick is the
   * safe default).
   */
  effectiveCode: string;
  /** LLM round-trip latency in ms; 0 when skipped. */
  latencyMs: number;
  /** Optional model identifier (for logging). */
  model?: string | undefined;
}

// Per-row shape — kept loose because the model occasionally drops fields on
// the long-tail rows (rank=15+ without a reason). Downstream code drops
// any row missing required fields.
interface ParsedRankingRow {
  code?: unknown;
  rank?: unknown;
  fit?: unknown;
  reason?: unknown;
}

const ParsedRankingSchema = z
  .object({
    ranking: z.unknown().optional(),
    top_pick: z.unknown().optional(),
    agrees_with_picker: z.unknown().optional(),
  })
  .passthrough();

const FIT_VALUES = new Set<BranchRankFit>(['fits', 'partial', 'excludes']);

function buildUser(query: string, chosenCode: string, leaves: BranchLeaf[]): string {
  const lines = leaves.map(
    (l, i) =>
      `${i + 1}. code=${l.code}\n   en: ${l.description_en ?? '(none)'}\n   ar: ${l.description_ar ?? '(none)'}`,
  );
  return [
    `User's effective product description:\n${query}`,
    `Picker's chosen code: ${chosenCode}`,
    `Branch leaves (${leaves.length} rows under the chosen code's national branch):`,
    lines.join('\n'),
    'Return JSON only.',
  ].join('\n\n');
}

export interface BranchRankOpts {
  /** Set to false to skip entirely (e.g. feature flag off). Default true. */
  enabled?: boolean;
  /** Cap on tokens the LLM may emit. Default 800 (per-row reasoning adds up). */
  maxTokens?: number;
  /** Override the model. Defaults to env LLM_MODEL_STRONG (Sonnet). */
  model?: string;
  /**
   * Skip the LLM call when the branch has fewer than this many leaves —
   * with 1–2 leaves there's nothing meaningful to rank. Default 2.
   */
  minLeavesForLlm?: number;
}

/**
 * Re-rank a branch of HS leaves with per-row reasoning. Returns the
 * picker's chosen code unchanged on any failure mode.
 */
export async function rankBranch(params: {
  query: string;
  chosenCode: string;
  leaves: BranchLeaf[];
  opts?: BranchRankOpts;
}): Promise<BranchRankResult> {
  const { query, chosenCode, leaves, opts = {} } = params;
  const { enabled = true, maxTokens = 800, minLeavesForLlm = 2 } = opts;

  const fallback = (
    invoked: BranchRankResult['invoked'],
    extra: Partial<BranchRankResult> = {},
  ): BranchRankResult => ({
    invoked,
    ranking: [],
    topPick: chosenCode,
    agreesWithPicker: true,
    effectiveCode: chosenCode,
    latencyMs: 0,
    ...extra,
  });

  if (!enabled) return fallback('disabled');
  if (leaves.length < minLeavesForLlm) return fallback('not_enough_leaves');
  if (!leaves.some((l) => l.code === chosenCode)) {
    // Defensive: chosen code MUST be in the enumerated branch. If it isn't,
    // something upstream is broken — bail rather than sending garbage to
    // the LLM. The picker's pick stands.
    return fallback('not_enough_leaves');
  }

  const e = env();
  const model = opts.model ?? e.LLM_MODEL_STRONG;
  const user = buildUser(query, chosenCode, leaves);

  const outcome = await structuredLlmCall({
    promptFile: 'branch-rank.md',
    user,
    schema: ParsedRankingSchema,
    stage: 'branch_rank',
    model,
    maxTokens,
  });

  if (outcome.kind !== 'ok' || !Array.isArray(outcome.data.ranking)) {
    return fallback('llm_failed', { latencyMs: outcome.trace.latency_ms, model });
  }
  const parsed = outcome.data;

  // Validate every row, build the typed structure. We require the OUTPUT
  // code set to exactly match the INPUT code set — no inventions, no drops.
  const inputCodes = new Set(leaves.map((l) => l.code));
  const seen = new Set<string>();
  const rows: BranchRankRow[] = [];

  for (const raw of parsed.ranking as ParsedRankingRow[]) {
    if (!raw || typeof raw !== 'object') continue;
    const code = typeof raw.code === 'string' ? raw.code : null;
    const rank = typeof raw.rank === 'number' && Number.isInteger(raw.rank) ? raw.rank : null;
    const fit = FIT_VALUES.has(raw.fit as BranchRankFit) ? (raw.fit as BranchRankFit) : null;
    const reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 300) : '';

    if (!code || !rank || !fit) continue;
    if (!inputCodes.has(code)) continue; // hallucinated code
    if (seen.has(code)) continue; // duplicate
    seen.add(code);

    const leaf = leaves.find((l) => l.code === code)!;
    rows.push({
      code,
      description_en: leaf.description_en,
      description_ar: leaf.description_ar,
      rank,
      fit,
      reason,
    });
  }

  // Guard: every input code must appear in the validated output.
  if (seen.size !== inputCodes.size) {
    return fallback('guard_tripped', { latencyMs: outcome.trace.latency_ms, model });
  }

  // Sort by rank (model is supposed to do this, but enforce it on our side).
  rows.sort((a, b) => a.rank - b.rank);

  // top_pick from the model — but we trust our sort more than the model's
  // self-reported field. They should agree; if they don't, the sorted #1 wins.
  const topPick = rows[0]?.code ?? chosenCode;
  const agreesWithPicker = topPick === chosenCode;

  return {
    invoked: 'llm',
    ranking: rows,
    topPick,
    agreesWithPicker,
    effectiveCode: topPick,
    latencyMs: outcome.trace.latency_ms,
    model,
  };
}
