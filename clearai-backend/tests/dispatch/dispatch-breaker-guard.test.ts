/**
 * Verifies dispatch.use-case refuses to start a classification when the
 * LLM circuit breaker is tripped, throwing LlmUnavailableError before
 * runPipeline is called.
 *
 * The batch runner's per-item catch swallows this into status='failed'
 * + error='llm_unavailable: ...'; the single-shot route translates it
 * into an HTTP 503. Both behaviors are covered by their own tests; this
 * file pins the chokepoint contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const runPipelineMock = vi.fn();
vi.mock('../../src/modules/pipeline/pipeline.orchestrator.js', () => ({
  runPipeline: (...args: unknown[]) => runPipelineMock(...args),
}));

vi.mock('../../src/modules/pipeline/trace/dispatch-v1.js', () => ({
  assembleDispatchV1: vi.fn(),
}));
vi.mock('../../src/modules/pipeline/events/recorder.js', () => ({
  recordClassificationEvent: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../src/modules/pipeline/hitl/hitl.js', () => ({
  enqueueHitl: vi.fn(),
}));

import {
  dispatch,
  LlmUnavailableError,
} from '../../src/modules/dispatch/dispatch.use-case.js';
import {
  recordLlmOutcome,
  __resetBreakerForTests,
} from '../../src/inference/llm/breaker.js';
import type { CanonicalLineItem } from '../../src/modules/operators/operator-config.types.js';
import type { LlmCallResult } from '../../src/inference/llm/client.js';

const item: CanonicalLineItem = {
  itemId: '019e10be-eb77-70c7-bd04-3ce85dd81d19',
  operatorSlug: 'naqel',
  operatorId: '4d6ef623-a02a-473b-9fbe-fe31747467ca',
  description: 'Wireless headphones with bluetooth',
  merchantHsCode: '851830000000',
  valueAmount: 150,
  currencyCode: 'SAR',
} as unknown as CanonicalLineItem;

function authFailure(): LlmCallResult {
  return {
    status: 'error',
    text: null,
    raw: null,
    error: 'HTTP 403: principal lacks required data action',
    latencyMs: 12,
    model: 'mock',
  } as LlmCallResult;
}

beforeEach(() => {
  __resetBreakerForTests();
  runPipelineMock.mockReset();
});

describe('dispatch — LLM circuit breaker guard', () => {
  it('runs runPipeline normally when breaker is healthy', async () => {
    runPipelineMock.mockResolvedValueOnce({
      final_code: '851830900003',
      goods_description_ar: 'سماعات',
      sanity_verdict: 'PASS',
      trace: { stages: [], track_a: null, track_b: null, verdict: null, sanity: null },
      hitl: null,
      infra_degraded: false,
    });

    await expect(dispatch(item)).resolves.toBeDefined();
    expect(runPipelineMock).toHaveBeenCalledOnce();
  });

  it('throws LlmUnavailableError when breaker is tripped — runPipeline is NOT called', async () => {
    // Simulate three consecutive auth failures to trip the breaker.
    recordLlmOutcome(authFailure());
    recordLlmOutcome(authFailure());
    recordLlmOutcome(authFailure());

    await expect(dispatch(item)).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(runPipelineMock).not.toHaveBeenCalled();
  });

  it('LlmUnavailableError carries diagnostic fields for the HTTP layer to surface', async () => {
    recordLlmOutcome(authFailure());
    recordLlmOutcome(authFailure());
    recordLlmOutcome(authFailure());

    try {
      await dispatch(item);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmUnavailableError);
      const e = err as LlmUnavailableError;
      expect(e.code).toBe('llm_unavailable');
      expect(e.trippedAtMs).toBeTypeOf('number');
      expect(e.lastError).toMatch(/HTTP 403/);
    }
  });

  it('a single transient (5xx) failure does NOT trip the guard', async () => {
    recordLlmOutcome({
      status: 'error',
      text: null,
      raw: null,
      error: 'HTTP 503: bad gateway',
      latencyMs: 12,
      model: 'mock',
    } as LlmCallResult);
    recordLlmOutcome({
      status: 'error',
      text: null,
      raw: null,
      error: 'HTTP 503: bad gateway',
      latencyMs: 12,
      model: 'mock',
    } as LlmCallResult);
    runPipelineMock.mockResolvedValueOnce({
      final_code: '851830900003',
      goods_description_ar: 'سماعات',
      sanity_verdict: 'PASS',
      trace: { stages: [], track_a: null, track_b: null, verdict: null, sanity: null },
      hitl: null,
      infra_degraded: false,
    });

    await expect(dispatch(item)).resolves.toBeDefined();
    expect(runPipelineMock).toHaveBeenCalledOnce();
  });
});
