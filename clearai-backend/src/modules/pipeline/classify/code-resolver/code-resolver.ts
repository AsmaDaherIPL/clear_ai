/**
 * Code resolver. Tenant overrides are NOT terminal: a matching override
 * feeds its target code into the codebook walk so stale overrides
 * (target deprecated or unknown) surface as deterministic_swap or
 * null_resolution rather than silently emitting bad data. The result
 * carries override_applied + override_target_code so downstream can
 * distinguish "no override" from "override fired, codebook then
 * resolved" from "override fired, target is stale".
 */
import { getPool } from '../../../db/client.js';
import { lookupTenantOverride } from '../../pipeline/track-b-code/codebook-override.js';
import { llmClassify } from '../../pipeline/track-a-description/picker/llm-pick.js';
import { retrieveCandidates } from '../../../inference/retrieval/retrieve.js';
import type {
  TrackBResult,
  TrackBResolution,
  CodebookState,
  TrackBLlmContext,
  MerchantCodeState,
  ConsistencyVerdict,
  SubtreeAnnotatedCandidate,
} from '../shared/pipeline.types.js';
import type { Candidate } from '../../../inference/retrieval/retrieve.js';

interface HsCodeRecord {
  code: string;
  is_deleted: boolean;
  replacement_codes: string[] | null;
  description_en: string | null;
  description_ar: string | null;
}

interface CodebookResolution {
  resolved_code: string | null;
  resolution: TrackBResolution;
  codebook_state: CodebookState;
  llm_context?: TrackBLlmContext;
}

async function lookupCode(code: string): Promise<HsCodeRecord | null> {
  const pool = getPool();
  const r = await pool.query<HsCodeRecord>(
    `SELECT code, is_deleted, replacement_codes, description_en, description_ar
       FROM zatca_hs_codes
      WHERE code = $1`,
    [code],
  );
  return r.rows[0] ?? null;
}

async function expandPrefix(prefix: string, limit = 50): Promise<HsCodeRecord[]> {
  const pool = getPool();
  const r = await pool.query<HsCodeRecord>(
    `SELECT code, is_deleted, replacement_codes, description_en, description_ar
       FROM zatca_hs_codes
      WHERE code LIKE $1
        AND is_deleted = false
      ORDER BY code
      LIMIT $2`,
    [`${prefix}%`, limit],
  );
  return r.rows;
}

// Carriers' national extensions don't always match ZATCA's canonical
// 12-digit padding, so a full prefix may return zero children even when
// the chapter+heading exist. Walk down 10 → 8 → 6 (HS6 is the
// international harmonized prefix, almost always present).
async function expandWithFallback(
  fullPrefix: string,
  limit = 50,
): Promise<{ children: HsCodeRecord[]; matched_prefix: string }> {
  const candidates: string[] = [];
  if (fullPrefix.length >= 10) candidates.push(fullPrefix.slice(0, 10));
  if (fullPrefix.length >= 8) candidates.push(fullPrefix.slice(0, 8));
  if (fullPrefix.length >= 6) candidates.push(fullPrefix.slice(0, 6));
  const tried = new Set<string>();
  for (const p of candidates) {
    if (tried.has(p)) continue;
    tried.add(p);
    const children = await expandPrefix(p, limit);
    if (children.length > 0) {
      return { children, matched_prefix: p };
    }
  }
  return { children: [], matched_prefix: fullPrefix };
}

function rowToCandidate(row: HsCodeRecord, rank: number): Candidate {
  return {
    code: row.code,
    description_en: row.description_en,
    description_ar: row.description_ar,
    parent10: row.code.slice(0, 10),
    path_en: '',
    path_ar: '',
    path_codes: [],
    vec_rank: null,
    bm25_rank: null,
    trgm_rank: null,
    vec_score: null,
    bm25_score: null,
    trgm_score: null,
    rrf_score: 1 / (rank + 1),
  };
}

