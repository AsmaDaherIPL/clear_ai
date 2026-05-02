/** Tiny route-level helpers for the response envelope contract. */
import { EMBEDDER_VERSION } from '../embeddings/embedder.js';
import { getPool } from '../db/client.js';

/** Spread `request_id` only when present. */
export function withRequestId(
  requestId: string | null,
): { request_id: string } | Record<string, never> {
  return requestId ? { request_id: requestId } : {};
}

/** The `model` block attached to every classification response. */
export function baseModelInfo(llm: string | null = null): {
  embedder: string;
  llm: string | null;
} {
  return { embedder: EMBEDDER_VERSION(), llm };
}

/** Strip ZATCA catalog tree-depth dashes/colons. Returns null for empty input. */
export function trimCatalogDashes(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const out = s
    .replace(/^[\s\-–—·.•:]+/, '')
    .replace(/[\s\-–—·.•:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length === 0 ? null : out;
}

/** Trim catalog dashes on every alternative in place. */
export function trimAlternativeDashes<
  T extends { description_en: string | null; description_ar: string | null },
>(alts: T[]): T[] {
  for (const a of alts) {
    a.description_en = trimCatalogDashes(a.description_en);
    a.description_ar = trimCatalogDashes(a.description_ar);
  }
  return alts;
}

/**
 * Display-data attachment (ADR-0025 commit #6).
 *
 * label_en/ar  — own-row description with leading dashes pre-stripped at
 *                index time. Same content as `trimCatalogDashes(description_en)`
 *                but resolved from hs_code_display once instead of recomputed
 *                on every request.
 * path_en/ar   — full breadcrumb path joined by " > " (e.g. "Other footwear …
 *                > Other footwear : > Other"). New surface for frontend
 *                breadcrumb rendering and broker error messages.
 */
export interface DisplayInfo {
  label_en: string;
  label_ar: string | null;
  path_en: string;
  path_ar: string | null;
}

/**
 * Batch-load display rows for a list of HS-12 codes. Returns a Map so
 * callers can do O(1) lookups when assembling the response. Codes not
 * found in hs_code_display are absent from the Map (not an error — the
 * caller should fall back to description_en for back-compat).
 */
export async function loadDisplayInfo(codes: string[]): Promise<Map<string, DisplayInfo>> {
  if (codes.length === 0) return new Map();
  const pool = getPool();
  const r = await pool.query<{
    code: string;
    label_en: string;
    label_ar: string | null;
    path_en: string;
    path_ar: string | null;
  }>(
    `SELECT code, label_en, label_ar, path_en, path_ar
       FROM hs_code_display
      WHERE code = ANY($1::char(12)[])`,
    [codes],
  );
  const out = new Map<string, DisplayInfo>();
  for (const row of r.rows) {
    out.set(row.code, {
      label_en: row.label_en,
      label_ar: row.label_ar,
      path_en: row.path_en,
      path_ar: row.path_ar,
    });
  }
  return out;
}

/**
 * Single-code variant for hot paths that already do a single SELECT
 * (e.g. expand's "fetch chosen code's catalog row"). Returns null when
 * the code has no display row (hs_codes existed before display was
 * populated, or out-of-band INSERT).
 */
export async function loadDisplayInfoOne(code: string): Promise<DisplayInfo | null> {
  const m = await loadDisplayInfo([code]);
  return m.get(code) ?? null;
}
