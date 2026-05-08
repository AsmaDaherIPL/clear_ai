/**
 * Track B — Code resolver.
 *
 * Deterministic-first resolution of the merchant-supplied HS code.
 * Description is used only as a tiebreaker when multiple replacement
 * codes or prefix children exist. Track B never emits a correctness
 * judgment.
 *
 * Resolution flow:
 *   1. Tenant override lookup. If a matching override row exists, the
 *      walk continues with the override's TARGET code as input — the
 *      override is no longer a terminal stop. This catches stale
 *      overrides (target deprecated/unknown to the current codebook)
 *      that used to silently pass bad data through.
 *   2. Codebook lookup on the chosen input (override target or raw
 *      merchant code):
 *        a. 12-digit active                        → passthrough
 *        b. 12-digit deprecated, 1 replacement     → deterministic swap
 *        c. 12-digit deprecated, N replacements    → lightweight LLM picks
 *        d. 6/8/10-digit prefix → expand-with-fallback + LLM picks
 *   3. Absent / malformed / unknown                → null_resolution
 *
 * The TrackBResult carries `override_applied` + `override_target_code`
 * so downstream consumers (recorder, trace) can distinguish:
 *   - "no override, codebook resolved X to Y the normal way"
 *   - "override fired, codebook resolved its target to Y" (good)
 *   - "override fired, target is unknown — null_resolution"   (stale override — operator action needed)
 */
import { getPool } from '../../../db/client.js';
import { lookupTenantOverride } from '../../pipeline/track-b-code/codebook-override.js';
import { llmPick } from '../../pipeline/track-a-description/picker/llm-pick.js';
import type {
  TrackBResult,
  TrackBResolution,
  CodebookState,
  TrackBLlmContext,
  MerchantCodeState,
} from '../shared/pipeline.types.js';
import type { Candidate } from '../../../inference/retrieval/retrieve.js';

interface HsCodeRecord {
  code: string;
  is_deleted: boolean;
  replacement_codes: string[] | null;
  description_en: string | null;
  description_ar: string | null;
}

/**
 * The shape returned by the inner walk. Mirrors TrackBResult minus the
 * override fields, which the entry point fills in based on whether an
 * override fired.
 */
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

/**
 * Walk a merchant prefix down to a granularity that exists in the
 * codebook. A 10-digit code may not match because the carrier's
 * national extension uses a different padding convention than ZATCA's
 * canonical 12-digit form. Try 10 → 8 → 6; the 6-digit HS6 is the
 * international harmonized prefix and almost always present.
 */
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

/**
 * Classify a code's length so we know which branch of the codebook walk
 * to take. The merchant_code_state from Stage 0 only describes the
 * *raw* merchant input; when we walk the override target instead, we
 * recompute this here.
 */
function classifyLength(code: string): 'twelve_digit' | 'short_prefix' | 'malformed' {
  if (code.length === 12) return 'twelve_digit';
  if (code.length === 6 || code.length === 8 || code.length === 10) return 'short_prefix';
  return 'malformed';
}

/**
 * Inner codebook walk. Pure function of (code, length classification,
 * cleaned_description) — knows nothing about overrides.
 */
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
    const pick = await llmPick({
      kind: 'describe',
      query: cleaned_description,
      candidates,
    });

    if (pick.llmStatus === 'ok' && !pick.guardTripped && pick.chosenCode) {
      const runnersCodes = replacements.filter((c) => c !== pick.chosenCode).slice(0, 3);
      return {
        resolved_code: pick.chosenCode,
        resolution: 'llm_pick_among_replacements',
        codebook_state: 'deprecated_multiple_replacements',
        llm_context: {
          chosen: { code: pick.chosenCode, rationale: pick.rationale ?? '' },
          runners_up: runnersCodes.map((c) => ({ code: c, rationale: '' })),
        },
      };
    }

    return {
      resolved_code: replacements[0]!,
      resolution: 'deterministic_swap',
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
  const pick = await llmPick({
    kind: 'expand',
    query: cleaned_description,
    candidates,
    parentPrefix: matched_prefix,
  });

  if (pick.llmStatus === 'ok' && !pick.guardTripped && pick.chosenCode) {
    const runners_up = candidates
      .filter((c) => c.code !== pick.chosenCode)
      .slice(0, 3)
      .map((c) => ({ code: c.code, rationale: c.description_en ?? '' }));
    return {
      resolved_code: pick.chosenCode,
      resolution: 'llm_pick_under_prefix',
      codebook_state: 'active',
      llm_context: {
        chosen: { code: pick.chosenCode, rationale: pick.rationale ?? '' },
        runners_up,
      },
    };
  }

  return {
    resolved_code: children[0]!.code,
    resolution: 'llm_pick_under_prefix',
    codebook_state: 'active',
  };
}

export async function runTrackB(
  raw_merchant_code: string | null,
  merchant_code_state: MerchantCodeState,
  cleaned_description: string,
  operatorSlug: string,
): Promise<TrackBResult> {
  if (!raw_merchant_code || merchant_code_state === 'absent' || merchant_code_state === 'malformed') {
    return {
      resolved_code: null,
      resolution: 'null_resolution',
      raw_merchant_code,
      codebook_state: 'not_applicable',
      override_applied: false,
      override_target_code: null,
    };
  }

  // 1. Tenant override — feeds its target into the codebook walk
  //    instead of returning early. Stale overrides (target deprecated
  //    or unknown to the current codebook) now surface as
  //    null_resolution / deterministic_swap rather than confidently
  //    emitting bad data. Override metadata is preserved on the result
  //    so the trace can flag operator action when the codebook walk
  //    invalidates the mapping.
  const override = await lookupTenantOverride(raw_merchant_code, operatorSlug);
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
    };
  }

  const resolution = await resolveAgainstCodebook(codeToWalk, lengthState, cleaned_description);

  return {
    ...resolution,
    raw_merchant_code,
    override_applied: overrideApplied,
    override_target_code: overrideTarget,
  };
}
