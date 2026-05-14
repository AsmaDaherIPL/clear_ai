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

export type ClassificationStatus = 'AGREEMENT' | 'DRIFT' | 'ZERO_SIGNAL';

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
  /**
   * Pipeline confidence score (0-1 fraction). Populated by dispatchToDescribe
   * from CanonicalClassificationResult.classification_confidence.
   * ResultSingle renders this as e.g. "85%".
   */
  classification_confidence?: number | null;
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
  /**
   * LLM fit verdict. 'does_not_fit' aliases the legacy 'excludes' value
   * so payloads from either era render correctly.
   */
  fit?: 'fits' | 'partial' | 'excludes' | 'does_not_fit';
  reason?: string;
  /**
   * Track of origin for "Considered alternatives" grouping in the
   * sidebar. 'track_a' = annotated_candidates (RRF/picker output),
   * 'track_b' = subtree_candidates (merchant-prefix-anchored).
   */
  track?: 'track_a' | 'track_b';
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
  /** V1 surface: AGREEMENT | DRIFT | ZERO_SIGNAL. Optional on single-shot. */
  classification_status?: ClassificationStatus;
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
  /**
   * Sanity-check verdict and rationale, populated by dispatchToDescribe
   * when the trace carries a sanity stage with FLAG/BLOCK outcome.
   * ResultSingle renders a warning banner when this is present.
   */
  sanity_verdict?: 'PASS' | 'FLAG' | 'BLOCK' | null;
  sanity_rationale?: string | null;
  /**
   * Anchored-pipeline aggregate candidate summary. Set by dispatchToDescribe
   * when `pipeline_architecture === 'anchored'` and per-candidate data is
   * not yet on the wire. ResultSingle renders aggregate counts in the
   * alternatives section.
   */
  anchored_candidate_summary?: AnchoredCandidateSummary | null;
  /**
   * Human-readable retrieval query used by the pipeline.
   * Under anchored: `identify.canonical`. Under legacy: effective_description.
   */
  retrieval_query?: string | null;
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

