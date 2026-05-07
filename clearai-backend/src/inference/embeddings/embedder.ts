/**
 * Foundry-hosted text-embedding-3-large client.
 *
 * Migration history:
 *   - Pre-Plan-B: Xenova/multilingual-e5-small via @xenova/transformers
 *     (in-process ONNX, ~500 MB heap, ~10-15s cold start, 384-dim).
 *   - Plan B: this client. Azure AI Foundry deployment, 1024-dim
 *     (Matryoshka truncation from 3072 native), ~60-150ms per call.
 *
 * Why the swap: e5-small under-clusters technical / domain-specific
 * terminology (HS-code product names, mixed AR/EN customs jargon).
 * `text-embedding-3-large` adds ~5-8 nDCG@10 on multilingual retrieval
 * benchmarks and removes the heavy in-process ONNX dependency.
 *
 * Auth: API key today (via FOUNDRY_EMBED_API_KEY). The same Foundry
 * resource hosts the LLM deployments — when the LLM client moves to
 * managed identity, this client should follow the same pattern.
 *
 * E5's "query:" / "passage:" prefix convention is NOT used here —
 * text-embedding-3-large doesn't have asymmetric query/doc encoders;
 * raw text is correct.
 */
import { env } from '../../config/env.js';

interface FoundryEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 5;
/** Base for exponential backoff on 429 / 5xx. */
const RETRY_BASE_MS = 1000;

/**
 * Build the embeddings endpoint URL from the deployment-base URI.
 *
 * Foundry exposes deployments at:
 *   https://<resource>.services.ai.azure.com/openai/deployments/<deployment>/embeddings?api-version=…
 *
 * Accepts either:
 *   - a plain resource base (https://aif-…services.ai.azure.com)
 *   - or the full embeddings URL already (passed through as-is).
 */
function resolveEmbeddingsUrl(): string {
  const e = env();
  const base = e.FOUNDRY_EMBED_ENDPOINT;
  const apiVersion = '2024-10-21';
  if (base.includes('/embeddings')) return base;
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}/openai/deployments/${e.FOUNDRY_EMBED_MODEL}/embeddings?api-version=${apiVersion}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Parse `Retry-After` header. Foundry sometimes sends it (seconds);
 * otherwise we fall back to exponential backoff.
 */
function retryAfterMs(res: Response): number | null {
  const v = res.headers.get('retry-after');
  if (!v) return null;
  const sec = Number(v);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return Math.ceil(sec * 1000);
}

async function callFoundryOnce(
  url: string,
  apiKey: string,
  body: string,
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

/** Marker thrown for non-retryable HTTP errors so the outer retry loop bails out. */
class FoundryNonRetryableError extends Error {}

async function callFoundry(input: string | string[]): Promise<number[][]> {
  const e = env();
  const url = resolveEmbeddingsUrl();
  const body = JSON.stringify({
    input,
    // Matryoshka truncation. text-embedding-3-large is 3072-dim natively;
    // 1024 keeps storage tractable and matches the catalog vector(1024).
    dimensions: e.FOUNDRY_EMBED_DIM,
  });

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await callFoundryOnce(url, e.FOUNDRY_EMBED_API_KEY, body);
      // Retry on 429 (rate limit) and 5xx (transient upstream); fail-fast on
      // 4xx that aren't 429 (auth / bad request — retrying won't help).
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        const wait =
          retryAfterMs(res) ?? Math.min(RETRY_BASE_MS * 2 ** attempt, 30_000);
        const text = await res.text().catch(() => '');
        if (attempt < MAX_RETRIES) {
          await sleep(wait);
          lastErr = new Error(
            `Foundry embedding error ${res.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}, wait=${wait}ms): ${text.slice(0, 200)}`,
          );
          continue;
        }
        throw new Error(
          `Foundry embedding error ${res.status} after ${MAX_RETRIES + 1} attempts: ${text.slice(0, 500)}`,
        );
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new FoundryNonRetryableError(
          `Foundry embedding error ${res.status}: ${text.slice(0, 500)}`,
        );
      }
      const json = (await res.json()) as FoundryEmbeddingResponse;
      // Sort by `index` defensively — Foundry returns them in order, but it's
      // contractually unordered.
      const sorted = [...json.data].sort((a, b) => a.index - b.index);
      return sorted.map((d) => d.embedding);
    } catch (err) {
      // Non-retryable → bail out immediately, regardless of attempt count.
      if (err instanceof FoundryNonRetryableError) throw err;
      // Network errors / aborts → retry with backoff.
      if (attempt >= MAX_RETRIES) throw err;
      const wait = Math.min(RETRY_BASE_MS * 2 ** attempt, 30_000);
      await sleep(wait);
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('Foundry embedding failed for unknown reason.');
}

export async function embedQuery(text: string): Promise<number[]> {
  const [v] = await callFoundry(text);
  if (!v) throw new Error('Foundry returned no embedding for query.');
  return v;
}

/**
 * Batch embed for ingest. Foundry's text-embedding-3-large accepts up to
 * ~16 inputs per request; the catalog ingest splits ahead of this call.
 */
export async function embedPassageBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  return callFoundry(texts);
}

export const EMBEDDER_VERSION = () => env().FOUNDRY_EMBED_MODEL;

/**
 * No-op for the Foundry client (network call, no warm-up needed). Kept
 * exported so existing callers in server bootstrap continue to compile.
 */
export async function warmEmbedder(): Promise<void> {
  // Foundry-hosted; no in-process model to load.
}
