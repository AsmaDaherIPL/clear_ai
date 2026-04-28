/**
 * ClearAI API client — typed wrapper over the Fastify backend.
 *
 * Backend contract lives in clearai-backend/src/routes/{describe,expand,boost}.ts
 * + src/decision/types.ts. This file is the single hand-kept mirror of that
 * contract on the browser side. Keep field names in sync (snake_case from the
 * wire, exposed unchanged here so a `grep` across both repos finds matches).
 *
 * The shape is *much* smaller than the legacy Python contract — there's no
 * justification, no rationale_steps, no closest_alternative, no pipeline
 * stages, no batch lane. Just the decision envelope + alternatives.
 */

// Default targets the local Fastify backend on :3000 — matches the deployed
// Container App's internal PORT (Azure ingress fronts it on 443 in prod).
// Frontend dev server runs on :5173 (Vite default) to avoid the collision.
//
// In prod, this should point at the APIM gateway, e.g.
//   https://apim-infp-clearai-be-dev-gwc-01.azure-api.net
// NOT the Container App FQDN — direct calls to the origin are blocked
// by the backend's APIM origin-lock.
export const API_BASE =
  (import.meta.env.PUBLIC_CLEARAI_API_BASE as string | undefined) ??
  'http://localhost:3000';

/**
 * APIM subscription key, sent as `Ocp-Apim-Subscription-Key` on every
 * request when the backend is APIM-fronted. Read from the Astro env
 * var so build-time injection works on Cloudflare Pages.
 *
 * Trade-off: baking the key into a static frontend means it's visible
 * in the JS bundle. That's acceptable for v1 because:
 *   - The key has a per-key rate limit at APIM (60 req/min), so quota
 *     burning is bounded.
 *   - CORS is scoped to the Cloudflare origin, so the key + cross-origin
 *     fetch combo is harder to abuse from another site than it looks.
 *   - It's still strictly better than no auth at all.
 *
 * For v1.5, move the key behind a Cloudflare Pages Function (server-side
 * passthrough) so it never lands in the browser.
 */
const APIM_SUBSCRIPTION_KEY =
  (import.meta.env.PUBLIC_CLEARAI_API_KEY as string | undefined) ?? '';

// --- Decision envelope ----------------------------------------------------
// Closed enums — must match clearai-backend/src/decision/types.ts.

export type DecisionStatus =
  | 'accepted'
  | 'needs_clarification'
  | 'degraded'
  /**
   * v2/ADR-0011: low-confidence fallback heading (4-digit by default).
   * The UI MUST gate this behind a verify-toggle — never render it as an
   * accepted code.
   */
  | 'best_effort';

export type DecisionReason =
  | 'strong_match'
  | 'already_most_specific'
  | 'single_valid_descendant'
  | 'low_top_score'
  | 'small_top2_gap'
  | 'invalid_prefix'
  | 'ambiguous_top_candidates'
  | 'guard_tripped'
  | 'llm_unavailable'
  | 'brand_not_recognised'
  /** v2/ADR-0011: paired with decision_status='best_effort'. */
  | 'best_effort_heading';

export type ConfidenceBand = 'high' | 'medium' | 'low';

export type MissingAttribute =
  | 'material'
  | 'intended_use'
  | 'product_type'
  | 'dimensions'
  | 'composition';

export interface ResultLine {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  /**
   * RRF retrieval score for the chosen code. Optional / nullable because:
   *   - On `accepted` results that came from the picker, this is the RRF
   *     score of the chosen candidate.
   *   - On branch-rank overrides (Phase 3), the chosen code may not be in
   *     the original RRF top-K, so the score has no meaning → null.
   *   - On `best_effort` and other paths, the chosen code may be a chapter
   *     prefix that isn't a leaf in `hs_codes`, so no score applies →
   *     omitted.
   */
  retrieval_score?: number | null;
}

