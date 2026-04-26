/**
 * Multilingual e5-small embedder via @xenova/transformers (in-process ONNX).
 *
 * E5 convention:
 *   - prefix queries with "query: "
 *   - prefix passages with "passage: "
 * The model emits sentence embeddings; we mean-pool + L2-normalize so cosine = dot.
 */
import { env } from '../config/env.js';

// Type-only import to avoid loading the package at startup when unused (e.g. unit tests).
type Pipeline = (input: string | string[], opts?: Record<string, unknown>) => Promise<{
  data: Float32Array;
  dims: number[];
}>;

// We cache the **in-flight initialization promise**, not just the resolved
// pipeline. The previous version cached only the resolved value, so several
// concurrent first-callers (cold start with parallel /classify requests) could
// each enter the dynamic `import()` + `pipeline()` path before any of them
// assigned `_pipe`. For an ONNX model that means duplicate downloads, duplicate
// memory allocations, multiplied startup latency, and avoidable pod churn under
// memory pressure. Caching the Promise serialises every concurrent caller onto
// the same single initialization.
let _pipePromise: Promise<Pipeline> | null = null;

async function initPipeline(): Promise<Pipeline> {
  const { pipeline, env: tEnv } = await import('@xenova/transformers');
  // Cache models locally so we never re-download in dev or in container.
  tEnv.allowLocalModels = true;
  tEnv.cacheDir = './models';
  const model = env().EMBEDDER_MODEL;
  return (await pipeline('feature-extraction', model, {
    quantized: true,
  })) as unknown as Pipeline;
}

function getPipeline(): Promise<Pipeline> {
  if (_pipePromise) return _pipePromise;
  _pipePromise = initPipeline().catch((err) => {
    // If init itself failed, clear the cached rejection so the *next* caller
    // gets a fresh attempt rather than re-rethrowing the same stale error
    // forever (which would brick the process until restart).
    _pipePromise = null;
    throw err;
  });
  return _pipePromise;
}

function l2(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const n = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

function meanPool(flat: Float32Array, dims: number[]): Float32Array {
  // dims = [batch, seq, hidden]; for a single input flat length = seq*hidden
  const seq = dims[1] ?? 1;
  const hidden = dims[2] ?? flat.length;
  const out = new Float32Array(hidden);
  for (let s = 0; s < seq; s++) {
    for (let h = 0; h < hidden; h++) {
      out[h]! += flat[s * hidden + h]!;
    }
  }
  for (let h = 0; h < hidden; h++) out[h]! /= seq;
  return out;
}

export async function embedQuery(text: string): Promise<number[]> {
  const pipe = await getPipeline();
  const r = await pipe(`query: ${text}`, { pooling: 'mean', normalize: true });
  // When pooling+normalize requested, dims = [1, hidden]; we still defensively handle [1,seq,hidden]
  const arr = r.dims.length === 2 ? Array.from(r.data) : Array.from(l2(meanPool(r.data, r.dims)));
  return arr;
}

export async function embedPassageBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const pipe = await getPipeline();
  const inputs = texts.map((t) => `passage: ${t}`);
  const r = await pipe(inputs, { pooling: 'mean', normalize: true });
  // r.data is [batch, hidden]
  const hidden = r.dims[r.dims.length - 1]!;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    const slice = r.data.slice(i * hidden, (i + 1) * hidden);
    out.push(Array.from(slice));
  }
  return out;
}

export const EMBEDDER_VERSION = () => env().EMBEDDER_MODEL;
