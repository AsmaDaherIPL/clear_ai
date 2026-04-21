/**
 * ClearAI API client — typed wrapper over the FastAPI backend.
 *
 * Backend contract lives in clearai-backend/api/schemas.py. The types below
 * are a SUPERSET: optional fields marked with `// BACKEND GAP` are required
 * by the v5 UI but not yet returned by the API. See root README for the
 * outstanding backend tasks.
 */

export const API_BASE =
  (import.meta.env.PUBLIC_CLEARAI_API_BASE as string | undefined) ??
  'http://localhost:8787';

// --- Request ---------------------------------------------------------------
export interface ResolveRequest {
  description?: string;
  hs_code?: string;
  value?: number;
  currency?: string;
  origin?: string;
  destination?: string;
}

// --- Response --------------------------------------------------------------
export type ResolutionPath = 'direct' | 'prefix' | 'reasoner' | 'failed';

export interface EvidenceItem {
  rank: number;
  score: number;
  hs_code: string;
  description_en: string;
  description_ar: string;
  duty_rate_pct: number | null;
  // BACKEND GAP — optional: source label + snippet for the "Sources cited" block
  source?: 'ZATCA Tariff' | 'WCO Notes' | 'Bayan ruling' | string;
  title?: string;
  snippet?: string;
}

export interface Justification {
  product_name: string;
  understanding_the_product: string;
  relevant_tariff_headings: string[];
  exclusions_of_other_subheadings: string[];
  wco_hs_explanatory_notes: string;
  correct_classification: string;
  conclusion: string;
}

// BACKEND GAP — 3-step rationale surfaced in the "Explained" tab.
export interface RationaleStep {
  title: string;           // e.g. "Chapter 49 — Printed matter"
  detail: string;          // one-sentence explanation
  plain_explanation: string; // markdown-ish "What this means: ..."
  reference: string;       // e.g. "WCO GIR 1", "GIR 3(a)", "ZATCA Note 4901"
}

/**
 * One rung of the plain-English classification ladder. Rendered top-to-bottom
 * under the main result card so non-experts can trace the chain without
 * knowing WCO terminology.
 */
export interface HSLadderRow {
  level: string;           // "The big category" | "The family" | "The sub-family" | "Your exact item"
  code: string;            // 2 / 4 / 6 / 12 digits
  description_en: string;
  description_ar: string;
}

/**
 * Nearest FAISS competitor the model rejected. Paired with a single plain
 * English sentence — no GRI citation, no heading number — suitable for
 * a non-specialist "why not this one?" card.
 */
export interface ClosestAlternative {
  hs_code: string;
  description_en: string;
  description_ar: string;
  why_not: string;
}

// Per-stage pipeline trace. `key` is an open string (v5.1) so the backend
// can emit fine-grained sub-stages (justify / translate_ar / refine_en /
// reason_infer) without a version bump.
export interface PipelineStage {
  key: string;
  label: string;
  duration_ms: number;
}

/**
 * Diagnostic metadata for the "Dev view" panel. NOT a customer-facing quality
 * signal — mark the panel accordingly in the UI.
 *
 * Note: `cost_usd` was intentionally removed. Anthropic's SDK returns token
 * counts only; billed cost comes via Azure Foundry invoices, not the API.
 * Hardcoded list-price estimates would be misleading.
 */
export interface ProcessMeta {
  model: string;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  /** # of FAISS candidates the justifier cited in its snippets. */
  candidates_considered: number;
  /** # of FAISS candidates retrieved (= FAISS_TOP_K, currently 10). */
  candidates_retrieved: number;
}

export interface ResolveResponse {
  hs_code: string;
  customs_description_en: string;
  customs_description_ar: string;
  duty_rate_pct: number | null;
  confidence: number;
  path: ResolutionPath;
  model_used: string | null;
  flagged_for_review: boolean;
  agrees_with_naqel: boolean | null;
  naqel_bucket_hint: string | null;
  rationale: string | null;
  error: string | null;
  justification: Justification | null;
  evidence: EvidenceItem[];

  // ---- BACKEND GAPs — optional until wired up on the API -----------------
  trace_id?: string;
  plain_summary?: string;             // e.g. "This is a **comic book**. …"
  product_description_en?: string;    // echoed merchant description
  product_description_ar?: string;    // AR translation of merchant description
  rationale_steps?: RationaleStep[];  // 3-step "Explained" narrative
  stages?: PipelineStage[];           // 6-stage pipeline timings
  meta?: ProcessMeta;

  // Non-expert-friendly extensions
  hs_code_ladder?: HSLadderRow[];       // 4-rung plain-English ladder (Chapter → line)
  closest_alternative?: ClosestAlternative | null;  // "Why not this one?" card
}

export interface HealthResponse {
  status: string;
  version: string;
  anthropic_base_url: string;
  db_path: string;
  faiss_index_path: string;
  faiss_index_present: boolean;
  // BACKEND GAP — ZATCA tariff version stamp for the top bar ("ZATCA · 2024.3")
  zatca_version?: string;
}

// --- Client ---------------------------------------------------------------
class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail ?? detail;
    } catch { /* non-json body, keep statusText */ }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => request<HealthResponse>('/api/health'),
  resolve: (body: ResolveRequest) =>
    request<ResolveResponse>('/api/resolve', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

export { ApiError };