export interface AlternativeLine {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  /**
   * RRF retrieval score when alternatives come from filtered retrieval; `null`
   * when alternatives are sourced from deterministic branch enumeration
   * (Phase 1 of the v3 alternatives redesign — accepted classifications now
   * enumerate the chosen code's HS-prefix branch from the catalog rather
   * than expose retrieval rank). Render the picker's-choice chip on the
   * chosen row and a "branch sibling" indicator on null-scored rows.
   */
  retrieval_score: number | null;
  /**
   * Where this alternative came from. Lets the UI render a per-row badge
   * so the user understands which scope they're looking at.
   *   branch_8 — same national subheading as the chosen code
   *   branch_6 — same HS-6 subheading (fallback when HS-8 was sparse)
   *   branch_4 — same HS-4 heading (rare; only via deeper widening)
   *   rrf      — filtered retrieval candidate (final fallback or
   *              non-accepted path)
   * Optional for backward compat; absent on legacy responses.
   */
  source?: 'branch_8' | 'branch_6' | 'branch_4' | 'rrf';
  /**
   * Phase 3 — populated only when branch-rank ran successfully. `rank` is
   * 1-based (rank=1 is the chosen code after any branch-rank override).
   * `fit` is the model's qualitative judgement; `reason` is one sentence
   * (≤25 words) explaining why this leaf fits / doesn't fit. The frontend
   * should render reason text under each row when present, and use `fit`
   * to color-code the row (fits=accent, partial=neutral, excludes=muted).
   */
  rank?: number;
  fit?: 'fits' | 'partial' | 'excludes';
  reason?: string;
}

export interface ModelInfo {
  embedder: string;
  /** null when the request didn't reach the LLM (gate failed, /boost, single-descendant). */
  llm: string | null;
  /** Set when the input was rewritten by the Sonnet researcher (brand/SKU jargon path). */
  researcher?: string;
}

/**
 * Trust note: tells the user what the system actually classified.
 * - stage='passthrough': retrieval understood the original input.
 * - stage='cleaned':     merchant-input cleanup (Phase 1.5) stripped brand
 *                        / SKU / marketing noise from the raw input;
 *                        `cleaned_as` shows what retrieval actually saw.
 * - stage='researched':  Sonnet rewrote the input; `rewritten_as` shows the
 *                        canonical phrase that retrieval and the picker saw.
 * - stage='unknown':     researcher declined to identify the product;
 *                        `researcher_note` carries the reason.
 *
 * `cleanup_*` fields are populated whenever the cleanup LLM ran (Haiku),
 * regardless of whether its output was used as the retrieval input. They
 * let the UI render an "Understood as: X — ignored: Brand, SKU, marketing"
 * line so the user can sanity-check what was stripped.
 */
export interface Interpretation {
  original: string;
  stage: 'passthrough' | 'cleaned' | 'researched' | 'unknown';
  cleaned_as?: string;
  cleanup_kind?: 'product' | 'merchant_shorthand' | 'ungrounded';
  cleanup_attributes?: string[];
  cleanup_stripped?: string[];
  rewritten_as?: string;
  researcher_note?: string;
}

/**
 * Phase 5 — ZATCA-safe submission description. The 1–3 word Arabic phrase
 * a broker can paste into a customs declaration; differs from the catalog
 * AR by at least one token (ZATCA rejects word-for-word duplication).
 *
 * Only emitted on `accepted` results with a real 12-digit leaf. Always has
 * a `description_ar` and `description_en` (the LLM falls back to a
 * deterministic mutator on failure so the field is never empty).
 *
 * `source` tells the UI whether this came cleanly from the LLM, from the
 * deterministic fallback (LLM matched the catalog twice), or from a
 * generic LLM-fail recovery. The fallback paths warrant a "please review"
 * warning in the UI; the clean LLM path can ship as-is.
 */
export interface SubmissionDescription {
  description_ar: string;
  description_en: string;
  rationale: string;
  differs_from_catalog: boolean;
  source: 'llm' | 'llm_failed' | 'guard_fallback';
}

/** Common envelope shared by /classify/describe, /classify/expand, /boost. */
export interface DecisionEnvelopeBase {
  decision_status: DecisionStatus;
  decision_reason: DecisionReason;
  confidence_band?: ConfidenceBand;
  alternatives: AlternativeLine[];
  rationale?: string;
  missing_attributes?: MissingAttribute[];
  /** Optional on /expand and /boost (which don't run the researcher today). */
  interpretation?: Interpretation;
  /** Phase 5 — only present on accepted results with the feature flag on. */
  submission_description?: SubmissionDescription;
  model: ModelInfo;
}

/** /classify/describe response — `result` is present iff status='accepted'. */
export interface DescribeResponse extends DecisionEnvelopeBase {
  result?: ResultLine;
}

/**
 * /classify/expand and /boost both return a "before / after" pair when
 * accepted, alongside the same envelope. `before.code` is the parent prefix
 * (expand) or the declared 12-digit code (boost).
 */
