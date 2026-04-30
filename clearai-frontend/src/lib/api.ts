/**
 * ClearAI API client — typed wrapper over the Fastify backend.
 *
 * Backend contract lives in:
 *   clearai-backend/src/routes/classify.ts                  (POST /classifications)
 *   clearai-backend/src/routes/expand.ts                    (POST /classifications/expand)
 *   clearai-backend/src/routes/classification-trace.ts      (GET / POST /classifications/{id}[/feedback])
 *   clearai-backend/src/routes/submission-description.ts    (POST /classifications/{id}/submission-description)
 *   clearai-backend/src/types/domain.ts                     (cross-cutting unions)
 *
 * This file is the single hand-kept mirror of that contract on the
 * browser side. Keep field names in sync (snake_case from the wire,
 * exposed unchanged here so a `grep` across both repos finds matches).
 *
 * The shape is *much* smaller than the legacy Python contract — there's
 * no justification, no rationale_steps, no closest_alternative, no
 * pipeline stages, no batch lane. Just the decision envelope +
 * alternatives.
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
  | 'best_effort_heading'
  /**
   * Heading-level acceptance (ADR-0019). The route promoted a 4-digit
   * best-effort heading into the heading-padded 12-digit form
   * (e.g. 4202 → 420200000000), which ZATCA accepts as a valid
   * declaration. Always paired with decision_status='accepted' and
   * confidence_band='medium'. Frontend should render this as a
   * legitimate accepted result with a soft "heading-level — add the
   * material to refine" eyebrow, not the verify-toggle gating used
   * for best_effort.
   */
  | 'heading_level_match';

export type ConfidenceBand = 'high' | 'medium' | 'low';

export type MissingAttribute =
  | 'material'
  | 'intended_use'
  | 'product_type'
  | 'dimensions'
  | 'composition';

/**
 * ZATCA duty rate for the chosen code. The catalog stores duty bilingually
 * but the values are essentially one attribute that's either:
 *   - a numeric percentage (5 / 6.5 / 12) → `rate_percent` set, status nulls
 *   - a status word ("Exempted" / "Prohibited from Importing" with their
 *     Arabic translations) → status_en / status_ar set, rate_percent null
 * `null` on the response when the chosen code is heading-level (no leaf
 * duty applies) or when the catalog row had no duty entry.
 */
export interface DutyInfo {
  rate_percent: number | null;
  status_en: string | null;
  status_ar: string | null;
  raw_en: string | null;
  raw_ar: string | null;
}

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
  /** ZATCA duty rate / status. Null on heading-level / unknown rows. */
  duty?: DutyInfo | null;
  /**
   * Required customs procedures attached to this leaf (SFDA approval,
   * Ministry of Environment quarantine, livestock export approval,
   * etc). Sourced from ZATCA's `دليل رموز إجراءات فسح وتصدير السلع`
   * via the catalog.
   *
   * Order is meaningful — first item is the most blocking. Consumers
   * MUST NOT re-sort.
   *
   * The KEY IS OMITTED ENTIRELY when the leaf has no procedures
   * attached, so callers branch on
   * `if (result.procedures && result.procedures.length)`.
   *
   * Earlier versions of this field were a single string (e.g. "61");
   * the backend swapped to the array-of-objects shape on this
   * release. There is no migration shim — any caller still expecting
   * the old string would TypeScript-error on read, which is the
   * intended early signal.
   */
  procedures?: ProcedureRef[];
}

/**
 * One row from the ZATCA procedure-codes table, attached to an HS leaf
 * via `ResultLine.procedures`.
 *
 * `description_ar` is published by ZATCA only in Arabic — there is no
 * official EN translation. Render it as `dir="rtl" lang="ar"`.
 *
 * `is_repealed = true` when the description ends with `(ملغي)`. ZATCA
 * keeps repealed procedures in the catalogue for historical reference;
 * frontends should hide them from the primary "required procedures"
 * list (they don't apply to current shipments) but expose them behind
 * a disclosure so trace fidelity is preserved.
 */
