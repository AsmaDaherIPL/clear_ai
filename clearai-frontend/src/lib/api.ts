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
export const API_BASE =
  (import.meta.env.PUBLIC_CLEARAI_API_BASE as string | undefined) ??
  'http://localhost:3000';

// --- Decision envelope ----------------------------------------------------
// Closed enums — must match clearai-backend/src/decision/types.ts.

export type DecisionStatus = 'accepted' | 'needs_clarification' | 'degraded';

export type DecisionReason =
  | 'strong_match'
  | 'already_most_specific'
  | 'single_valid_descendant'
  | 'low_top_score'
  | 'small_top2_gap'
  | 'invalid_prefix'
  | 'ambiguous_top_candidates'
  | 'guard_tripped'
  | 'llm_unavailable';

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
  retrieval_score?: number;
}

export interface AlternativeLine {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  retrieval_score: number;
}

export interface ModelInfo {
  embedder: string;
  /** null when the request didn't reach the LLM (gate failed, /boost, single-descendant). */
  llm: string | null;
}

/** Common envelope shared by /classify/describe, /classify/expand, /boost. */
export interface DecisionEnvelopeBase {
  decision_status: DecisionStatus;
  decision_reason: DecisionReason;
  confidence_band?: ConfidenceBand;
  alternatives: AlternativeLine[];
  rationale?: string;
  missing_attributes?: MissingAttribute[];
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
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
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
    default:
      return 'Please refine the input and try again.';
  }
}

export function statusToTone(status: DecisionStatus): 'good' | 'warn' | 'bad' {
  if (status === 'accepted') return 'good';
  if (status === 'needs_clarification') return 'warn';
  return 'bad';
}
