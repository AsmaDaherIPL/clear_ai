/**
 * Track B — Code resolver.
 *
 * Deterministic-first resolution of the merchant-supplied HS code.
 * Description is used only as a tiebreaker when multiple replacement codes
 * or prefix children exist. Track B never emits a correctness judgment.
 *
 * Resolution priority:
 *   1. Tenant override (exact or prefix match in tenant_code_overrides)
 *   2. Codebook lookup (zatca_hs_codes)
 *      a. 12-digit active          → passthrough
 *      b. 12-digit deprecated, 1 replacement → deterministic swap
 *      c. 12-digit deprecated, N replacements → lightweight LLM picks
 *      d. Short prefix (6/8/10) → expand + lightweight LLM picks leaf
 *   3. Absent / malformed / unknown → null_resolution
 */
import { getPool } from '../../../db/client.js';
import { lookupTenantOverride } from '../../pipeline/track-b-code/codebook-override.js';
import { llmPick } from '../../pipeline/track-a-description/picker/llm-pick.js';
import type {
  TrackBResult,
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

export async function runTrackB(
  raw_merchant_code: string | null,
  merchant_code_state: MerchantCodeState,
  cleaned_description: string,
  tenantSlug: string,
): Promise<TrackBResult> {
  if (!raw_merchant_code || merchant_code_state === 'absent' || merchant_code_state === 'malformed') {
    return {
      resolved_code: null,
      resolution: 'null_resolution',
      raw_merchant_code,
      codebook_state: 'not_applicable',
    };
  }

  // 1. Tenant override
  const override = await lookupTenantOverride(raw_merchant_code, tenantSlug);
  if (override) {
    return {
      resolved_code: override.targetCode,
      resolution: 'tenant_override',
      raw_merchant_code,
      codebook_state: 'active',
    };
  }

  // 2. 12-digit codebook lookup
  if (merchant_code_state === 'twelve_digit') {
    const record = await lookupCode(raw_merchant_code);

    if (!record) {
      return {
        resolved_code: null,
        resolution: 'null_resolution',
        raw_merchant_code,
        codebook_state: 'unknown_to_codebook',
      };
    }

    if (!record.is_deleted) {
      return {
        resolved_code: record.code,
        resolution: 'passthrough',
        raw_merchant_code,
        codebook_state: 'active',
      };
    }

    // Deprecated code — check replacement_codes
    const replacements = record.replacement_codes ?? [];

    if (replacements.length === 0) {
      // Deleted with no replacement — cannot resolve.
      return {
        resolved_code: null,
        resolution: 'null_resolution',
        raw_merchant_code,
        codebook_state: 'deprecated_single_replacement',
      };
    }

    if (replacements.length === 1) {
      return {
        resolved_code: replacements[0]!,
        resolution: 'deterministic_swap',
        raw_merchant_code,
        codebook_state: 'deprecated_single_replacement',
      };
    }

    // Multiple replacements — lightweight LLM picks
    const candidates = replacements.map((code, i) => rowToCandidate({ code, is_deleted: false, replacement_codes: null, description_en: null, description_ar: null }, i));
    const pick = await llmPick({
      kind: 'describe',
      query: cleaned_description,
      candidates,
      pathMode: 0,
    });

    if (pick.llmStatus === 'ok' && !pick.guardTripped && pick.chosenCode) {
      const runnersCodes = replacements.filter((c) => c !== pick.chosenCode).slice(0, 3);
      const runners_up = runnersCodes.map((code) => ({ code, rationale: '' }));
      return {
        resolved_code: pick.chosenCode,
        resolution: 'llm_pick_among_replacements',
        raw_merchant_code,
        codebook_state: 'deprecated_multiple_replacements',
        llm_context: {
          chosen: { code: pick.chosenCode, rationale: pick.rationale ?? '' },
          runners_up,
        },
      };
    }

    // LLM failed — fall back to first replacement deterministically
    return {
      resolved_code: replacements[0]!,
      resolution: 'deterministic_swap',
      raw_merchant_code,
      codebook_state: 'deprecated_multiple_replacements',
    };
  }

  // 3. Short prefix — expand and lightweight LLM picks leaf
  if (merchant_code_state === 'short_prefix') {
    const children = await expandPrefix(raw_merchant_code);

    if (children.length === 0) {
      return {
        resolved_code: null,
        resolution: 'null_resolution',
        raw_merchant_code,
        codebook_state: 'unknown_to_codebook',
      };
    }

    if (children.length === 1) {
      return {
        resolved_code: children[0]!.code,
        resolution: 'llm_pick_under_prefix',
        raw_merchant_code,
        codebook_state: 'active',
        llm_context: {
          chosen: { code: children[0]!.code, rationale: 'single child under prefix' },
          runners_up: [],
        },
      };
    }

    const candidates = children.slice(0, 20).map((r, i) => rowToCandidate(r, i));
    const pick = await llmPick({
      kind: 'expand',
      query: cleaned_description,
      candidates,
      pathMode: 1,
      parentPrefix: raw_merchant_code,
    });

    if (pick.llmStatus === 'ok' && !pick.guardTripped && pick.chosenCode) {
      const runners_up = candidates
        .filter((c) => c.code !== pick.chosenCode)
        .slice(0, 3)
        .map((c) => ({ code: c.code, rationale: c.description_en ?? '' }));
      return {
        resolved_code: pick.chosenCode,
        resolution: 'llm_pick_under_prefix',
        raw_merchant_code,
        codebook_state: 'active',
        llm_context: {
          chosen: { code: pick.chosenCode, rationale: pick.rationale ?? '' },
          runners_up,
        },
      };
    }

    // LLM failed — pick first child deterministically
    return {
      resolved_code: children[0]!.code,
      resolution: 'llm_pick_under_prefix',
      raw_merchant_code,
      codebook_state: 'active',
    };
  }

  return {
    resolved_code: null,
    resolution: 'null_resolution',
    raw_merchant_code,
    codebook_state: 'not_applicable',
  };
}