export interface ExpandBoostResponse extends DecisionEnvelopeBase {
  before?: { code: string; description_en?: string | null; description_ar?: string | null };
  after?: ResultLine;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  db: boolean;
}

// --- Request bodies -------------------------------------------------------

export interface DescribeRequest {
  description: string;
}

export interface ExpandRequest {
  /** Exactly 4, 6, 8, or 10 digits. Backend rejects others with 400. */
  code: string;
  description: string;
}

export interface BoostRequest {
  /** Exactly 12 digits. Backend rejects others with 400. */
  code: string;
}

// --- Client ---------------------------------------------------------------
class ApiError extends Error {
  status: number;
  /** Raw backend body (best-effort JSON parse). Useful for surfacing zod
   *  field errors on the form when status=400. */
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (APIM_SUBSCRIPTION_KEY) {
    // APIM expects `Ocp-Apim-Subscription-Key` (note the lowercase prefix).
    headers['Ocp-Apim-Subscription-Key'] = APIM_SUBSCRIPTION_KEY;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body — leave body=null */
  }
  if (!res.ok) {
    const detail =
      (body as { error?: string; detail?: unknown } | null)?.error ??
      (body as { message?: string } | null)?.message ??
      res.statusText;
    throw new ApiError(res.status, String(detail), body);
  }
  return body as T;
}

export const api = {
  health: () => request<HealthResponse>('/health'),
  describe: (b: DescribeRequest) =>
    request<DescribeResponse>('/classify/describe', {
      method: 'POST',
      body: JSON.stringify(b),
    }),
  expand: (b: ExpandRequest) =>
    request<ExpandBoostResponse>('/classify/expand', {
      method: 'POST',
      body: JSON.stringify(b),
    }),
  boost: (b: BoostRequest) =>
    request<ExpandBoostResponse>('/boost', {
      method: 'POST',
      body: JSON.stringify(b),
    }),
};

export { ApiError };

// --- Display helpers ------------------------------------------------------
// These are pure functions on the envelope, used by multiple components.
// Centralised so a change to the decision contract has exactly one place
// to update on the frontend.

/** Human-readable label for a (status, reason) pair. */
export function reasonLabel(reason: DecisionReason): string {
  switch (reason) {
    case 'strong_match': return 'Strong match';
    case 'already_most_specific': return 'Already most specific';
    case 'single_valid_descendant': return 'Single valid descendant';
    case 'low_top_score': return 'Top candidate score too low';
    case 'small_top2_gap': return 'Top two candidates too close';
    case 'invalid_prefix': return 'Code does not match a known branch';
    case 'ambiguous_top_candidates': return 'Multiple plausible candidates';
    case 'guard_tripped': return 'Hallucination guard tripped';
    case 'llm_unavailable': return 'LLM unavailable';
    case 'brand_not_recognised': return 'Brand or product not recognised';
    case 'best_effort_heading': return 'Best-effort heading (verify before use)';
  }
}

/** Short copy explaining what the user should do given a status+reason. */
export function remediationHint(
  status: DecisionStatus,
  reason: DecisionReason,
): string | null {
  if (status === 'accepted') return null;
  if (status === 'degraded') {
    return 'The classification model is currently unavailable. Try again in a moment.';
  }
  if (status === 'best_effort') {
    return 'This is a low-confidence chapter heading, not a final classification. A customs broker must verify and refine it to a 12-digit code before use.';
  }
  // needs_clarification
  switch (reason) {
    case 'low_top_score':
    case 'ambiguous_top_candidates':
      return 'Try a more specific description — material, product type, or intended use.';
    case 'small_top2_gap':
      return 'Two codes are nearly tied. Add one distinguishing detail (e.g. dimensions or composition).';
    case 'invalid_prefix':
      return 'The code does not match any tariff branch. Check the digits and try again.';
    case 'guard_tripped':
      return 'The model proposed a code outside the candidate set. Please refine the description.';
    case 'brand_not_recognised':
      return 'We could not identify this brand or product code. Describe what the product physically is and does (e.g. "leather sandal with adjustable straps" instead of just the model name).';
    default:
      return 'Please refine the input and try again.';
  }
}

export function statusToTone(status: DecisionStatus): 'good' | 'warn' | 'bad' {
  if (status === 'accepted') return 'good';
  if (status === 'needs_clarification') return 'warn';
  if (status === 'best_effort') return 'warn';
  return 'bad';
}