// merchant_code_state from Stage 0 describes the raw merchant input
// only. When the walk runs against an override target, length must be
// recomputed.
function classifyLength(code: string): 'twelve_digit' | 'short_prefix' | 'malformed' {
  if (code.length === 12) return 'twelve_digit';
  if (code.length === 6 || code.length === 8 || code.length === 10) return 'short_prefix';
  return 'malformed';
}

async function resolveAgainstCodebook(
  code: string,
  state: 'twelve_digit' | 'short_prefix',
  cleaned_description: string,
): Promise<CodebookResolution> {
  if (state === 'twelve_digit') {
    const record = await lookupCode(code);

    if (!record) {
      return {
        resolved_code: null,
        resolution: 'null_resolution',
        codebook_state: 'unknown_to_codebook',
      };
    }

    if (!record.is_deleted) {
      return {
        resolved_code: record.code,
        resolution: 'passthrough',
        codebook_state: 'active',
      };
    }

    const replacements = record.replacement_codes ?? [];

    if (replacements.length === 0) {
      return {
        resolved_code: null,
        resolution: 'null_resolution',
        codebook_state: 'deprecated_single_replacement',
      };
    }

    if (replacements.length === 1) {
      return {
        resolved_code: replacements[0]!,
        resolution: 'deterministic_swap',
        codebook_state: 'deprecated_single_replacement',
      };
    }

    const candidates = replacements.map((c, i) =>
      rowToCandidate(
        { code: c, is_deleted: false, replacement_codes: null, description_en: null, description_ar: null },
        i,
      ),
    );
    const classify = await llmClassify({ kind: 'describe', query: cleaned_description, candidates });
    const topFit = classify.verdicts.find((v) => v.fit === 'fits') ?? classify.verdicts.find((v) => v.fit === 'partial');

    if (classify.llmStatus === 'ok' && !classify.parseFailed && topFit) {
      const runnersCodes = replacements.filter((c) => c !== topFit.code).slice(0, 3);
      return {
        resolved_code: topFit.code,
        resolution: 'llm_pick_among_replacements',
        codebook_state: 'deprecated_multiple_replacements',
        llm_context: {
          chosen: { code: topFit.code, rationale: topFit.rationale },
          runners_up: runnersCodes.map((c) => ({ code: c, rationale: '' })),
        },
      };
    }

    return {
      resolved_code: null,
      resolution: 'null_resolution',
      codebook_state: 'deprecated_multiple_replacements',
    };
  }

  // Short prefix
  const { children, matched_prefix } = await expandWithFallback(code);

  if (children.length === 0) {
    return {
      resolved_code: null,
      resolution: 'null_resolution',
      codebook_state: 'unknown_to_codebook',
    };
  }

  if (children.length === 1) {
    return {
      resolved_code: children[0]!.code,
      resolution: 'llm_pick_under_prefix',
      codebook_state: 'active',
      llm_context: {
        chosen: {
          code: children[0]!.code,
          rationale:
            matched_prefix === code
              ? 'single child under prefix'
              : `single child under fallback prefix ${matched_prefix}`,
        },
        runners_up: [],
      },
    };
  }

  const candidates = children.slice(0, 20).map((r, i) => rowToCandidate(r, i));
  const classify = await llmClassify({ kind: 'expand', query: cleaned_description, candidates, parentPrefix: matched_prefix });
  const topFit =
    classify.verdicts.find((v) => v.fit === 'fits') ?? classify.verdicts.find((v) => v.fit === 'partial');

  if (classify.llmStatus === 'ok' && !classify.parseFailed && topFit) {
    const runners_up = candidates
      .filter((c) => c.code !== topFit.code)
      .slice(0, 3)
      .map((c) => ({ code: c.code, rationale: c.description_en ?? '' }));
    return {
      resolved_code: topFit.code,
      resolution: 'llm_pick_under_prefix',
      codebook_state: 'active',
      llm_context: {
        chosen: { code: topFit.code, rationale: topFit.rationale },
        runners_up,
      },
    };
  }

  // LLM failed or no candidate reached fits/partial. Drop the signal
  // rather than emit a confident wrong code.
  return {
    resolved_code: null,
    resolution: 'null_resolution',
    codebook_state: 'unknown_to_codebook',
  };
}

