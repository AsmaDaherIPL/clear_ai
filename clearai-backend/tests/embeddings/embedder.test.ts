/**
 * Foundry text-embedding-3-large client tests.
 *
 * Pre-Plan-B these tests exercised the in-process ONNX cold-start race
 * (cached init promise + recovery on init failure). Post-Plan-B the
 * embedder is a stateless HTTP client to a Foundry deployment, so the
 * cold-start race is gone. New tests cover:
 *   - request shape: POST to /openai/deployments/.../embeddings with
 *     api-key header and dimensions in the body
 *   - URL synthesis: plain resource base vs full URL pass-through
 *   - response parsing: data sorted by index defensively
 *   - failure mode: non-2xx surfaces upstream
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock the env module rather than poking process.env. env.ts loads .env
// with override:true in dev, which overwrites whatever we set on
// process.env at test setup time. Mocking sidesteps that race entirely
// and lets each test specify its own FOUNDRY_EMBED_* values.
let envOverrides: Record<string, unknown> = {};

vi.mock('../../src/config/env.js', () => ({
  env: () => envOverrides,
}));

const realFetch = global.fetch;
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  vi.resetModules();
  envOverrides = {
    FOUNDRY_EMBED_ENDPOINT: 'https://example.services.ai.azure.com',
    FOUNDRY_EMBED_API_KEY: 'test-key-1234567890',
    FOUNDRY_EMBED_MODEL: 'text-embedding-3-large-test',
    FOUNDRY_EMBED_DIM: 1024,
  };
});

afterEach(() => {
  global.fetch = realFetch;
});

function ok(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as unknown as Response;
}

describe('embedQuery — Foundry HTTP shape', () => {
  it('synthesises the embeddings URL from a plain resource base', async () => {
    fetchMock.mockResolvedValue(
      ok({
        data: [{ embedding: new Array(1024).fill(0.1), index: 0 }],
        model: 'text-embedding-3-large-test',
      }),
    );
    const { embedQuery } = await import('../../src/inference/embeddings/embedder.js');
    await embedQuery('white tshirt');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://example.services.ai.azure.com/openai/deployments/text-embedding-3-large-test/embeddings?api-version=2024-10-21',
    );
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['api-key']).toBe('test-key-1234567890');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(((init as RequestInit).body as string));
    expect(body).toEqual({ input: 'white tshirt', dimensions: 1024 });
  });

  it('passes through a fully-formed embeddings URL unchanged', async () => {
    envOverrides.FOUNDRY_EMBED_ENDPOINT =
      'https://example.services.ai.azure.com/openai/deployments/custom/embeddings?api-version=2024-10-21';
    fetchMock.mockResolvedValue(
      ok({ data: [{ embedding: new Array(1024).fill(0.1), index: 0 }], model: 'x' }),
    );
    const { embedQuery } = await import('../../src/inference/embeddings/embedder.js');
    await embedQuery('hi');
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://example.services.ai.azure.com/openai/deployments/custom/embeddings?api-version=2024-10-21',
    );
  });

  it('returns the embedding vector for the query', async () => {
    const v = new Array(1024).fill(0).map((_, i) => i / 1024);
    fetchMock.mockResolvedValue(ok({ data: [{ embedding: v, index: 0 }], model: 'x' }));
    const { embedQuery } = await import('../../src/inference/embeddings/embedder.js');
    const out = await embedQuery('shoes');
    expect(out).toEqual(v);
  });

  it('throws fail-fast on non-retryable 4xx with the upstream body excerpt', async () => {
    // 400 is non-retryable (auth/bad-request — retrying won't help). 429 / 5xx
    // go through the backoff path, covered separately below.
    fetchMock.mockImplementation(
      async () => new Response('bad input', { status: 400 }) as unknown as Response,
    );
    const { embedQuery } = await import('../../src/inference/embeddings/embedder.js');
    await expect(embedQuery('shoes')).rejects.toThrow(/Foundry embedding error 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
  });

  it('retries on 429 and succeeds when the rate limit clears', async () => {
    const v = new Array(1024).fill(0.1);
    fetchMock
      .mockResolvedValueOnce(
        new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': '0' },
        }) as unknown as Response,
      )
      .mockResolvedValueOnce(ok({ data: [{ embedding: v, index: 0 }], model: 'x' }));
    const { embedQuery } = await import('../../src/inference/embeddings/embedder.js');
    const out = await embedQuery('shoes');
    expect(out).toEqual(v);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('embedPassageBatch — batch behaviour', () => {
  it('returns one vector per input, sorted by index', async () => {
    // Foundry returns out-of-order on purpose to exercise the defensive sort.
    const v0 = new Array(1024).fill(0.0);
    const v1 = new Array(1024).fill(0.1);
    const v2 = new Array(1024).fill(0.2);
    fetchMock.mockResolvedValue(
      ok({
        data: [
          { embedding: v2, index: 2 },
          { embedding: v0, index: 0 },
          { embedding: v1, index: 1 },
        ],
        model: 'x',
      }),
    );
    const { embedPassageBatch } = await import(
      '../../src/inference/embeddings/embedder.js'
    );
    const out = await embedPassageBatch(['a', 'b', 'c']);
    expect(out).toEqual([v0, v1, v2]);
  });

  it('returns [] for an empty batch without hitting Foundry', async () => {
    const { embedPassageBatch } = await import(
      '../../src/inference/embeddings/embedder.js'
    );
    const out = await embedPassageBatch([]);
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
