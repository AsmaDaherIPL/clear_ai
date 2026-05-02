/**
 * ClearAI API client. Typed wrapper over the same-origin BFF proxy.
 *
 * The browser bundle holds NO credentials. All requests go to /api/* which
 * is served by the SWA managed-function BFF in clearai-frontend/api/. The
 * BFF holds the Entra client_secret server-side, exchanges it for an
 * access_token via client-credentials grant, and forwards to APIM with
 * `Authorization: Bearer ${token}`.
 *
 * Why this shape (frontend security review C1, H1):
 *   - C1: previously the bundle inlined a 32-char APIM subscription key.
 *         Anyone could read it from DevTools and call APIM directly,
 *         burning LLM tokens at scale. Now the bundle ships zero secrets.
 *   - H1: previously there was no real authentication — only a static
 *         shared key. Now APIM gets an Entra-issued JWT identifying the
 *         BFF as `infp-clearai-web-bff-dev-01`, validates the audience
 *         and signature, and rejects anything else.
 *
 * Local dev:
 *   - `astro dev` on :5180 + `func start` on :7071 in clearai-frontend/api/
 *   - astro.config.mjs proxies /api/* → :7071 (set PUBLIC_CLEARAI_DEV_API_PROXY
 *     when running both locally — defaults to /api on the same origin in prod).
 *
 * Production:
 *   - SWA serves the static bundle and the managed-function /api/* on the
 *     same origin (https://clearai-dev.infinitepl.app), so this client
 *     uses relative URLs only — no CORS preflight, no cross-origin auth
 *     surface.
 */

// Same-origin only. The SPA never speaks to APIM directly anymore.
// PUBLIC_CLEARAI_DEV_API_PROXY exists as a build-time escape hatch for
// devs who want to point at a remote BFF (e.g. running azd preview slot)
// — set to e.g. `https://yellow-glacier-...preview.azurestaticapps.net`.
// Defaults to '' (relative same-origin) which is what production wants.
export const API_BASE =
  (import.meta.env.PUBLIC_CLEARAI_DEV_API_PROXY as string | undefined) ?? '';

// --- Decision envelope ----------------------------------------------------

export type DecisionStatus =
  | 'accepted'
  | 'needs_clarification'
  | 'degraded'
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
  | 'best_effort_heading'
  | 'heading_level_match'
  /** Cleanup detected multiple distinct products in one input. */
  | 'multi_product_input';

export type ConfidenceBand = 'high' | 'medium' | 'low';

export type MissingAttribute =
  | 'material'
  | 'intended_use'
  | 'product_type'
  | 'dimensions'
  | 'composition';

/** ZATCA duty rate. Either a numeric percentage or a status word; never both. */
/**
 * Customs duty for a chosen leaf. Shape changed in the most recent
 * backend update — `status_en/ar/raw_en/raw_ar` were dropped in
 * favour of a single canonical `status` enum. Frontend reads only
 * `rate_percent` (numeric percentage) and `status` (the enum).
 *
 * `status` and `rate_percent` are mutually exclusive:
 *   - `status === null` + `rate_percent: number` → numeric rate (most leaves)
 *   - `status: 'exempted' | …` + `rate_percent: null` → no numeric duty;
 *     the status is the entire signal.
 */
export interface DutyInfo {
  rate_percent: number | null;
  status: DutyStatus | null;
}

export type DutyStatus =
  | 'exempted'
  | 'prohibited_import'
  | 'prohibited_export'
  | 'prohibited_both';

export interface ResultLine {
  code: string;
  /** Verbatim ZATCA — may carry leading dashes/colons. Prefer `label_*`. */
  description_en: string | null;
  description_ar: string | null;
  /** Cleaned display text — same field stripped of catalog tree dashes. */
  label_en?: string | null;
  label_ar?: string | null;
  /** Heading-path breadcrumb, e.g. "Footwear › Outer soles leather › …". */
  path_en?: string | null;
  path_ar?: string | null;
  retrieval_score?: number | null;
  duty?: DutyInfo | null;
  /** Order is meaningful — first item is the most blocking. Do not re-sort. */
  procedures?: ProcedureRef[];
}

/** One row from the ZATCA procedure-codes table. AR-only by source. */
export interface ProcedureRef {
  code: string;
  description_ar: string;
  /** True when description ends with "(ملغي)" — render hidden by default. */
  is_repealed: boolean;
}

export interface AlternativeLine {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  /** Null when sourced from branch enumeration rather than RRF. */
  retrieval_score: number | null;
  source?: 'branch_8' | 'branch_6' | 'branch_4' | 'rrf';
  rank?: number;
  fit?: 'fits' | 'partial' | 'excludes';
  reason?: string;
}

export interface ModelInfo {
  embedder: string;
  llm: string | null;
  /** Present when the cleanup stage actually ran. */
  cleanup?: string;
  /** Present when the researcher stage actually ran. */
  researcher?: string;
  /** Present when best-effort fallback fired. */
  best_effort?: string;
}

