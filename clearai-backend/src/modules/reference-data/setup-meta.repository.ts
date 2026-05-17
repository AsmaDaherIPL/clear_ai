/**
 * Loads tunable thresholds from `setup_meta`. Fail-closed: throws on any
 * missing key, wrong value_kind, or malformed numeric. Process-lifetime cache.
 */
import { getPool } from '../../db/client.js';

export interface Thresholds {
  /** Evidence-gate per-endpoint floors. */
  MIN_SCORE_describe: number;
  MIN_GAP_describe: number;
  MIN_SCORE_expand: number;
  MIN_GAP_expand: number;

  /** Max distinct HS-2 chapters in top-N before treating input as "not understood". */
  UNDERSTOOD_MAX_DISTINCT_CHAPTERS: number;
  /** Window size for the chapter-coherence check. */
  UNDERSTOOD_TOP_K_describe: number;
  /** Candidates pulled from retrieval for /describe. */
  RETRIEVAL_TOP_K_describe: number;
  /** Candidates fed to the picker for /describe. */
  PICKER_CANDIDATES_describe: number;
  /** Alternatives surfaced to the user for /describe. */
  ALTERNATIVES_SHOWN_describe: number;
  /** Minimum non-chosen alternatives; branch enumerator widens to satisfy. */
  ALTERNATIVES_MIN_SHOWN: number;

  BEST_EFFORT_MAX_TOKENS: number;
  /** 0 = disabled (route returns needs_clarification); 1 = enabled. */
  BEST_EFFORT_ENABLED: number;
  /** Must be one of {2, 4, 6, 8, 10}. */
  BEST_EFFORT_MAX_DIGITS: number;

  /** Absolute RRF floor for user-facing alternatives. */
  MIN_ALT_SCORE: number;
  /** Cross-chapter rows must score at least topScore * this. */
  STRONG_ALT_RATIO: number;
  /** Branch enumeration prefix length. One of {4, 6, 8}. */
  BRANCH_PREFIX_LENGTH: number;
  BRANCH_MAX_LEAVES: number;

  DESCRIPTION_CLEANUP_ENABLED: number;
  DESCRIPTION_CLEANUP_MAX_TOKENS: number;

  BRANCH_RANK_ENABLED: number;
  BRANCH_RANK_MAX_TOKENS: number;

  SUBMISSION_DESC_MAX_TOKENS: number;

  /**
   * Renamed from BROKER_MAPPING_ENABLED in 0025_setup_meta_cleanup.sql when
   * the broker_code_mapping table was renamed to operator_code_overrides.
   * Same semantics, same 0/1 encoding.
   */
  TENANT_OVERRIDES_ENABLED: number;

  RESEARCH_WEB_ENABLED: number;
  RESEARCH_WEB_MAX_TOKENS: number;

  /**
   * Picker prompt path-injection mode. Must be one of {0, 1, 2}.
   *   0 = none (current behaviour — picker sees code + en/ar leaf only)
   *   1 = heading-only (group candidates by HS-4, prefix each group with
   *       `Heading <NNNN> — <heading title>`)
   *   2 = full-path breadcrumb per candidate (Section › Chapter › Heading
   *       › Sub-heading › Leaf), source: zatca_hs_code_display.path_en/ar
   * Validator below + setup_meta CHECK constraint both enforce the set.
   */
  PICKER_PATH_MODE: number;

  /**
   * ZATCA HV/LV cutoff in SAR. Items whose valueAmount-converted-to-SAR
   * is >= this go to standalone declarations; below get bundled. Spec-wide,
   * not per-operator — see migration 0046 for the move out of `tenants`.
   */
  ZATCA_HV_THRESHOLD_SAR: number;

  /**
   * Max items per LV consolidated ZATCA declaration. Raised to 9999 in
   * migration 0082; previously 99 (Naqel-side practice). The real binding
   * constraint is ZATCA_LV_INVOICE_CAP_SAR — this is the count safety net.
   */
  ZATCA_BUNDLE_SIZE: number;

  /**
   * Per-bundle invoiceCost cap in SAR for LV consolidated declarations.
   * Bundler packs LV items greedily until adding the next item would push
   * sum(itemCost) to >= this value, then opens a new bundle. Exclusive,
   * so a bundle of 999.99 is allowed and 1000.00 is not (mirror of the
   * HV threshold's >= 1000 semantics).
   */
  ZATCA_LV_INVOICE_CAP_SAR: number;
}