/**
 * PR 5: description-anchored subtree retrieval + consistency verdict.
 *
 * Given a valid HS prefix (heading-level, 6 digits) and the cleaned description:
 *   1. Retrieve top-K candidates within the subtree (code LIKE prefix%) ranked
 *      by description relevance.
 *   2. In parallel, retrieve top-1 globally (no prefix filter) for the hard
 *      prefix check.
 *   3. If the unanchored top-1's prefix does NOT start with valid_prefix,
 *      the description is pulling toward a different heading entirely →
 *      consistency_verdict='contradicts'. Force the subtree_candidates to
 *      a single entry from the unanchored top-1 (so reconciliation sees the
 *      stronger signal Track A would have picked up).
 *   4. Otherwise, run the LLM classifier against the anchored candidates
 *      (using picker-expand.md). Map the top verdict to consistency:
 *        fits    → consistent
 *        partial → ambiguous (description doesn't positively confirm heading)
 *        does_not_fit (or LLM error / no candidates) → ambiguous
 *
 * Returns null when the heading subtree is empty in zatca_hs_codes — caller
 * surfaces this as consistency_verdict='not_applicable'.
 */
async function computeSubtreeConsistency(
  validPrefix: string,
  cleaned_description: string,
): Promise<{
  consistency_verdict: ConsistencyVerdict;
  subtree_candidates: SubtreeAnnotatedCandidate[];
} | null> {
  const [anchored, unanchoredTop] = await Promise.all([
    retrieveCandidates(cleaned_description, { prefixFilter: validPrefix, topK: 5 }),
    retrieveCandidates(cleaned_description, { topK: 1 }),
  ]);

  if (anchored.length === 0) {
    // Heading is empty in our codebook (broken seed or genuinely no descendants).
    // Treat as not_applicable rather than emitting a bogus verdict.
    return null;
  }

  // Hard prefix check: the unanchored description signal must point to the
  // same heading. If it doesn't, this is a CONTRADICTION the merchant code
  // cannot win.
  const unanchoredCode = unanchoredTop[0]?.code;
  if (unanchoredCode && !unanchoredCode.startsWith(validPrefix)) {
    const top = unanchoredTop[0]!;
    return {
      consistency_verdict: 'contradicts',
      subtree_candidates: [
        {
          code: top.code,
          description_en: top.description_en,
          description_ar: top.description_ar,
          rrf_score: top.rrf_score,
          fit: 'fits',
          rationale: `forced from unanchored top-1; prefix violates declared heading ${validPrefix}`,
        },
      ],
    };
  }

  // Prefix consistent — run LLM classifier on anchored candidates.
  const classify = await llmClassify({
    kind: 'expand',
    query: cleaned_description,
    candidates: anchored,
    parentPrefix: validPrefix,
  });

  // Merge verdicts back onto candidates (preserving rrf_score), in retrieval order.
  const verdictByCode = new Map(classify.verdicts.map((v) => [v.code, v]));
  const annotated: SubtreeAnnotatedCandidate[] = anchored.map((c) => {
    const v = verdictByCode.get(c.code);
    return {
      code: c.code,
      description_en: c.description_en,
      description_ar: c.description_ar,
      rrf_score: c.rrf_score,
      fit: v?.fit ?? 'does_not_fit',
      rationale: v?.rationale ?? '',
    };
  });

  // Determine consistency from the top-anchored verdict. Per the developer's
  // clarification: ambiguous fires whenever the description cannot positively
  // confirm the merchant's heading. So only top-fit=fits earns 'consistent'.
  const topAnchoredFit = annotated[0]?.fit ?? 'does_not_fit';
  const consistency_verdict: ConsistencyVerdict =
    classify.llmStatus === 'ok' && !classify.parseFailed && topAnchoredFit === 'fits'
      ? 'consistent'
      : 'ambiguous';

  return { consistency_verdict, subtree_candidates: annotated };
}

