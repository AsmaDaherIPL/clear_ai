/**
 * Verifies the cold-start race fix in embedder.ts: the in-flight init
 * Promise is cached, not just the resolved pipeline. Concurrent first-callers
 * must serialise onto the same single initialization.
 *
 * We mock @xenova/transformers so no actual ONNX model is loaded. The mock
 * counts how many times `pipeline()` was called.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const pipelineMock = vi.fn();

vi.mock('@xenova/transformers', () => ({
  pipeline: pipelineMock,
  env: { allowLocalModels: true, cacheDir: '' },
}));

beforeEach(() => {
  pipelineMock.mockReset();
  // Fresh module each test so the in-module `_pipePromise` cache is reset.
  vi.resetModules();
});

describe('getPipeline — cold-start race', () => {
  it('initializes exactly once under concurrent first-callers', async () => {
    let resolveInit: (val: unknown) => void = () => {};
    const initPromise = new Promise((res) => {
      resolveInit = res;
    });
    const fakePipe = vi.fn().mockResolvedValue({
      data: new Float32Array([1, 0, 0]),
      dims: [1, 3],
    });
    pipelineMock.mockImplementation(async () => {
      await initPromise;
      return fakePipe;
    });

    const { embedQuery } = await import('./embedder.js');

    // Fire 8 concurrent first-callers before init resolves.
    const inflight = Array.from({ length: 8 }, () => embedQuery('horse'));

    // Resolve the init exactly once.
    resolveInit(undefined);
    await Promise.all(inflight);

    // The race-fix invariant: pipeline() called exactly once despite 8 concurrent callers.
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    // And the cached pipe was reused for all 8 invocations.
    expect(fakePipe).toHaveBeenCalledTimes(8);
  });

  it('clears the cached promise on init failure so retry can succeed', async () => {
    pipelineMock
      .mockRejectedValueOnce(new Error('first-init-fails'))
      .mockResolvedValueOnce(
        vi.fn().mockResolvedValue({ data: new Float32Array([1, 0, 0]), dims: [1, 3] })
      );

    const { embedQuery } = await import('./embedder.js');

    await expect(embedQuery('x')).rejects.toThrow(/first-init-fails/);
    // Second call must trigger a fresh init, not re-throw the cached rejection.
    await expect(embedQuery('y')).resolves.toBeDefined();
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });
});
