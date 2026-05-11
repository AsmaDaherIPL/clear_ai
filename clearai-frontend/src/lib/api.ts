/**
 * ClearAI API client. Typed wrapper that calls APIM directly from the
 * browser, attaching a USER-issued Entra access token.
 *
 * Architecture (post-MSAL cutover, 2026-05-05):
 *   Browser → MSAL.js Auth-Code+PKCE → Entra → access_token →
 *   Browser → APIM (validates JWT) → backend.
 *
 * The SWA managed-Functions BFF that used to live in clearai-frontend/api/
 * held an app-credential secret. SWA Free does not support managed identity
 * for Functions, so the secret had to live as plaintext app-setting — not
 * acceptable. Switched to per-user delegated tokens via MSAL.js, and the
 * api/ folder was removed on 2026-05-07.
 *
 * The bundle still holds NO credentials. The four PUBLIC_* env vars
 * (tenant, client, scope, APIM base URL) are public discovery values,
 * not secrets — same risk profile as a published OpenID Connect
 * configuration.
 *
 * Local dev:
 *   - `astro dev` on :5180 + a localhost redirect URI registered on
 *     the ClearAI SPA DEV app reg.
 *   - APIM CORS allow-list must include http://localhost:4321/5180.
 */
import { getAccessToken } from './auth';


// Direct browser → APIM. The SPA talks straight to the gateway with a
// USER-issued Entra token fetched via MSAL (see src/lib/auth.ts).
// PUBLIC_APIM_BASE_URL is set at build time per environment.
//
// Resolved lazily — module-eval runs during Astro's static prerender
// step on the build machine, where PUBLIC_* env vars may not be
// present. A throw here would crash the build. `getApimBase()` only
// fires at the first runtime call (which only happens client-side,
// after a user is signed in).
function getApimBase(): string {
  const v = import.meta.env.PUBLIC_APIM_BASE_URL as string | undefined;
  if (!v) {
    throw new Error(
      'Missing PUBLIC_APIM_BASE_URL. Set it in your .env or SWA app settings.',
    );
  }
  return v;
}

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
  // `chapter_hint` removed in May-3 pipeline iteration — the chapter-
  // hint stage no longer exists. Understanding signals are read from
  // `understanding_chapters` / `understanding_distinct_chapters` on
  // the trace event row instead.
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

/** POST /pipeline/dispatch body. */
export interface DispatchRequest {
  description: string;
  merchant_code?: string;
  /** Defaults to 'naqel' on the backend if omitted. */
  operator_slug?: string;
  /** Commercial value of the item — passed through to Stage 3 sanity. */
  value_amount?: number;
  /** ISO 4217 3-letter code (e.g. 'SAR', 'USD'). */
  currency_code?: string;
}

/**
 * dispatch-v1 wire format from POST /pipeline/dispatch.
 *
 * Three-level vocabulary, never overloaded:
 *   stage   = top-level pipeline phase: normalize | classify | sanity
 *   action  = inside stage.actions[]:   parse, cleanup, description_classifier,
 *                                        code_resolver, reconciliation,
 *                                        submission_description, sanity_check
 *   step    = inside action.steps[]:    researcher, retrieval, threshold,
 *                                        web_researcher, picker, …
 */
export type DispatchOutcome = 'ok' | 'skipped' | 'failed' | 'failed_gate';
export type DispatchStageName = 'normalize' | 'classify' | 'sanity';
export type DispatchActionName =
  | 'parse'
  | 'cleanup'
  | 'description_classifier'
  | 'code_resolver'
  | 'reconciliation'
  | 'submission_description'
  | 'sanity_check';
export type DispatchStepName =
  | 'researcher'
  | 'retrieval'
  | 'threshold'
  | 'web_researcher'
  | 'retrieval_after_web'
  | 'threshold_after_web'
  | 'picker'
  | 'operator_override_lookup'
  | 'codebook_lookup';

export interface DispatchStep {
  step: DispatchStepName;
  duration_ms: number;
  outcome: DispatchOutcome;
  model?: string;
  output?: Record<string, unknown>;
}

export interface DispatchAction {
  action: DispatchActionName;
  duration_ms: number;
  outcome: DispatchOutcome;
  llm_used?: boolean;
  model?: string;
  merchant_code_visible_to_model?: boolean;
  input?: Record<string, unknown>;
  steps?: DispatchStep[];
  output?: Record<string, unknown>;
}

export interface DispatchStage {
  stage: DispatchStageName;
  started_at: string;
  duration_ms: number;
  outcome: DispatchOutcome;
  input?: Record<string, unknown>;
  actions: DispatchAction[];
  output?: Record<string, unknown>;
}