export interface ProcedureRef {
  /** ZATCA procedure code, e.g. "2", "28", "61". */
  code: string;
  /** Official Arabic description from ZATCA. Always present, never empty. */
  description_ar: string;
  /** True when the description ends with "(ملغي)". */
  is_repealed: boolean;
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
  /** null when the request didn't reach the LLM (gate failed, single-descendant). */
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

/** Common envelope shared by POST /classifications and POST /classifications/expand. */
export interface DecisionEnvelopeBase {
  /**
   * Phase 4 — UUID of the classification_events row written for this
   * request. Surfaced so the frontend can deep-link to /classifications/:id and
   * POST feedback. Optional only because logging is best-effort: if the
   * DB is briefly unavailable, the classification still ships, but the
   * trace link won't render.
   */
  request_id?: string;
  decision_status: DecisionStatus;
  decision_reason: DecisionReason;
  confidence_band?: ConfidenceBand;
  alternatives: AlternativeLine[];
  rationale?: string;
  missing_attributes?: MissingAttribute[];
  /** Optional on /classifications/expand (which don't run the researcher today). */
  interpretation?: Interpretation;
  /**
   * @deprecated /classify/describe no longer emits this field — the
   * submission description is fetched lazily via GET
   * /classify/newDescription?request_id=<id>. The type is retained in
   * the envelope so /classifications/expand (which still
   * embed it inline) continue to type-check; new code should consume
   * NewDescriptionResponse instead.
   */
  submission_description?: SubmissionDescription;
  model: ModelInfo;
}

/** /classifications response — `result` is present iff status='accepted'. */
export interface DescribeResponse extends DecisionEnvelopeBase {
  result?: ResultLine;
}

/**
 * /classifications/expand returns a "before / after" pair when
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

/**
 * POST /classifications request shape.
 * (Was DescribeRequest before the 2026-04-30 API refactor.)
 */
export interface ClassifyRequest {
  description: string;
}

export interface ExpandRequest {
  /** 4 to 10 digits (any length in that range). Backend rejects others with 400. */
  code: string;
  description: string;
}

/**
 * Lazy-loaded ZATCA submission description. Returned by
 * POST /classifications/{id}/submission-description, which the frontend
 * fires on mount of the submission card AFTER the main /classifications
 * response has landed. Splitting this out lets the result card render
 * 3-5s sooner (the LLM rewrite is the slowest step on the describe path).
 *
 * `source`:
 *   - 'llm':            Haiku-generated; ship as-is, no review pill needed.
 *   - 'guard_fallback': deterministic prefix-mutator ran because the LLM
 *                       guard tripped or the LLM matched the catalog
 *                       word-for-word. Surface a "Review required" hint.
 *
 * Errors (carry through ApiError.status + .body.error):
 *   400 invalid_query  — malformed request_id (uuid validation failed).
 *   400 invalid_state  — the original classification wasn't on the
 *                        accepted 12-digit path (e.g. needs_clarification
 *                        or best_effort). The submission card SHOULD
 *                        unmount itself rather than render an error.
 *   404 not_found      — request_id doesn't exist (trace expired / wrong
 *                        DB / replayed an old session).
 */
export interface NewDescriptionResponse {
  description_ar: string;
  description_en: string;
  source: 'llm' | 'guard_fallback';
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
    // Prefer the typed `error` field (zod-emitted machine-readable code,
    // e.g. "invalid_query"), fall back to `message`, then HTTP statusText.
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

  /**
   * POST /classifications — primary classification endpoint.
   * Was POST /classify/describe before the 2026-04-30 API refactor.
   */
  classify: (b: ClassifyRequest) =>
    request<DescribeResponse>('/classifications', {
      method: 'POST',
      body: JSON.stringify(b),
    }),

  /**
   * POST /classifications/expand — narrow a parent prefix (4-10 digits)
   * to a 12-digit leaf. Was POST /classify/expand.
   */
  expand: (b: ExpandRequest) =>
    request<ExpandBoostResponse>('/classifications/expand', {
      method: 'POST',
      body: JSON.stringify(b),
    }),

  /**
   * POST /classifications/{id}/submission-description — generate the
   * ZATCA-grade Arabic submission text on demand.
   *
   * Was GET /classify/newDescription?request_id=<id>. Now POST because
   * every call burns Haiku tokens — POST stops browsers/proxies/CDNs
   * from auto-replaying and keeps the URL out of access logs. The
   * `signal` parameter still works for in-flight cancellation when the
   * user reclassifies before the previous submission resolved.
   */
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
   * GET /classifications/{id} — fetch a persisted classification + its
   * feedback rows. Was GET /trace/:eventId.
   */
  trace: (id: string) =>
    request<TraceResponse>(`/classifications/${encodeURIComponent(id)}`),

  /**
   * POST /classifications/{id}/feedback — record human feedback on a
   * classification. UPSERT-on-(event_id, user_id) so a repeat POST from
   * the same user updates their existing feedback. Was POST
   * /trace/:eventId/feedback.
   */
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
    case 'heading_level_match': return 'Heading-level match';
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
      // Same hint covers two real failure modes:
      //   (a) the user typed a brand or SKU we don't recognise
      //       ("Loewe Wōmen perfume", "Boston BWN39")
      //   (b) the user typed gibberish or near-empty text
      //       ("test test", "xyz", "asdf 123")
      // In both cases the underlying problem is the SAME: retrieval
      // had nothing meaningful to match on. The fix is the same too:
      // describe what the product physically is.
      return 'We could not identify a product from your input. Describe what it physically is — material, type, and purpose (e.g. "leather sandal with adjustable straps", "cold-pressed olive oil 500ml bottle").';
    default:
      // Generic "we couldn't classify this" fallback. Same shape as
      // brand_not_recognised on purpose — both ultimately ask the
      // user to describe the physical product instead of typing
      // brand jargon, abbreviations, or unclear text.
      return 'We could not classify this input. Try describing the product itself — material, type, and purpose (e.g. "leather sandal with adjustable straps").';
  }
}

export function statusToTone(status: DecisionStatus): 'good' | 'warn' | 'bad' {
  if (status === 'accepted') return 'good';
  if (status === 'needs_clarification') return 'warn';
  if (status === 'best_effort') return 'warn';
  return 'bad';
}

// ---- Phase 4: trace + feedback ---------------------------------------------

/**
 * Full debug payload for a single classification, returned by GET /classifications/:id.
 * Mirrors the classification_events row plus any associated feedback rows.
 *
 * Most fields are jsonb on the DB side and arrive here as `unknown`; the
 * trace UI renders them defensively (object-aware pretty-print, fall back
 * to JSON.stringify when the shape isn't recognised).
 */
export interface TraceEvent {
  id: string;
  created_at: string;
  endpoint: 'describe' | 'expand' | 'boost';
  request: unknown;
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
  llm_used: boolean;
  llm_status: string | null;
  guard_tripped: boolean;
  model_calls: unknown;
  embedder_version: string | null;
  llm_model: string | null;
  total_latency_ms: number | null;
  error: string | null;
  /** Picker's rationale string. Only populated on accepted-path
   *  responses; null on degraded / needs_clarification / best-effort. */
  rationale?: string | null;
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

// Trace / feedback API methods are wired into the `api` object above
// (api.trace and api.feedback). The types live here for callers to import.
