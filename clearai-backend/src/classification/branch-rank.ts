/**
 * Sonnet rerank of every leaf under the picker's HS-8 branch. Hallucination
 * guard requires output code set equal to input — guard trip falls back to picker.
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
  invoked: 'disabled' | 'not_enough_leaves' | 'llm' | 'llm_failed' | 'guard_tripped';
  /** Empty unless invoked='llm'. Rank 1 is the best fit. */
  ranking: BranchRankRow[];
  topPick: string | null;
  agreesWithPicker: boolean;
  /** Falls back to picker's pick on any failure mode. */
  effectiveCode: string;
  latencyMs: number;
  model?: string | undefined;
}

/** Loose shape — downstream validation drops rows missing required fields. */
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
  /** Default true. */
  enabled?: boolean;
  /** Default 800. */
  maxTokens?: number;
  /** Defaults to env LLM_MODEL_STRONG. */
  model?: string;
  /** Skip when branch has fewer leaves than this. Default 2. */
  minLeavesForLlm?: number;
}

/** Returns the picker's chosen code unchanged on any failure mode. */
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
    if (!inputCodes.has(code)) continue;
    if (seen.has(code)) continue;
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

  if (seen.size !== inputCodes.size) {
    return fallback('guard_tripped', { latencyMs: outcome.trace.latency_ms, model });
  }

  rows.sort((a, b) => a.rank - b.rank);
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