const REQUIRED_NUMERIC_KEYS: ReadonlyArray<keyof Thresholds> = [
  'MIN_SCORE_describe',
  'MIN_GAP_describe',
  'MIN_SCORE_expand',
  'MIN_GAP_expand',
  'UNDERSTOOD_MAX_DISTINCT_CHAPTERS',
  'UNDERSTOOD_TOP_K_describe',
  'RETRIEVAL_TOP_K_describe',
  'PICKER_CANDIDATES_describe',
  'ALTERNATIVES_SHOWN_describe',
  'ALTERNATIVES_MIN_SHOWN',
  'BEST_EFFORT_MAX_TOKENS',
  'BEST_EFFORT_ENABLED',
  'BEST_EFFORT_MAX_DIGITS',
  'MIN_ALT_SCORE',
  'STRONG_ALT_RATIO',
  'BRANCH_PREFIX_LENGTH',
  'BRANCH_MAX_LEAVES',
  'DESCRIPTION_CLEANUP_ENABLED',
  'DESCRIPTION_CLEANUP_MAX_TOKENS',
  'BRANCH_RANK_ENABLED',
  'BRANCH_RANK_MAX_TOKENS',
  'SUBMISSION_DESC_MAX_TOKENS',
  'TENANT_OVERRIDES_ENABLED',
  'RESEARCH_WEB_ENABLED',
  'RESEARCH_WEB_MAX_TOKENS',
  'PICKER_PATH_MODE',
  'ZATCA_HV_THRESHOLD_SAR',
  'ZATCA_BUNDLE_SIZE',
  'ZATCA_LV_INVOICE_CAP_SAR',
];

/** Closed set of boolean flag names. Encoded as 0/1 in setup_meta.value_numeric. */
export type BooleanFlag =
  | 'BEST_EFFORT_ENABLED'
  | 'DESCRIPTION_CLEANUP_ENABLED'
  | 'BRANCH_RANK_ENABLED'
  | 'TENANT_OVERRIDES_ENABLED'
  | 'RESEARCH_WEB_ENABLED';

export function isEnabled(t: Thresholds, flag: BooleanFlag): boolean {
  return t[flag] === 1;
}

let _cache: Thresholds | null = null;

interface SetupMetaDbRow {
  key: string;
  value_numeric: number | null;
  value_kind: string;
}

export async function loadThresholds(): Promise<Thresholds> {
  if (_cache) return _cache;
  const pool = getPool();
  const r = await pool.query<SetupMetaDbRow>(
    `SELECT key, value_numeric, value_kind FROM setup_meta WHERE key = ANY($1::text[])`,
    [REQUIRED_NUMERIC_KEYS as unknown as string[]],
  );
  const map = new Map<string, SetupMetaDbRow>(r.rows.map((row) => [row.key, row]));

  const result: Partial<Thresholds> = {};
  const missing: string[] = [];
  const malformed: string[] = [];

  for (const key of REQUIRED_NUMERIC_KEYS) {
    const row = map.get(key);
    if (!row) {
      missing.push(key);
      continue;
    }
    if (
      row.value_kind !== 'number' ||
      row.value_numeric === null ||
      !Number.isFinite(row.value_numeric)
    ) {
      malformed.push(`${key}(kind=${row.value_kind}, value_numeric=${row.value_numeric})`);
      continue;
    }
    result[key] = row.value_numeric;
  }

  if (missing.length > 0 || malformed.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing keys: ${missing.join(', ')}`);
    if (malformed.length > 0) parts.push(`malformed keys: ${malformed.join(', ')}`);
    throw new Error(
      `setup_meta is not configured correctly — ${parts.join('; ')}. ` +
        `Run \`pnpm db:migrate\` to seed defaults, or fix the rows manually.`,
    );
  }

  const allowedDigits = new Set([2, 4, 6, 8, 10]);
  if (!allowedDigits.has(result.BEST_EFFORT_MAX_DIGITS!)) {
    throw new Error(
      `setup_meta.BEST_EFFORT_MAX_DIGITS must be one of {2,4,6,8,10}; got ${result.BEST_EFFORT_MAX_DIGITS}.`,
    );
  }

  const allowedPathModes = new Set([0, 1, 2]);
  if (!allowedPathModes.has(result.PICKER_PATH_MODE!)) {
    throw new Error(
      `setup_meta.PICKER_PATH_MODE must be one of {0,1,2}; got ${result.PICKER_PATH_MODE}.`,
    );
  }

  _cache = result as Thresholds;
  return _cache;
}

export function clearSetupMetaCache(): void {
  _cache = null;
}