/** POST /classifications/dispatch body. */
export interface DispatchRequest {
  description: string;
  merchant_code?: string;
  /** Commercial value of the item — required. */
  value_amount: number;
  /** ISO 4217 3-letter code (e.g. 'SAR', 'USD'). */
  currency_code: string;
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
  | 'sanity_check'
  // anchored-pipeline actions (PR-A-5+)
  | 'identify'
  | 'constrain'
  | 'pick';
export type DispatchStepName =
  | 'researcher'
  | 'retrieval'
  | 'threshold'
  | 'web_researcher'
  | 'retrieval_after_web'
  | 'threshold_after_web'
  | 'picker'
  | 'operator_override_lookup'
  | 'codebook_lookup'
  // anchored steps
  | 'identify_llm'
  | 'constrain_codebook_walk'
  | 'constrain_scope_select'
  | 'pick_retrieval'
  | 'pick_llm';

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
  /** 'legacy' = track_a/track_b; 'anchored' = identify/constrain/pick. Default legacy when absent. */
  pipeline_architecture?: 'legacy' | 'anchored';
  merchant_code_state: string | null;
  // Legacy fields
  description_classifier_code?: string | null;
  code_resolver_code?: string | null;
  reconciliation?:
    | 'description_classifier'
    | 'code_resolver'
    | 'reconciled'
    | 'escalated'
    | null;
  // Anchored fields (PR-A-5+)
  identify_kind?: string | null;
  scope_kind?: string | null;
  pick_fit?: string | null;
  pick_escalate_reason?: string | null;
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

/**
 * One candidate from the picker / branch-rank annotated lists.
 * Both track_a.annotated_candidates and track_b.subtree_candidates use
 * this shape. `fit` is the LLM's per-candidate judgement; `rrf_score`
 * is the retrieval fusion score used to sort.
 */
export interface DispatchAnnotatedCandidate {
  code: string;
  /** LLM verdict: 'fits' | 'partial' | 'does_not_fit'. */
  fit?: string;
  rationale?: string;
  rrf_score?: number;
  description_en?: string | null;
  description_ar?: string | null;
}

/**
 * Anchored-pipeline pick action output (PR-A-5+).
 * The aggregate verdict counts replace the per-candidate annotated_candidates
 * array from the legacy track_a path. Per-candidate verdicts are NOT yet
 * on the wire — only the aggregate.
 */
export interface AnchoredPickOutput {
  kind?: string;
  final_code?: string | null;
  fit?: string;
  confidence?: number;
  gir_applied?: string;
  verdict_population?: {
    fits: number;
    partial: number;
    does_not_fit: number;
  };
  audit_flag?: boolean;
}

/**
 * Anchored identify action output (PR-A-5+).
 */
export interface AnchoredIdentifyOutput {
  kind?: string;
  canonical?: string;
  family_chapter?: string;
  identity_tokens?: string[];
  confidence?: number;
  evidence?: string;
  evidence_mismatch?: boolean;
}

/**
 * A synthetic alternatives-summary shape for the anchored pipeline.
 * The UI renders aggregate counts when per-candidate data isn't on the wire.
 */
export interface AnchoredCandidateSummary {
  kind: 'aggregate';
  candidate_count: number;
  fits: number;
  partial: number;
  does_not_fit: number;
  gir_applied?: string;
}

/**
 * Optional `trace.meta` block on the dispatch response. Surfaces:
 *   - track_a.annotated_candidates : RRF-scored picker candidates
 *   - track_b.subtree_candidates    : merchant-prefix-anchored candidates
 *   - verdict                       : final reconciliation outcome
 * The frontend reads `annotated_candidates` and `subtree_candidates` to
 * populate the "Considered alternatives" sidebar.
 */
export interface DispatchTraceMeta {
  track_a?: {
    annotated_candidates?: DispatchAnnotatedCandidate[];
    threshold_failed?: boolean;
    interpretation_stage?: string;
    effective_description?: string;
  };
  track_b?: {
    subtree_candidates?: DispatchAnnotatedCandidate[];
    resolution?: string;
    valid_prefix?: string | null;
    resolved_code?: string | null;
    codebook_state?: string;
    consistency_verdict?: string;
  };
  verdict?: {
    decision?: string;
    conflict_type?: string;
    classification_status?: string;
    rationale?: string;
    final_code?: string | null;
  };
  sanity?: {
    verdict?: string;
    rationale?: string;
  } | null;
}

/** Per-item shape on the dispatch envelope. Same as one `BatchItemsPage.items` entry. */
export interface DispatchItem {
  id: string;
  declared_value: DeclaredValue;
  resolved_hs_code_description: ResolvedHsCodeDescription;
  value: CanonicalValue;
  duty_info: DutyInfo | null;
  procedures: ProcedureRef[];
  classification_result: CanonicalClassificationResult;
  trace?: DispatchTrace & { meta?: DispatchTraceMeta };
  error: string | null;
}

/**
 * Envelope returned by /classifications/dispatch (single-shot) and
 * /classifications/{id} (single-item lookup). `operator_slug` sits at
 * envelope level — it applies to the tenant, not the item. `trace` is
 * on the item and only present when the caller passed `?include_trace=true`.
 */
export interface DispatchResponse {
  operator_slug: string;
  item: DispatchItem;
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

// --- batches (bulk classification) ---------------------------------------
// Renamed from declaration-runs in the 2026-05-12 API cutover. The
// internal backend code/DB still uses declaration_runs naming.

export type BatchMode = 'classify_only' | 'classify_and_declare';
/** @deprecated Use BatchMode. */
export type DeclarationRunMode = BatchMode;

export type BatchStatus =
  | 'pending'
  | 'ingesting'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';
/** @deprecated Use BatchStatus. */
export type DeclarationRunStatus = BatchStatus;

export type ClassificationPhaseStatus = 'pending' | 'running' | 'completed' | 'failed';

export type DeclarationPhaseStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | null;

export type BatchItemStatus =
  | 'pending'
  | 'classifying'
  | 'succeeded'
  | 'flagged'
  | 'blocked'
  | 'failed';
/** @deprecated Use BatchItemStatus. */
export type DeclarationRunItemStatus = BatchItemStatus;

/** Response from POST /batches (HTTP 202). */
export interface BatchCreated {
  batch_id: string;
  mode: BatchMode;
}
/** @deprecated Use BatchCreated. */
export type DeclarationRunCreated = BatchCreated;

/** GET /batches/:id — used for polling. */
export interface BatchSummary {
  id: string;
  operator_slug: string;
  mode: BatchMode;
  status: BatchStatus;
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
/** @deprecated Use BatchSummary. */
export type DeclarationRunSummary = BatchSummary;

/** One {language, value} pair from a `LocalizedString[]`. */
export interface LocalizedString {
  language: 'en' | 'ar';
  value: string | null;
}

/**
 * Pick the value for a target language from a polyglot LocalizedString[].
 * Returns null when the array is missing the language entry or the entry's
 * value is null. Used for fields like
 *   `resolved_hs_code_description.full_hierarchy`
 *   `resolved_hs_code_description.zatca_submission_description`
 * which the backend ships as [{language: 'en', value: ...}, {language: 'ar', value: ...}].
 */
export function pickLang(
  items: readonly LocalizedString[] | null | undefined,
  language: 'en' | 'ar',
): string | null {
  if (!items) return null;
  return items.find((p) => p.language === language)?.value ?? null;
}

/** Merchant-submitted values exactly as they appeared in the source row. */
export interface DeclaredValue {
  hs_code: string | null;
  description: string | null;
  amount: number | null;
  currency: string | null;
}

export interface ResolvedHsCodeDescription {
  /** Bilingual catalog breadcrumb. Always two entries [en, ar]. */
  full_hierarchy: LocalizedString[];
  /** LLM-generated submission description. Always two entries [en, ar]. */
  zatca_submission_description: LocalizedString[];
  /** Effective description that Track A retrieval queried against. */
  retrieval_query: string | null;
}

export interface CanonicalValueAmount {
  value: number | null;
  currency: string | null;
}

export interface CanonicalValue {
  amount: CanonicalValueAmount;
  rate: number | null;
  rate_as_of: string | null;
}

export interface CanonicalClassificationResult {
  resolved_hs_code: string | null;
  classification_status: 'AGREEMENT' | 'DRIFT' | 'ZERO_SIGNAL' | null;
  /** 0-100. Always null until score work lands. */
  classification_confidence: number | null;
  sanity_verdict: 'PASS' | 'FLAG' | 'BLOCK' | null;
}

/**
 * Canonical per-item shape returned by both /batches/{id}/items and
 * /classifications/dispatch. `row_index` is present only on batch
 * responses; `trace` is present only when `?include_trace=true`.
 */
export interface BatchItem {
  id: string;
  row_index?: number;
  declared_value: DeclaredValue;
  resolved_hs_code_description: ResolvedHsCodeDescription;
  value: CanonicalValue;
  duty_info: DutyInfo | null;
  procedures: ProcedureRef[];
  classification_result: CanonicalClassificationResult;
  trace?: Record<string, unknown> | null;
  error: string | null;
}
/** @deprecated Use BatchItem. */
export type DeclarationRunItem = BatchItem;

/** GET /batches/:id/items */
export interface BatchItemsPage {
  batch_id: string;
  /** Operator the batch belongs to. Envelope-level; applies to all items. */
  operator_slug: string;
  items: BatchItem[];
  /**
   * Phase-1 (classification) lifecycle, separate from the run-level
   * status. Authoritative stop signal for the live-poll loop.
   */
  classification_phase?: 'pending' | 'running' | 'completed' | 'failed';
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
}
/** @deprecated Use BatchItemsPage. */
export type DeclarationRunClassifications = BatchItemsPage;

/** GET /batches/:id/files */
export interface BatchFile {
  name: string;
  size_bytes: number | null;
  content_type: string | null;
}
export interface BatchFilesList {
  batch_id: string;
  files: BatchFile[];
}
/** @deprecated Use BatchFile. */
export type DownloadLinkFile = BatchFile;
/** @deprecated Use BatchFilesList. */
export type DownloadLinks = BatchFilesList;

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

/** Response shape from GET /reference-data/currencies. */
export interface ReferenceCurrenciesResponse {
  currencies: string[];
}

export const api = {
  health: () => request<HealthResponse>('/health'),

  /**
   * GET /reference-data/currencies — ISO 4217 currency codes accepted by
   * the pipeline. Used to populate the Composer's currency picker.
   * Returns the canonical list (no symbols or translated names — just
   * 3-letter codes); same response shape for both UI languages.
   */
  getReferenceCurrencies: () =>
    request<ReferenceCurrenciesResponse>('/reference-data/currencies'),

  /** POST /classifications — primary classification endpoint. */
  classify: (b: ClassifyRequest) =>
    request<DescribeResponse>('/classifications', {
      method: 'POST',
      body: JSON.stringify(b),
    }),

  /**
   * POST /classifications/dispatch — single-item classification through
   * the two-track pipeline. Returns the canonical item shape; pass
   * `include_trace=true` to also receive the full PipelineTrace.
   * Renamed from /pipeline/dispatch in the 2026-05-12 API cutover.
   */
  dispatchClassification: (b: DispatchRequest, opts?: { includeTrace?: boolean }) => {
    const suffix = opts?.includeTrace ? '?include_trace=true' : '';
    return request<DispatchResponse>(`/classifications/dispatch${suffix}`, {
      method: 'POST',
      body: JSON.stringify(b),
    });
  },

  /** @deprecated Use dispatchClassification. */
  dispatch: (b: DispatchRequest, opts?: { includeTrace?: boolean }) => {
    const suffix = opts?.includeTrace ? '?include_trace=true' : '';
    return request<DispatchResponse>(`/classifications/dispatch${suffix}`, {
      method: 'POST',
      body: JSON.stringify(b),
    });
  },

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

  /**
   * GET /classifications/{id}?include_trace=true — fetch a persisted
   * classification + its full trace blob (gated by include_trace so the
   * standard /classifications/{id} call stays lightweight). Replaces the
   * removed GET /classifications/trace/{id} endpoint.
   */
  trace: (id: string) =>
    request<TraceResponse>(
      `/classifications/${encodeURIComponent(id)}?include_trace=true`,
    ),

  /** GET /reference-data/currencies — ISO 4217 codes accepted by the pipeline. */
  listCurrencies: () =>
    request<{ currencies: string[] }>('/reference-data/currencies'),

  /** GET /reference-data/fx-rates — SAR conversion rates (one row per currency). */
  listFxRates: () =>
    request<{
      base: 'SAR';
      rates: Array<{ currency: string; sar_per_unit: number; as_of: string }>;
    }>('/reference-data/fx-rates'),

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
   * POST /batches — multipart upload of a CSV/XLSX invoice. Returns 202
   * with a batch id; the run processes asynchronously. Renamed from
   * /declaration-runs in the 2026-05-12 API cutover.
   *
   * operator_slug and metadata fields were dropped from the request
   * body; the V1 deployment is single-operator (naqel) and metadata
   * wasn't being read anywhere.
   */
  createBatch: (params: { file: File; mode: BatchMode }) => {
    const form = new FormData();
    form.append('file', params.file);
    form.append('mode', params.mode);
    return requestMultipart<BatchCreated>('/batches', form);
  },
  /** @deprecated Use createBatch. */
  createDeclarationRun: (params: {
    file: File;
    operatorSlug?: string;
    mode: BatchMode;
  }) => {
    void params.operatorSlug; // legacy param, no longer sent
    const form = new FormData();
    form.append('file', params.file);
    form.append('mode', params.mode);
    return requestMultipart<BatchCreated>('/batches', form);
  },

  /** GET /batches/{id} — poll for status. */
  getBatch: (id: string) =>
    request<BatchSummary>(`/batches/${encodeURIComponent(id)}`),
  /** @deprecated Use getBatch. */
  getDeclarationRun: (id: string) =>
    request<BatchSummary>(`/batches/${encodeURIComponent(id)}`),

  /**
   * GET /batches/{id}/items — per-item results. Server-side paginated:
   * default page size is 100, max 500. Pass `includeTrace: true` to also
   * receive the per-item PipelineTrace (off by default — heavy column).
   */
  getBatchItems: (
    id: string,
    opts?: { limit?: number; offset?: number; includeTrace?: boolean },
  ) => {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.offset !== undefined) params.set('offset', String(opts.offset));
    if (opts?.includeTrace) params.set('include_trace', 'true');
    const qs = params.toString();
    const suffix = qs ? `?${qs}` : '';
    return request<BatchItemsPage>(
      `/batches/${encodeURIComponent(id)}/items${suffix}`,
    );
  },
  /** @deprecated Use getBatchItems. */
  getDeclarationRunClassifications: (
    id: string,
    opts?: { limit?: number; offset?: number; includeTrace?: boolean },
  ) => {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.offset !== undefined) params.set('offset', String(opts.offset));
    if (opts?.includeTrace) params.set('include_trace', 'true');
    const qs = params.toString();
    const suffix = qs ? `?${qs}` : '';
    return request<BatchItemsPage>(
      `/batches/${encodeURIComponent(id)}/items${suffix}`,
    );
  },