/**
 * Reduce a normalized merchant code to its heading-level prefix (first 6
 * digits — the international HS6 boundary). Returns null when input is
 * shorter than 6 digits (caller should treat as not_applicable).
 */
function headingPrefix(code: string): string | null {
  if (code.length < 6) return null;
  return code.slice(0, 6);
}

export interface RunTrackBOptions {
  /**
   * When false, `lookupTenantOverride()` is skipped entirely and the
   * merchant's raw code flows directly into the codebook walk. Used
   * per-operator (see operator_declaration_config.overrides_enabled)
   * to disable an untrusted override list without deleting the rows.
   *
   * Defaults to true to preserve historical behavior for callers that
   * don't pass options.
   */
  overridesEnabled?: boolean;
}

export async function runTrackB(
  raw_merchant_code: string | null,
  merchant_code_state: MerchantCodeState,
  cleaned_description: string,
  operatorSlug: string,
  options: RunTrackBOptions = {},
): Promise<TrackBResult> {
  const { overridesEnabled = true } = options;
  if (!raw_merchant_code || merchant_code_state === 'absent' || merchant_code_state === 'malformed') {
    return {
      resolved_code: null,
      resolution: 'null_resolution',
      raw_merchant_code,
      codebook_state: 'not_applicable',
      override_applied: false,
      override_target_code: null,
      consistency_verdict: 'not_applicable',
      valid_prefix: null,
      subtree_candidates: [],
    };
  }

  // Override lookup gated on per-operator flag. When disabled, the merchant's
  // raw code flows into the codebook walk unchanged — this is the route used
  // when an operator's override list is operationally untrusted (ZATCA-pass
  // workarounds rather than codebook corrections).
  const override = overridesEnabled
    ? await lookupTenantOverride(raw_merchant_code, operatorSlug)
    : null;
  const overrideApplied = override !== null;
  const overrideTarget = override?.targetCode ?? null;

  const codeToWalk = overrideTarget ?? raw_merchant_code;
  const lengthState = classifyLength(codeToWalk);

  if (lengthState === 'malformed') {
    return {
      resolved_code: null,
      resolution: 'null_resolution',
      raw_merchant_code,
      codebook_state: 'not_applicable',
      override_applied: overrideApplied,
      override_target_code: overrideTarget,
      consistency_verdict: 'not_applicable',
      valid_prefix: null,
      subtree_candidates: [],
    };
  }

  // Anchor the subtree consistency check on the heading (first 6 digits) of
  // the code we'll walk against the codebook. Override targets count: an
  // operator-curated remap to a different heading should drive the consistency
  // check at the new heading, not the merchant's original one.
  const validPrefix = headingPrefix(codeToWalk);

  // Codebook walk (existing) and subtree consistency check (PR 5) run in parallel.
  // The codebook walk produces resolved_code; the consistency check produces
  // the verdict + annotated candidates. They are independent — failures in one
  // do not block the other.
  const [resolution, subtreeOutcome] = await Promise.all([
    resolveAgainstCodebook(codeToWalk, lengthState, cleaned_description),
    validPrefix
      ? computeSubtreeConsistency(validPrefix, cleaned_description).catch(() => null)
      : Promise.resolve(null),
  ]);

  const consistency = subtreeOutcome ?? {
    consistency_verdict: 'not_applicable' as ConsistencyVerdict,
    subtree_candidates: [] as SubtreeAnnotatedCandidate[],
  };

  return {
    ...resolution,
    raw_merchant_code,
    override_applied: overrideApplied,
    override_target_code: overrideTarget,
    consistency_verdict: consistency.consistency_verdict,
    valid_prefix: validPrefix,
    subtree_candidates: consistency.subtree_candidates,
  };
}
