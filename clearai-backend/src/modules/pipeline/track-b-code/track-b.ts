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