export interface DispatchSummary {
  merchant_code_state: string | null;
  description_classifier_code: string | null;
  code_resolver_code: string | null;
  reconciliation:
    | 'description_classifier'
    | 'code_resolver'
    | 'reconciled'
    | 'escalated'
    | null;
  operator_override_applied: boolean;
  final_code: string | null;
  sanity_verdict: 'PASS' | 'FLAG' | 'BLOCK' | null;
}

export interface DispatchTrace {
  trace_version: 'dispatch-v1';
  started_at: string;
  completed_at: string;
  duration_ms: number;
  llm_calls_used: number;
  summary: DispatchSummary;
  stages: DispatchStage[];
}

export interface DispatchResponse {
  item_id: string;
  operator_slug: string;
  status: 'succeeded' | 'failed' | 'rejected';
  final_code: string | null;
  goods_description_ar: string | null;
  goods_description_en: string | null;
  sanity_verdict: 'PASS' | 'FLAG' | 'BLOCK';
  trace: DispatchTrace;
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

// --- declaration-runs (bulk batch) ---------------------------------------

export type DeclarationRunMode = 'classify_only' | 'classify_and_declare';

export type DeclarationRunStatus =
  | 'pending'
  | 'ingesting'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ClassificationPhaseStatus = 'pending' | 'running' | 'completed' | 'failed';

export type DeclarationPhaseStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | null;

export type DeclarationRunItemStatus =
  | 'pending'
  | 'classifying'
  | 'succeeded'
  | 'flagged'
  | 'blocked'
  | 'failed';

/** Response from POST /declaration-runs (HTTP 202). */
export interface DeclarationRunCreated {
  declaration_run_id: string;
  mode: DeclarationRunMode;
  poll_url: string;
  classifications_url: string;
  declarations_url?: string;
}

/** GET /declaration-runs/:id — used for polling. */
export interface DeclarationRunSummary {
  id: string;
  operator_slug: string;
  mode: DeclarationRunMode;
  status: DeclarationRunStatus;
  classification_status: ClassificationPhaseStatus;
  declaration_status: DeclarationPhaseStatus;
  row_count: number;
  succeeded: number;
  flagged: number;
  blocked: number;
  failed: number;
  pending: number;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
}

export interface DeclarationRunItem {
  id: string;
  row_index: number;
  status: DeclarationRunItemStatus;
  final_code: string | null;
  /** ZATCA breadcrumb in English (zatca_hs_code_display.path_en). Null when no final_code. */
  catalog_path_en: string | null;
  /** LLM-generated Arabic submission description that ships in the XML. Null when no final_code. */
  submission_description_ar: string | null;
  classification_result: Record<string, unknown> | null;
  trace: Record<string, unknown> | null;
  error: string | null;
  /**
   * Merchant-supplied product description from the source CSV/XLSX.
   * Backend is shipping this incrementally (PR pending). Optional now;
   * frontend cell falls back to "—" when absent so older rows render
   * cleanly. The "Merchant description" column reads this verbatim.
   */
  raw_description?: string | null;
  /**
   * Merchant-supplied HS-code prefix (the code on the input invoice
   * before classification). Already shipped by some backend builds —
   * surfaces in the "Merchant code" column. The "Override applied"
   * pill renders inline when override_applied is true.
   */
  raw_merchant_code?: string | null;
  override_applied?: boolean;
  /**
   * V1 reconciliation status — the primary user-facing answer to
   * "did Track A and Track B agree on the code?".
   *
   *   AGREEMENT    — both tracks agree, high confidence
   *   DRIFT        — tracks disagreed at some level; final code still
   *                  picked (this absorbs the legacy AMBIGUOUS_MATERIAL,
   *                  SPARSE_DESCRIPTION, and CONTRADICTION buckets)
   *   ZERO_SIGNAL  — neither track had a defensible code; row escalates
   *
   * Optional for backward-compat with rows persisted before the field
   * existed in trace JSON. The backend's SQL falls back to a mapping
   * from legacy conflict_type when the new field is absent.
   *
   * Distinct from DeclarationRunSummary.classification_status, which is
   * the run-level lifecycle ('pending'|'running'|'completed'|'failed').
   */
  classification_status?: 'AGREEMENT' | 'DRIFT' | 'ZERO_SIGNAL' | string | null;
  /**
   * @deprecated V1 surface uses `classification_status`. Field still
   * shipped by the backend for forensic/trace UI; not surfaced in the
   * primary batch results column anymore.
   */
  confidence_band?: 'certain' | 'high' | 'medium' | 'low' | 'none' | string | null;
}

/** GET /declaration-runs/:id/classifications */
export interface DeclarationRunClassifications {
  declaration_run_id: string;
  items: DeclarationRunItem[];
  /**
   * Phase-1 (classification) lifecycle, separate from the run-level
   * status. The run-level summary.status can be 'failed' because Phase
   * 2 (declaration assembly) failed, even though Phase 1 finished
   * normally — so this field is the authoritative stop signal for the
   * live-poll loop. Optional for backward-compat with older trace rows.
   */
  classification_phase?: 'pending' | 'running' | 'completed' | 'failed';
}

/** GET /declaration-runs/:id/download-links */
export interface DownloadLinkFile {
  name: string;
  url: string;
  sizeBytes: number | null;
  contentType: string | null;
}
export interface DownloadLinks {
  runId: string;
  expiresAt: string;
  files: DownloadLinkFile[];
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
  // Direct browser → APIM. The Authorization header carries the
  // user's Entra access token (acquireTokenSilent under the hood;
  // a redirect-fallback fires if interaction is required).
  // No Ocp-Apim-Subscription-Key — APIM no longer requires it (JWT
  // is the sole auth gate).
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  const res = await fetch(`${getApimBase()}${path}`, {
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

/**
 * Multipart variant for /declaration-runs uploads. The browser sets
 * Content-Type with the right boundary automatically when given a
 * FormData body, so we deliberately do NOT inject Content-Type here.
 */
async function requestMultipart<T>(path: string, form: FormData): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${getApimBase()}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
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

  /**
   * POST /pipeline/dispatch — new two-track pipeline (description classifier +
   * code resolver + reconciliation + sanity). Returns the full trace inline.
   */
  dispatch: (b: DispatchRequest) =>
    request<DispatchResponse>('/pipeline/dispatch', {
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

  /**
   * POST /declaration-runs — multipart upload of a CSV/XLSX invoice.
   * Returns 202 with a poll URL; the run processes asynchronously.
   */
  createDeclarationRun: (params: {
    file: File;
    operatorSlug: string;
    mode: DeclarationRunMode;
  }) => {
    const form = new FormData();
    form.append('file', params.file);
    form.append('operator_slug', params.operatorSlug);
    form.append('mode', params.mode);
    return requestMultipart<DeclarationRunCreated>('/declaration-runs', form);
  },

  /** GET /declaration-runs/{id} — poll for status. */
  getDeclarationRun: (id: string) =>
    request<DeclarationRunSummary>(`/declaration-runs/${encodeURIComponent(id)}`),

  /** GET /declaration-runs/{id}/classifications — per-item results once Phase 1 completes. */
  getDeclarationRunClassifications: (id: string) =>
    request<DeclarationRunClassifications>(
      `/declaration-runs/${encodeURIComponent(id)}/classifications`,
    ),

  /**
   * GET /declaration-runs/{id}/download-links — short-lived SAS URLs.
   *
   * Used by the SPA only to enumerate the file list (names, sizes,
   * content-types). The browser does NOT click the SAS URLs directly
   * any more — clicking a file goes through `getDeclarationRunFile`
   * which streams via the backend (no expiry). The SAS pattern is
   * retained for non-browser clients (CLI, future mobile app) that
   * benefit from the direct-to-storage download path.
   */
  getDeclarationRunDownloadLinks: (id: string) =>
    request<DownloadLinks>(
      `/declaration-runs/${encodeURIComponent(id)}/download-links`,
    ),

  /**
   * GET /declaration-runs/{id}/files/{path} — stream a single file
   * through the backend (Bearer-authed). No SAS, no expiry — works
   * however long the user takes to click. Returns the raw bytes as a
   * Blob; the caller wraps it in an object URL and triggers a save.
   *
   * `relPath` is the file name relative to the run prefix
   * (e.g. "input.csv", "manifest.json", "hv/{filing_id}.xml"). The
   * backend rejects paths containing '..', '\\', or a leading '/'
   * before resolving the blob.
   */
  getDeclarationRunFile: async (id: string, relPath: string): Promise<Blob> => {
    const token = await getAccessToken();
    const url = `${getApimBase()}/declaration-runs/${encodeURIComponent(id)}/files/${relPath
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      let detail: string = res.statusText;
      try {
        const body = await res.json();
        detail =
          (body as { error?: { message?: string } | string } | null)?.error
            ? typeof (body as { error: unknown }).error === 'string'
              ? (body as { error: string }).error
              : (body as { error: { message?: string } }).error.message ?? res.statusText
            : detail;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, detail, null);
    }
    return res.blob();
  },
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

  // ── Observability columns added in the May-3 pipeline iteration ─────
  /**
   * Mirrors `cleanup_kind === 'product'` — true when cleanup classified
   * the input as a recognisable noun. Null when the cleanup LLM
   * failed/skipped, so we can distinguish "ungrounded" from "unknown".
   */
  cleanup_noun_grounded?: boolean | null;
  /**
   * Top-K returned by the retrieval stage 1 (vector recall) BEFORE the
   * sparse rerank narrowed it down. Distinct from `candidate_count`
   * (post-fusion). Used by the retrieval card to render "Pulled 40 →
   * narrowed to 12" rather than just the final number.
   */
  retrieval_stage1_count?: number | null;
  /**
   * PII-stripped shadow of the request envelope. Useful for the raw
   * JSON expander when the original request contains PII; we render
   * `request_redacted` instead of `request` when both are present.
   */
  request_redacted?: TraceRequestMeta | unknown;
  /**
   * Backend guardrail downgraded the result and is asking for human
   * review. When true, the trace header surfaces an amber needs_review
   * badge. Mirrors the same field on `DecisionEnvelopeBase`.
   */
  needs_review?: boolean | null;
  /** Free-form explanation paired with `needs_review`. */
  review_reason?: string | null;
}

/**
 * Per-stage breadcrumbs the backend logs onto `event.request` so the
 * trace UI can determine which stages actually ran without fishing
 * through `model_calls[]` for inferred presence. Every field is
 * optional — older trace rows logged before the breadcrumb fields
 * were added simply omit them, and the UI must render placeholders
 * (not fabricate values) when absent.
 *
 * Mapping for the trace stage timeline (May-3 pipeline):
 *   cleanup_invoked / cleanup_kind          → Cleanup stage card
 *   research_kind / research_latency_ms     → Researcher stage card
 *   research_web_kind                       → Researcher (web) stage card
 *   branch_rank_invoked / branch_rank_*     → Branch-rank stage card
 *   best_effort_invoked / best_effort_*     → Best-effort stage card
 *
 * The chapter-hint stage was removed in the May-3 iteration. Retrieval
 * and the evidence gate are non-LLM stages — we infer they ran by the
 * presence of `top_retrieval_score`, `top2_gap`, and `candidate_count`
 * on the event row (NOT via this struct).
 */
export interface TraceRequestMeta {
  description?: string;

  // ── Cleanup stage ──────────────────────────────────────────────────
  /**
   * What cleanup did. Tightened to the actual backend enum:
   *  - `skipped_clean`     → input was already clean, no LLM ran
   *  - `llm`               → Haiku ran successfully
   *  - `llm_failed`        → Haiku errored / timed out
   *  - `llm_unparseable`   → Haiku returned malformed JSON
   * Older rows may carry `null` (cleanup pre-dated this breadcrumb).
   */
  cleanup_invoked?: 'skipped_clean' | 'llm' | 'llm_failed' | 'llm_unparseable' | null;
  /**
   * The cleaned input string emitted by Haiku (e.g. "t-shirt"), or
   * null when cleanup didn't run / failed. Was a boolean in the
   * pre-May-3 frontend types; the backend always shipped the string.
   */
  cleanup_effective?: string | null;
  cleanup_kind?: 'product' | 'merchant_shorthand' | 'ungrounded' | 'multi_product' | string | null;
  cleanup_attributes_count?: number;
  cleanup_stripped_count?: number;
  cleanup_latency_ms?: number;

  // ── Researcher (canonicalisation) ─────────────────────────────────
  research_kind?: 'recognised' | 'unknown' | 'failed' | string | null;
  research_latency_ms?: number | null;
  research_web_kind?: string | null;
  research_web_latency_ms?: number | null;
  /** Researcher's canonical phrase, when it ran successfully. */
  rewritten_as?: string | null;

  // ── Understanding ─────────────────────────────────────────────────
  understanding_chapters?: string[] | null;
  understanding_distinct_chapters?: number | null;
  interpretation_stage?: 'passthrough' | 'cleaned' | 'researched' | 'unknown' | string;

  // ── Branch-rank ───────────────────────────────────────────────────
  /**
   * Tightened from boolean to the backend enum:
   *  - `skipped`            → branch-rank didn't fire (gate refused / best-effort path)
   *  - `llm`                → Sonnet ran and may have overridden the picker
   *  - `skipped_confident`  → branch had only one leaf, no rerank needed
   */
  branch_rank_invoked?: 'skipped' | 'llm' | 'skipped_confident' | string | null;
  branch_rank_latency_ms?: number | null;
  branch_rank_overrode?: boolean;
  branch_rank_picker_choice?: string | null;
  branch_rank_top_pick?: string | null;

  // ── Best-effort fallback ──────────────────────────────────────────
  best_effort_invoked?: boolean;
  /** Specificity in digits when best-effort fired (2/4/6/8/10). */
  best_effort_specificity?: number | null;

  // ── Other observable signals ──────────────────────────────────────
  prefix_bias?: string | null;
  /** Per-token digit normalisations (e.g. Arabic-Indic → Latin). */
  digit_normalisation?: Array<{ from: string; to: string }> | string | null;
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