/** What the system actually classified — surfaces cleanup / researcher transformations. */
export interface Interpretation {
  original: string;
  stage: 'passthrough' | 'cleaned' | 'researched' | 'unknown';
  cleaned_as?: string;
  cleanup_kind?: 'product' | 'merchant_shorthand' | 'ungrounded' | 'multi_product';
  cleanup_attributes?: string[];
  cleanup_stripped?: string[];
  /** Per-token typo corrections recorded by the cleanup pass. */
  cleanup_typo_corrections?: Array<{ from: string; to: string }>;
  rewritten_as?: string;
  researcher_note?: string;
  /**
   * Predicted HS-2 chapters used to constrain Stage-1 retrieval.
   * Present when the chapter-hint stage ran (most accepted requests).
   */
  chapter_hint?: {
    likely_chapters: string[];
    confidence: number;
    rationale: string;
  };
}

/** Inline submission description (legacy — new code uses NewDescriptionResponse). */
export interface SubmissionDescription {
  description_ar: string;
  description_en: string;
  rationale: string;
  differs_from_catalog: boolean;
  source: 'llm' | 'llm_failed' | 'guard_fallback';
}

/** Common envelope shared by POST /classifications and POST /classifications/expand. */
export interface DecisionEnvelopeBase {
  request_id?: string;
  decision_status: DecisionStatus;
  decision_reason: DecisionReason;
  confidence_band?: ConfidenceBand;
  alternatives: AlternativeLine[];
  rationale?: string;
  missing_attributes?: MissingAttribute[];
  interpretation?: Interpretation;
  /** Set only on decision_reason='multi_product_input'. */
  products_detected?: string[];
  /**
   * Backend guardrail downgraded the result and is asking for human
   * review before declaration. Pairs with `review_reason`. When
   * `needs_review === true`, the main result page renders the amber
   * banner; when absent, no banner.
   */
  needs_review?: boolean;
  /** Free-form explanation for the downgrade. Pairs with needs_review. */
  review_reason?: string;
  /** @deprecated Fetch via POST /classifications/{id}/submission-description. */
  submission_description?: SubmissionDescription;
  model: ModelInfo;
}

/** `result` is present iff status='accepted'. */
export interface DescribeResponse extends DecisionEnvelopeBase {
  result?: ResultLine;
}

export interface ExpandBoostResponse extends DecisionEnvelopeBase {
  before?: { code: string; description_en?: string | null; description_ar?: string | null };
  after?: ResultLine;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  db: boolean;
}

// --- Request bodies -------------------------------------------------------

export interface ClassifyRequest {
  description: string;
}

export interface ExpandRequest {
  /** 4 to 10 digits. */
  code: string;
  description: string;
}

/** Lazy-loaded ZATCA submission description from POST /classifications/{id}/submission-description. */
export interface NewDescriptionResponse {
  description_ar: string;
  description_en: string;
  source: 'llm' | 'guard_fallback';
  /** Null when source='guard_fallback' (no LLM ran). */
  model_call?: ModelCallMeta | null;
}

/** Mirrors a single entry of `event.model_calls[]` on trace responses. */
export interface ModelCallMeta {
  model: string;
  latency_ms: number;
  status: 'ok' | 'error' | 'timeout' | string;
}

// --- Client ---------------------------------------------------------------

class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Always prefix /api so SWA routes the request to the BFF Function.
  // No Authorization header here — the BFF adds Bearer token server-side.
  // No Ocp-Apim-Subscription-Key — APIM no longer requires it (JWT is the
  // sole auth gate).
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
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

  /** POST /classifications — primary classification endpoint. */
  classify: (b: ClassifyRequest) =>
    request<DescribeResponse>('/classifications', {
      method: 'POST',
      body: JSON.stringify(b),
    }),

  /** POST /classifications/expand — narrow a 4-10 digit prefix to a 12-digit leaf. */
  expand: (b: ExpandRequest) =>
    request<ExpandBoostResponse>('/classifications/expand', {
      method: 'POST',
      body: JSON.stringify(b),
    }),

  /** POST /classifications/{id}/submission-description — generate ZATCA-grade Arabic submission text. */
  submissionDescription: (id: string, signal?: AbortSignal) =>
    request<NewDescriptionResponse>(
      `/classifications/${encodeURIComponent(id)}/submission-description`,
      {
        method: 'POST',
        body: JSON.stringify({}),
        ...(signal ? { signal } : {}),
      },
    ),

  /** GET /classifications/{id} — fetch a persisted classification + feedback rows. */
  trace: (id: string) =>
    request<TraceResponse>(`/classifications/${encodeURIComponent(id)}`),

  /** POST /classifications/{id}/feedback — UPSERT one feedback row per (event_id, user_id). */
  feedback: (id: string, body: PostFeedbackBody) =>
    request<{ ok: boolean; feedback_id: string | null }>(
      `/classifications/${encodeURIComponent(id)}/feedback`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),
};

export { ApiError };

// --- Display helpers ------------------------------------------------------

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
    case 'heading_level_match': return 'Heading-level match';
    case 'multi_product_input': return 'Multiple products detected';
  }
}

