/**
 * ClearAI API client — typed wrapper over the FastAPI backend.
 *
 * Backend contract lives in clearai-backend/api/schemas.py. Keep these
 * types in sync by hand for now; when the surface grows we'll codegen
 * from the OpenAPI schema at /openapi.json.
 *
 * Base URL:
 *   - dev default: http://localhost:8787
 *   - override via PUBLIC_CLEARAI_API_BASE (Astro exposes PUBLIC_* to the client)
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
export type ResolutionPath = 'path_1_clean' | 'path_2_faiss' | 'path_3_llm' | 'failed';

export interface EvidenceItem {
  rank: number;
  score: number;
  hs_code: string;
  description_en: string;
  description_ar: string;
  duty_rate_pct: number | null;
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
}

export interface HealthResponse {
  status: string;
  version: string;
  anthropic_base_url: string;
  db_path: string;
  faiss_index_path: string;
  faiss_index_present: boolean;
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
