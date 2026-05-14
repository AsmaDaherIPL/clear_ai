/**
 * PR-A-4 — Pick stage.
 *
 * Tests runPick against mocked retrieval + LLM. The contract:
 *
 *   input:  PickInput (identify + constrain output)
 *   output: PickResult (accepted final_code OR escalate with reason)
 *   engine: retrieval call under scope's prefix filter + one picker
 *           LLM call with simplified 3-value fit verdict
 *
 * Tests cover:
 *  - scope.kind=escalate short-circuits, no LLM call
 *  - scope.kind=merchant_prefix passes prefix to retrieval
 *  - scope.kind=family_chapter passes chapter as prefix
 *  - scope.kind=unconstrained calls retrieval with no prefix
 *  - LLM returns fits → accepted with fit='fits'
 *  - LLM returns partial only → accepted with fit='partial'
 *  - LLM returns all does_not_fit → escalate no_candidate_fits
 *  - LLM transport failure → escalate picker_unavailable
 *  - LLM parse failure → escalate picker_unavailable
 *  - Retrieval returns 0 candidates → escalate no_candidates
 *  - scope.audit_flag propagates into trace.audit_flag
 *  - trace populated on every path (llm_called, status, latency, candidate_count, model)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/inference/llm/client.js', () => ({
  callLlmWithRetry: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('mock-pick-prompt'),
}));

vi.mock('../../src/config/env.js', () => ({
  env: () => ({
    PIPELINE_ARCHITECTURE: 'legacy' as const,
    LLM_MODEL: 'mock-haiku',
    LLM_MODEL_STRONG: 'mock-sonnet',
  }),
}));

const retrieveMock = vi.fn();
vi.mock('../../src/inference/retrieval/retrieve.js', () => ({
  retrieveCandidates: (...args: unknown[]) => retrieveMock(...args),
}));

import { runPick } from '../../src/modules/pipeline/pick/pick.js';
import { callLlmWithRetry } from '../../src/inference/llm/client.js';
import type { IdentifyResult, IdentifyCallTrace } from '../../src/modules/pipeline/identify/identify.types.js';
import type { ConstrainResult, RetrievalScope } from '../../src/modules/pipeline/constrain/constrain.types.js';

const mockedLlm = vi.mocked(callLlmWithRetry);

function identifyTrace(): IdentifyCallTrace {
  return {
    llm_called: true,
    latency_ms: 100,
    model: 'mock-sonnet',
    status: 'ok',
    web_search_used: false,
    evidence_mismatch: false,
  };
}

function clean(canonical = 'cotton t-shirt'): IdentifyResult {
  return {
    kind: 'clean_product',
    canonical,
    family_chapter: '61',
    identity_tokens: [],
    confidence: 0.9,
    evidence: 'world_knowledge',
    trace: identifyTrace(),
  };
}

function constrainWithScope(scope: RetrievalScope): ConstrainResult {
  return {
    resolution: { state: 'absent' },
    scope,
    trace: {
      llm_called: false,
      latency_ms: 5,
      override_attempted: false,
      override_matched: false,
    },
  };
}

function candidate(code: string, descEn = 'desc') {
  return {
    code,
    description_en: descEn,
    description_ar: null,
    parent10: code.slice(0, 10),
    path_en: descEn,
    path_ar: null,
    path_codes: [code.slice(0, 2), code.slice(0, 4), code.slice(0, 6), code],
    vec_rank: 1,
    bm25_rank: 1,
    trgm_rank: null,
    vec_score: 0.9,
    bm25_score: 0.8,
    trgm_score: null,
    rrf_score: 0.04,
  };
}

function llmOk(verdicts: Array<{ code: string; fit: string; rationale?: string }>) {
  return {
    status: 'ok' as const,
    text: JSON.stringify({
      verdicts: verdicts.map((v) => ({ code: v.code, fit: v.fit, rationale: v.rationale ?? '' })),
      missing_attributes: [],
    }),
    raw: {},
    latencyMs: 150,
    model: 'mock-sonnet',
  };
}

beforeEach(() => {
  retrieveMock.mockReset();
  mockedLlm.mockReset();
});

// ───────────────────────────────────────────────────────────────────────
// Scope=escalate short-circuits
// ───────────────────────────────────────────────────────────────────────

describe('runPick — scope.kind=escalate short-circuits', () => {
  it('multi_product escalate → no retrieval, no LLM call, reason=scope_escalate', async () => {
    const r = await runPick({
      identify: clean(),
      constrain: constrainWithScope({ kind: 'escalate', reason: 'identify_multi_product' }),
    });
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') {
      expect(r.reason).toBe('scope_escalate');
      expect(r.detail).toMatch(/multi_product/i);
    }
    expect(retrieveMock).not.toHaveBeenCalled();
    expect(mockedLlm).not.toHaveBeenCalled();
    expect(r.trace.llm_called).toBe(false);
    expect(r.trace.status).toBe('skipped');
    expect(r.trace.candidate_count).toBe(0);
  });

  it('identify_uninformative_no_merchant escalate → no LLM call', async () => {
    const r = await runPick({
      identify: { kind: 'uninformative', reason: 'unknown', cause: 'genuine', trace: identifyTrace() },
      constrain: constrainWithScope({ kind: 'escalate', reason: 'identify_uninformative_no_merchant' }),
    });
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') expect(r.reason).toBe('scope_escalate');
    expect(mockedLlm).not.toHaveBeenCalled();
  });

  it('merchant_malformed_no_family escalate → no LLM call', async () => {
    const r = await runPick({
      identify: { kind: 'uninformative', reason: 'x', cause: 'genuine', trace: identifyTrace() },
      constrain: constrainWithScope({ kind: 'escalate', reason: 'merchant_malformed_no_family' }),
    });
    expect(r.kind).toBe('escalate');
    expect(retrieveMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Scope-driven retrieval — correct prefix passed to retrieve
// ───────────────────────────────────────────────────────────────────────

describe('runPick — scope-driven retrieval', () => {
  it('merchant_prefix scope passes prefix as prefixFilter to retrieveCandidates', async () => {
    retrieveMock.mockResolvedValueOnce([candidate('640420000000', 'footwear')]);
    mockedLlm.mockResolvedValueOnce(llmOk([{ code: '640420000000', fit: 'fits' }]));
    const r = await runPick({
      identify: clean(),
      constrain: constrainWithScope({
        kind: 'merchant_prefix',
        prefix: '640420',
        source: 'merchant_active',
        audit_flag: false,
      }),
    });
    expect(retrieveMock).toHaveBeenCalledTimes(1);
    const callArgs = retrieveMock.mock.calls[0];
    // First arg is the query string, second is opts
    const opts = callArgs[1];
    expect(opts.prefixFilter).toBe('640420');
    expect(r.kind).toBe('accepted');
  });

  it('family_chapter scope passes chapter as prefixFilter', async () => {
    retrieveMock.mockResolvedValueOnce([candidate('852852000000', 'monitors')]);
    mockedLlm.mockResolvedValueOnce(llmOk([{ code: '852852000000', fit: 'fits' }]));
    await runPick({
      identify: clean(),
      constrain: constrainWithScope({
        kind: 'family_chapter',
        chapter: '85',
        source: 'identify',
        audit_flag: false,
      }),
    });
    expect(retrieveMock).toHaveBeenCalledTimes(1);
    const opts = retrieveMock.mock.calls[0][1];
    expect(opts.prefixFilter).toBe('85');
  });

  it('unconstrained scope calls retrieve with NO prefixFilter', async () => {
    retrieveMock.mockResolvedValueOnce([candidate('950330000000', 'lego')]);
    mockedLlm.mockResolvedValueOnce(llmOk([{ code: '950330000000', fit: 'fits' }]));
    await runPick({
      identify: clean(),
      constrain: constrainWithScope({ kind: 'unconstrained', reason: 'no_merchant_low_confidence_identify' }),
    });
    expect(retrieveMock).toHaveBeenCalledTimes(1);
    const opts = retrieveMock.mock.calls[0][1];
    expect(opts.prefixFilter).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Query built from identify.canonical + identity_tokens
// ───────────────────────────────────────────────────────────────────────

describe('runPick — retrieval query', () => {
  it('query for clean_product uses canonical + identity_tokens', async () => {
    retrieveMock.mockResolvedValueOnce([candidate('640420000000')]);
    mockedLlm.mockResolvedValueOnce(llmOk([{ code: '640420000000', fit: 'fits' }]));
    await runPick({
      identify: {
        kind: 'clean_product',
        canonical: 'leather sandal',
        family_chapter: '64',
        identity_tokens: ['birkenstock', 'arizona'],
        confidence: 0.9,
        evidence: 'web',
        trace: identifyTrace(),
      },
      constrain: constrainWithScope({
        kind: 'merchant_prefix',
        prefix: '640420',
        source: 'merchant_active',
        audit_flag: false,
      }),
    });
    const query = retrieveMock.mock.calls[0][0] as string;
    expect(query).toContain('leather sandal');
    expect(query).toContain('birkenstock');
    expect(query).toContain('arizona');
  });

  it('uninformative identify + scope=merchant_prefix → identify_no_query escalate, NO retrieval, NO LLM call', async () => {
    // PR-A-4 design: empty-query LLM picks waste budget and produce
    // unauditable guesses. Match the resolve-merchant.ts short-circuit
    // pattern from PR-A-3. The orchestrator (PR-A-5) is expected to
    // route this row to HITL with a clear reason rather than ship a
    // guess against the merchant prefix alone.
    const r = await runPick({
      identify: { kind: 'uninformative', reason: 'unknown', cause: 'genuine', trace: identifyTrace() },
      constrain: constrainWithScope({
        kind: 'merchant_prefix',
        prefix: '640420',
        source: 'merchant_active',
        audit_flag: false,
      }),
    });
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') {
      expect(r.reason).toBe('identify_no_query');
      expect(r.detail).toMatch(/uninformative/i);
    }
    expect(retrieveMock).not.toHaveBeenCalled();
    expect(mockedLlm).not.toHaveBeenCalled();
  });

  it('multi_product identify + scope=merchant_prefix → identify_no_query escalate (covers the multi_product short-circuit on anchorable scope)', async () => {
    // multi_product on its own would normally produce scope=escalate
    // from constrain, but the contract permits a multi_product identify
    // paired with a merchant_prefix scope (degenerate but typeable).
    // Pick must refuse to fire the LLM with no description signal.
    const r = await runPick({
      identify: { kind: 'multi_product', products: ['a', 'b'], trace: identifyTrace() },
      constrain: constrainWithScope({
        kind: 'merchant_prefix',
        prefix: '640420',
        source: 'merchant_active',
        audit_flag: false,
      }),
    });
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') {
      expect(r.reason).toBe('identify_no_query');
    }
    expect(mockedLlm).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Happy path — accepted variants
// ───────────────────────────────────────────────────────────────────────

describe('runPick — accepted', () => {
  it('LLM returns fits → accepted with fit=fits', async () => {
    retrieveMock.mockResolvedValueOnce([candidate('640420000000', 'footwear')]);
    mockedLlm.mockResolvedValueOnce(llmOk([{ code: '640420000000', fit: 'fits', rationale: 'matches' }]));
    const r = await runPick({
      identify: clean(),
      constrain: constrainWithScope({
        kind: 'merchant_prefix',
        prefix: '640420',
        source: 'merchant_active',
        audit_flag: false,
      }),
    });
    expect(r.kind).toBe('accepted');
    if (r.kind === 'accepted') {
      expect(r.final_code).toBe('640420000000');
      expect(r.fit).toBe('fits');
      expect(r.confidence).toBeGreaterThan(0.5);
    }
  });

  it('LLM returns only partial → accepted with fit=partial, lower confidence', async () => {
    retrieveMock.mockResolvedValueOnce([candidate('640420000000', 'footwear, of cotton')]);
    mockedLlm.mockResolvedValueOnce(llmOk([{ code: '640420000000', fit: 'partial', rationale: 'cotton silent' }]));
    const r = await runPick({
      identify: clean(),
      constrain: constrainWithScope({
        kind: 'merchant_prefix',
        prefix: '640420',
        source: 'merchant_active',
        audit_flag: false,
      }),
    });
    expect(r.kind).toBe('accepted');
    if (r.kind === 'accepted') {
      expect(r.final_code).toBe('640420000000');
      expect(r.fit).toBe('partial');
      expect(r.confidence).toBeLessThan(0.9);
    }
  });

  it('LLM returns multiple verdicts → picks top fits over partial', async () => {
    retrieveMock.mockResolvedValueOnce([
      candidate('640420100000', 'partial fit'),
      candidate('640420200000', 'full fit'),
    ]);
    mockedLlm.mockResolvedValueOnce(
      llmOk([
        { code: '640420100000', fit: 'partial' },
        { code: '640420200000', fit: 'fits' },
      ]),
    );
    const r = await runPick({
      identify: clean(),
      constrain: constrainWithScope({
        kind: 'merchant_prefix',
        prefix: '640420',
        source: 'merchant_active',
        audit_flag: false,
      }),
    });
    expect(r.kind).toBe('accepted');
    if (r.kind === 'accepted') {
      expect(r.final_code).toBe('640420200000');
      expect(r.fit).toBe('fits');
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// Escalation paths from retrieval / LLM failures
// ───────────────────────────────────────────────────────────────────────

describe('runPick — escalation paths', () => {
  it('retrieval returns 0 candidates → escalate no_candidates, no LLM call', async () => {
    retrieveMock.mockResolvedValueOnce([]);
    const r = await runPick({
      identify: clean(),
      constrain: constrainWithScope({
        kind: 'merchant_prefix',
        prefix: '999999',
        source: 'merchant_active',
        audit_flag: false,
      }),
    });
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') expect(r.reason).toBe('no_candidates');
    expect(mockedLlm).not.toHaveBeenCalled();
  });

  it('LLM returns all does_not_fit → escalate no_candidate_fits', async () => {
    retrieveMock.mockResolvedValueOnce([
      candidate('640420100000'),
      candidate('640420200000'),
    ]);
    mockedLlm.mockResolvedValueOnce(
      llmOk([
        { code: '640420100000', fit: 'does_not_fit' },
        { code: '640420200000', fit: 'does_not_fit' },
      ]),
    );
    const r = await runPick({
      identify: clean(),
      constrain: constrainWithScope({
        kind: 'merchant_prefix',
        prefix: '640420',
        source: 'merchant_active',
        audit_flag: false,
      }),
    });
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') expect(r.reason).toBe('no_candidate_fits');
  });

  it('LLM transport error → escalate picker_unavailable', async () => {
    retrieveMock.mockResolvedValueOnce([candidate('640420000000')]);
    mockedLlm.mockResolvedValueOnce({
      status: 'error' as const,
      text: null,
      raw: {},
      latencyMs: 5000,
      model: 'mock-sonnet',
      error: '502',
    });
    const r = await runPick({
      identify: clean(),
      constrain: constrainWithScope({
        kind: 'merchant_prefix',
        prefix: '640420',
        source: 'merchant_active',
        audit_flag: false,
      }),
    });
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') expect(r.reason).toBe('picker_unavailable');
    expect(r.trace.status).toBe('error');
  });

  it('LLM parse failure (all 3 attempts) → escalate picker_unavailable', async () => {
    retrieveMock.mockResolvedValueOnce([candidate('640420000000')]);
    // Parse-retry loop attempts 3 times; mock all 3 as unparseable.
    mockedLlm
      .mockResolvedValueOnce({ status: 'ok' as const, text: 'not json', raw: {}, latencyMs: 200, model: 'mock-sonnet' })
      .mockResolvedValueOnce({ status: 'ok' as const, text: 'still not json', raw: {}, latencyMs: 200, model: 'mock-sonnet' })
      .mockResolvedValueOnce({ status: 'ok' as const, text: 'nope', raw: {}, latencyMs: 200, model: 'mock-sonnet' });
    const r = await runPick({
      identify: clean(),
      constrain: constrainWithScope({
        kind: 'merchant_prefix',
        prefix: '640420',
        source: 'merchant_active',
        audit_flag: false,
      }),
    });
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') expect(r.reason).toBe('picker_unavailable');
    expect(r.trace.status).toBe('parse');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Audit flag propagation
// ───────────────────────────────────────────────────────────────────────

describe('runPick — audit_flag propagation', () => {
  it('scope.audit_flag=true propagates into trace.audit_flag', async () => {
    retrieveMock.mockResolvedValueOnce([candidate('640420000000')]);
    mockedLlm.mockResolvedValueOnce(llmOk([{ code: '640420000000', fit: 'fits' }]));
    const r = await runPick({
      identify: clean(),
      constrain: constrainWithScope({
        kind: 'merchant_prefix',
        prefix: '640420',
        source: 'merchant_replacement_picked',
        audit_flag: true,
      }),
    });
    expect(r.trace.audit_flag).toBe(true);
  });

  it('scope.audit_flag=false → trace.audit_flag=false', async () => {
    retrieveMock.mockResolvedValueOnce([candidate('640420000000')]);
    mockedLlm.mockResolvedValueOnce(llmOk([{ code: '640420000000', fit: 'fits' }]));
    const r = await runPick({
      identify: clean(),
      constrain: constrainWithScope({
        kind: 'merchant_prefix',
        prefix: '640420',
        source: 'merchant_active',
        audit_flag: false,
      }),
    });
    expect(r.trace.audit_flag).toBe(false);
  });

  it('scope.audit_flag=true on family_chapter override → propagates to trace', async () => {
    retrieveMock.mockResolvedValueOnce([candidate('852850000000')]);
    mockedLlm.mockResolvedValueOnce(llmOk([{ code: '852850000000', fit: 'fits' }]));
    const r = await runPick({
      identify: clean(),
      constrain: constrainWithScope({
        kind: 'family_chapter',
        chapter: '85',
        source: 'identify',
        audit_flag: true,
      }),
    });
    expect(r.trace.audit_flag).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Trace shape
// ───────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────
// Verdict coercion safety nets
// ───────────────────────────────────────────────────────────────────────

describe('runPick — verdict coercion', () => {
  it('silently drops verdicts whose code is not in the candidate set', async () => {
    retrieveMock.mockResolvedValueOnce([candidate('640420000000', 'real')]);
    mockedLlm.mockResolvedValueOnce(
      llmOk([
        { code: '640420000000', fit: 'fits', rationale: 'real one' },
        { code: '999999999999', fit: 'fits', rationale: 'hallucinated' },
      ]),
    );
    const r = await runPick({
      identify: clean(),
      constrain: constrainWithScope({
        kind: 'merchant_prefix',
        prefix: '640420',
        source: 'merchant_active',
        audit_flag: false,
      }),
    });
    expect(r.kind).toBe('accepted');
    if (r.kind === 'accepted') {
      expect(r.final_code).toBe('640420000000');
      // Only one verdict survived coercion; hallucinated code dropped.
      expect(r.verdict_population.fits).toBe(1);
    }
  });

  it('drops verdicts whose fit is an unrecognised string', async () => {
    retrieveMock.mockResolvedValueOnce([
      candidate('640420100000', 'a'),
      candidate('640420200000', 'b'),
    ]);
    mockedLlm.mockResolvedValueOnce(
      llmOk([
        { code: '640420100000', fit: 'maybe', rationale: 'invalid fit' },
        { code: '640420200000', fit: 'fits', rationale: 'good' },
      ]),
    );
    const r = await runPick({
      identify: clean(),
      constrain: constrainWithScope({
        kind: 'merchant_prefix',
        prefix: '640420',
        source: 'merchant_active',
        audit_flag: false,
      }),
    });
    expect(r.kind).toBe('accepted');
    if (r.kind === 'accepted') {
      expect(r.final_code).toBe('640420200000');
      expect(r.verdict_population.fits).toBe(1);
      // The 'maybe' verdict was dropped entirely (not counted as
      // does_not_fit, partial, or fits).
      expect(r.verdict_population.does_not_fit).toBe(0);
      expect(r.verdict_population.partial).toBe(0);
    }
  });

  it('verdict_population tallies all valid verdicts (fits + partial + does_not_fit)', async () => {
    retrieveMock.mockResolvedValueOnce([
      candidate('640420100000'),
      candidate('640420200000'),
      candidate('640420300000'),
      candidate('640420400000'),
    ]);
    mockedLlm.mockResolvedValueOnce(
      llmOk([
        { code: '640420100000', fit: 'fits' },
        { code: '640420200000', fit: 'partial' },
        { code: '640420300000', fit: 'does_not_fit' },
        { code: '640420400000', fit: 'does_not_fit' },
      ]),
    );
    const r = await runPick({
      identify: clean(),
      constrain: constrainWithScope({
        kind: 'merchant_prefix',
        prefix: '640420',
        source: 'merchant_active',
        audit_flag: false,
      }),
    });
    expect(r.kind).toBe('accepted');
    if (r.kind === 'accepted') {
      expect(r.verdict_population).toEqual({ fits: 1, partial: 1, does_not_fit: 2 });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// GIR extraction from rationale
// ───────────────────────────────────────────────────────────────────────

describe('runPick — GIR extraction', () => {
  async function callWithRationale(rationale: string) {
    retrieveMock.mockResolvedValueOnce([candidate('640420000000')]);
    mockedLlm.mockResolvedValueOnce(llmOk([{ code: '640420000000', fit: 'fits', rationale }]));
    return runPick({
      identify: clean(),
      constrain: constrainWithScope({
        kind: 'merchant_prefix',
        prefix: '640420',
        source: 'merchant_active',
        audit_flag: false,
      }),
    });
  }

  it('extracts "GIR 3(a)" from rationale', async () => {
    const r = await callWithRationale('Most specific description per GIR 3(a)');
    if (r.kind === 'accepted') expect(r.gir_applied).toBe('GIR 3(a)');
  });

  it('extracts "GIR 1" (no letter) from rationale', async () => {
    const r = await callWithRationale('Heading wording binds (GIR 1)');
    if (r.kind === 'accepted') expect(r.gir_applied).toBe('GIR 1');
  });

  it('extracts "GIR 2(b)" with lowercase letter', async () => {
    const r = await callWithRationale('per gir 2(B), material variant rules');
    if (r.kind === 'accepted') expect(r.gir_applied).toBe('GIR 2(b)');
  });

  it('returns empty string when no GIR is cited', async () => {
    const r = await callWithRationale('Matches the leaf cleanly with no ambiguity');
    if (r.kind === 'accepted') expect(r.gir_applied).toBe('');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Timeout status mapping
// ───────────────────────────────────────────────────────────────────────

describe('runPick — timeout', () => {
  it('LLM timeout → escalate picker_unavailable with trace.status=timeout', async () => {
    retrieveMock.mockResolvedValueOnce([candidate('640420000000')]);
    mockedLlm.mockResolvedValueOnce({
      status: 'timeout' as const,
      text: null,
      raw: {},
      latencyMs: 10000,
      model: 'mock-sonnet',
      error: 'timeout',
    });
    const r = await runPick({
      identify: clean(),
      constrain: constrainWithScope({
        kind: 'merchant_prefix',
        prefix: '640420',
        source: 'merchant_active',
        audit_flag: false,
      }),
    });
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') {
      expect(r.reason).toBe('picker_unavailable');
    }
    expect(r.trace.status).toBe('timeout');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Parse retry behaviour
// ───────────────────────────────────────────────────────────────────────

describe('runPick — parse retry', () => {
  it('retries on parse failure and accepts on second attempt', async () => {
    retrieveMock.mockResolvedValueOnce([candidate('640420000000')]);
    // First attempt returns unparseable; second returns valid JSON.
    mockedLlm
      .mockResolvedValueOnce({
        status: 'ok' as const,
        text: 'not json {{{',
        raw: {},
        latencyMs: 100,
        model: 'mock-sonnet',
      })
      .mockResolvedValueOnce(llmOk([{ code: '640420000000', fit: 'fits' }]));
    const r = await runPick({
      identify: clean(),
      constrain: constrainWithScope({
        kind: 'merchant_prefix',
        prefix: '640420',
        source: 'merchant_active',
        audit_flag: false,
      }),
    });
    expect(r.kind).toBe('accepted');
    expect(mockedLlm).toHaveBeenCalledTimes(2);
  });

  it('exhausts parse retries (3 total attempts) and escalates with trace.status=parse', async () => {
    retrieveMock.mockResolvedValueOnce([candidate('640420000000')]);
    mockedLlm
      .mockResolvedValueOnce({ status: 'ok' as const, text: 'a', raw: {}, latencyMs: 100, model: 'mock-sonnet' })
      .mockResolvedValueOnce({ status: 'ok' as const, text: 'b', raw: {}, latencyMs: 100, model: 'mock-sonnet' })
      .mockResolvedValueOnce({ status: 'ok' as const, text: 'c', raw: {}, latencyMs: 100, model: 'mock-sonnet' });
    const r = await runPick({
      identify: clean(),
      constrain: constrainWithScope({
        kind: 'merchant_prefix',
        prefix: '640420',
        source: 'merchant_active',
        audit_flag: false,
      }),
    });
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') {
      expect(r.reason).toBe('picker_unavailable');
      expect(r.detail).toMatch(/unparseable/i);
    }
    expect(r.trace.status).toBe('parse');
    expect(mockedLlm).toHaveBeenCalledTimes(3);
  });
});

describe('runPick — trace shape', () => {
  it('happy path trace: llm_called=true, status=ok, candidate_count=N, model populated', async () => {
    retrieveMock.mockResolvedValueOnce([candidate('640420000000'), candidate('640420100000')]);
    mockedLlm.mockResolvedValueOnce(llmOk([{ code: '640420000000', fit: 'fits' }]));
    const r = await runPick({
      identify: clean(),
      constrain: constrainWithScope({
        kind: 'merchant_prefix',
        prefix: '640420',
        source: 'merchant_active',
        audit_flag: false,
      }),
    });
    expect(r.trace.llm_called).toBe(true);
    expect(r.trace.status).toBe('ok');
    expect(r.trace.candidate_count).toBe(2);
    expect(r.trace.model).toBe('mock-sonnet');
    expect(r.trace.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('scope escalate trace: llm_called=false, status=skipped, candidate_count=0', async () => {
    const r = await runPick({
      identify: clean(),
      constrain: constrainWithScope({ kind: 'escalate', reason: 'identify_multi_product' }),
    });
    expect(r.trace.llm_called).toBe(false);
    expect(r.trace.status).toBe('skipped');
    expect(r.trace.candidate_count).toBe(0);
    expect(r.trace.model).toBeNull();
  });
});