/** What the user should do given a status+reason. Null on accepted. */
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
      return 'We could not identify a product from your input. Describe what it physically is — material, type, and purpose (e.g. "leather sandal with adjustable straps", "cold-pressed olive oil 500ml bottle").';
    case 'multi_product_input':
      return 'Your input contains multiple distinct products. Each one needs its own HS code — please classify them one at a time.';
    default:
      return 'We could not classify this input. Try describing the product itself — material, type, and purpose (e.g. "leather sandal with adjustable straps").';
  }
}

export function statusToTone(status: DecisionStatus): 'good' | 'warn' | 'bad' {
  if (status === 'accepted') return 'good';
  if (status === 'needs_clarification') return 'warn';
  if (status === 'best_effort') return 'warn';
  return 'bad';
}

// --- Trace + feedback -----------------------------------------------------

/** classification_events row + feedback rows. Returned by GET /classifications/{id}. */
export interface TraceEvent {
  id: string;
  created_at: string;
  endpoint: 'describe' | 'expand' | 'boost';
  /** Persisted request envelope; carries per-stage breadcrumbs. See TraceRequestMeta. */
  request: TraceRequestMeta | unknown;
  language_detected: string | null;
  decision_status: string;
  decision_reason: string;
  confidence_band: string | null;
  chosen_code: string | null;
  alternatives: unknown;
  top_retrieval_score: number | null;
  top2_gap: number | null;
  candidate_count: number | null;
  branch_size: number | null;
  /** @deprecated Reflects only the picker. Read model_calls[] instead. */
  llm_used: boolean;
  /** @deprecated See llm_used. */
  llm_status: string | null;
  /** True iff the picker returned a code outside the candidate set. */
  guard_tripped: boolean;
  model_calls: unknown;
  embedder_version: string | null;
  /** @deprecated See llm_used. */
  llm_model: string | null;
  total_latency_ms: number | null;
  error: string | null;
  rationale?: string | null;
  /** Threshold values the gate evaluated this request against. */
  thresholds?: TraceThresholds | null;
}

/**
 * Per-stage breadcrumbs the backend logs onto `event.request` so the
 * trace UI can determine which stages actually ran without fishing
 * through `model_calls[]` for inferred presence. Every field is
 * optional — older trace rows logged before the breadcrumb fields
 * were added simply omit them, and the UI must render placeholders
 * (not fabricate values) when absent.
 *
 * Mapping for the trace stage timeline:
 *   cleanup_invoked  / cleanup_kind        → Cleanup stage card
 *   research_kind     / research_latency_ms  → Researcher stage card
 *   research_web_kind → Researcher (web) stage card
 *   understanding_chapters / chapter_hint    → Chapter-hint stage card
 *   branch_rank_invoked / branch_rank_*      → Branch-rank stage card
 *   best_effort_invoked / best_effort_*      → Best-effort stage card
 *
 * Retrieval and the evidence gate are non-LLM stages — we infer they
 * ran by the presence of `top_retrieval_score`, `top2_gap`, and
 * `candidate_count` on the event (NOT via this struct).
 */
export interface TraceRequestMeta {
  description?: string;

  // Cleanup stage
  cleanup_invoked?: boolean;
  cleanup_effective?: boolean;
  cleanup_kind?: 'product' | 'merchant_shorthand' | 'ungrounded' | 'multi_product' | string;
  cleanup_attributes_count?: number;
  cleanup_stripped_count?: number;
  cleanup_latency_ms?: number;

  // Researcher
  research_kind?: string | null;
  research_latency_ms?: number | null;
  research_web_kind?: string | null;
  research_web_latency_ms?: number | null;
  rewritten_as?: string | null;

  // Chapter-hint / understanding
  understanding_chapters?: string[] | null;
  understanding_distinct_chapters?: number | null;
  interpretation_stage?: 'passthrough' | 'cleaned' | 'researched' | 'unknown' | string;

  // Branch-rank
  branch_rank_invoked?: boolean;
  branch_rank_latency_ms?: number | null;
  branch_rank_overrode?: boolean;
  branch_rank_picker_choice?: string | null;
  branch_rank_top_pick?: string | null;

  // Best-effort
  best_effort_invoked?: boolean;
  best_effort_specificity?: number | null;

  // Other observable signals
  prefix_bias?: string | null;
  digit_normalisation?: string | null;
}

/** Gate thresholds applied to a trace event. */
export interface TraceThresholds {
  gate_min_score?: number | null;
  gate_min_gap?: number | null;
  gate_min_candidates?: number | null;
}

export interface TraceFeedback {
  id: string;
  created_at: string;
  updated_at: string;
  kind: 'confirm' | 'reject' | 'prefer_alternative';
  rejected_code: string | null;
  corrected_code: string | null;
  reason: string | null;
  user_id: string | null;
}

export interface TraceResponse {
  event: TraceEvent;
  feedback: TraceFeedback[];
}

export type FeedbackKind = 'confirm' | 'reject' | 'prefer_alternative';

export interface PostFeedbackBody {
  kind: FeedbackKind;
  rejected_code?: string;
  corrected_code?: string;
  reason?: string;
}