  /** POST /batches/{id}/cancel — cancel a running batch. */
  cancelBatch: (id: string) =>
    request<BatchSummary>(`/batches/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    }),

  /**
   * GET /batches/{id}/files — list files under the batch's blob prefix.
   * No SAS URLs (the SPA streams via getBatchFile). Replaces the
   * /download-links endpoint.
   */
  getBatchFiles: (id: string) =>
    request<BatchFilesList>(`/batches/${encodeURIComponent(id)}/files`),
  /** @deprecated Use getBatchFiles. */
  getDeclarationRunDownloadLinks: (id: string) =>
    request<BatchFilesList>(`/batches/${encodeURIComponent(id)}/files`),

  /**
   * GET /batches/{id}/files/{path} — stream a single file through the
   * backend (Bearer-authed). No SAS, no expiry. `relPath` is the file
   * name relative to the batch prefix (e.g. "input.csv",
   * "hv/{filing_id}.xml"). The backend rejects paths with '..', '\\',
   * or a leading '/'.
   */
  getBatchFile: async (id: string, relPath: string): Promise<Blob> => {
    const token = await getAccessToken();
    const url = `${getApimBase()}/batches/${encodeURIComponent(id)}/files/${relPath
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
  /** @deprecated Use getBatchFile. */
  getDeclarationRunFile: async (id: string, relPath: string): Promise<Blob> => {
    const token = await getAccessToken();
    const url = `${getApimBase()}/batches/${encodeURIComponent(id)}/files/${relPath
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
  classification_status: string | null;
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
