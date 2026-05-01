/**
 * Multilingual e5-small embedder via @xenova/transformers (in-process ONNX).
 * E5 convention: prefix queries with "query: " and passages with "passage: ".
 */
import { env } from '../config/env.js';

type Pipeline = (input: string | string[], opts?: Record<string, unknown>) => Promise<{
  data: Float32Array;
  dims: number[];
}>;

// Cache the in-flight init promise so concurrent first-callers share one load.
let _pipePromise: Promise<Pipeline> | null = null;

async function initPipeline(): Promise<Pipeline> {
  const { pipeline, env: tEnv } = await import('@xenova/transformers');
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
    // Clear cached rejection so the next caller retries.
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
  // dims = [batch, seq, hidden]
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
  const arr = r.dims.length === 2 ? Array.from(r.data) : Array.from(l2(meanPool(r.data, r.dims)));
  return arr;
}

export async function embedPassageBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const pipe = await getPipeline();
  const inputs = texts.map((t) => `passage: ${t}`);
  const r = await pipe(inputs, { pooling: 'mean', normalize: true });
  const hidden = r.dims[r.dims.length - 1]!;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    const slice = r.data.slice(i * hidden, (i + 1) * hidden);
    out.push(Array.from(slice));
  }
  return out;
}

export const EMBEDDER_VERSION = () => env().EMBEDDER_MODEL;

/** Load the ONNX pipeline and run a throwaway forward-pass so the first real request is warm. */
export async function warmEmbedder(): Promise<void> {
  const pipe = await getPipeline();
  await pipe('query: warmup', { pooling: 'mean', normalize: true });
}
