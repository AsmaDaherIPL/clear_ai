/**
 * PR 11 — orchestrator end-to-end tests.
 *
 * All stage modules mocked at boundaries. Asserts the orchestrator's
 * branching logic (parallel branches, conditional web fallback,
 * scope-escalate short-circuit, verifier UNCERTAIN → HITL routing,
 * sanity FLAG → HITL routing, parse rejection → BLOCK).
 *
 * The 5 scenarios from the rewrite plan's acceptance criteria:
 *   1. Clean product, merchant agrees → accept (no web)
 *   2. Clean product, merchant disagrees → accept with audit flag
 *   3. Brand-only input → web fallback fires → accept
 *   4. Multi-product → escalate
 *   5. High-confidence picker, identify chapter disagrees → UNCERTAIN → FLAG
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Module mocks (each stage at its boundary)
const runIdentifyFastMock = vi.fn();
vi.mock('../../src/modules/pipeline/v2/identify/fast.js', () => ({
  runIdentifyFast: (...args: unknown[]) => runIdentifyFastMock(...args),
}));

const runIdentifyWebMock = vi.fn();
vi.mock('../../src/modules/pipeline/v2/identify/web.js', () => ({
  runIdentifyWeb: (...args: unknown[]) => runIdentifyWebMock(...args),
}));

const resolveMerchantMock = vi.fn();
vi.mock('../../src/modules/pipeline/merchant/resolve.js', () => ({
  resolveMerchant: (...args: unknown[]) => resolveMerchantMock(...args),
  buildResolutionTrace: () => ({
    llm_called: false,
    latency_ms: 5,
    override_attempted: false,
    override_matched: false,
  }),
  // 2026-05-19 (PR 2 / TASKS L4): retry the merchant LLM-pick once
  // real identify lands. The mock is a no-op pass-through: tests
  // already mock `resolveMerchantMock` to the desired terminal state,
  // so the retry should not transform it. If a test wants to assert
  // retry behaviour explicitly, override this mock locally.
  retryMerchantPickWithIdentify: async (first: unknown) => first,
}));

const runMultiArmRetrievalMock = vi.fn();
vi.mock('../../src/modules/pipeline/v2/retrieve/multi-arm.js', () => ({
  runMultiArmRetrieval: (...args: unknown[]) => runMultiArmRetrievalMock(...args),
}));

const runPickMock = vi.fn();
vi.mock('../../src/modules/pipeline/v2/pick/pick.js', () => ({
  runPick: (...args: unknown[]) => runPickMock(...args),
}));

const generateSubmissionMock = vi.fn();
vi.mock('../../src/modules/pipeline/submission-description/submission-description.js', () => ({
  generateSubmissionDescription: (...args: unknown[]) => generateSubmissionMock(...args),
}));

const runSanityMock = vi.fn();
vi.mock('../../src/modules/pipeline/sanity/sanity.js', () => ({
  runSanity: (...args: unknown[]) => runSanityMock(...args),
}));

const lookupCatalogMock = vi.fn();
vi.mock('../../src/modules/pipeline/catalog/catalog-context.js', () => ({
  lookupCatalogContext: (...args: unknown[]) => lookupCatalogMock(...args),
}));

const loadOperatorConfigMock = vi.fn();
vi.mock('../../src/modules/pipeline/catalog/operator-pipeline-config.js', () => ({
  loadOperatorPipelineConfig: (...args: unknown[]) => loadOperatorConfigMock(...args),
}));

// parseItem inline-mocked (canonical path — parse/parse.ts)
vi.mock('../../src/modules/pipeline/parse/parse.js', () => ({
  parseItem: (item: { description: string | null; merchantHsCode: string | null; valueAmount: number | null }) => {
    const desc = typeof item.description === 'string' ? item.description.trim() : null;
    if (!desc) return { rejected: true, reason: 'no_description' };
    const digits = item.merchantHsCode ? item.merchantHsCode.replace(/\D/g, '') : null;
    let state: 'twelve_digit' | 'short_prefix' | 'malformed' | 'absent' = 'absent';
    if (digits && digits.length === 12) state = 'twelve_digit';
    else if (digits && digits.length >= 6 && digits.length <= 11) state = 'short_prefix';
    else if (digits && digits.length > 0) state = 'malformed';
    return {
      rejected: false,
      item: {
        raw_description: desc,
        raw_merchant_code: digits || null,
        merchant_code_state: state,
        value_amount: item.valueAmount,
        currency_code: 'SAR',
        identifiers: [],
      },
    };
  },
}));

import { runPipeline as runPipelineV2 } from '../../src/modules/pipeline/orchestrator.js';
import type {
  CanonicalLineItem,
  IdentifyResult,
  PickResult,
  RerankedCandidate,
} from '../../src/modules/pipeline/types.js';

function item(overrides: Partial<CanonicalLineItem> = {}): CanonicalLineItem {
  return {
    itemId: '00000000-0000-0000-0000-000000000001',
    rowIndex: 1,
    operatorId: 'op-1',
    operatorSlug: 'naqel',
    description: 'cotton t-shirt',
    waybillNo: 'WB1',
    merchantHsCode: '610910000000',
    merchantSku: null,
    valueAmount: 100,
    currencyCode: 'SAR',
    quantity: 1,
    uom: 'PIECE',
    netWeightKg: 0.5,
    clientId: 'C1',
    countryOfOrigin: 'SA',
    destinationStationId: 'DST1',
    consigneeName: 'Test',
    consigneeNationalId: '0000',
    consigneePhone: '0000',
    consigneeAddress: null,
    invoiceDate: null,
    ...overrides,
  } as CanonicalLineItem;
}

function cleanIdentify(opts: { family?: string | null; confidence?: number; canonical?: string; tokens?: string[]; pass?: 'fast' | 'web' } = {}): IdentifyResult {
  return {
    kind: 'clean_product',
    canonical: opts.canonical ?? 'cotton t-shirt',
    family_chapter: 'family' in opts ? opts.family ?? null : '61',
    identity_tokens: opts.tokens ?? [],
    confidence: opts.confidence ?? 0.9,
    evidence: 'world_knowledge',
    trace: {
      pass: opts.pass ?? 'fast',
      llm_called: true,
      latency_ms: 2000,
      model: 'mock-sonnet',
      status: 'ok',
      web_search_used: false,
      evidence_mismatch: false,
    },
  };
}

function acceptedPick(code = '610910000000', overrides: Partial<Extract<PickResult, { kind: 'accepted' }>> = {}): PickResult {
  return {
    kind: 'accepted',
    final_code: code,
    fit: overrides.fit ?? 'fits',
    confidence: overrides.confidence ?? 0.85,
    gir_applied: overrides.gir_applied ?? 'GIR 1',
    verdict_population: overrides.verdict_population ?? { fits: 1, partial: 0, does_not_fit: 0 },
    picked_from_arm: overrides.picked_from_arm ?? 'merchant_prefix',
    merchant_chapter_disagreement: overrides.merchant_chapter_disagreement ?? false,
    candidate_count_by_arm: overrides.candidate_count_by_arm ?? { merchant_prefix: 1 },
    trace: overrides.trace ?? {
      llm_called: true,
      latency_ms: 5000,
      model: 'mock-sonnet',
      status: 'ok',
      candidate_count: 8,
      audit_flag: false,
    },
  };
}

function escalatePick(reason: Extract<PickResult, { kind: 'escalate' }>['reason']): PickResult {
  return {
    kind: 'escalate',
    reason,
    detail: `test ${reason}`,
    trace: {
      llm_called: false,
      latency_ms: 0,
      model: null,
      status: 'skipped',
      candidate_count: 0,
      audit_flag: false,
    },
  };
}

function rc(code: string): RerankedCandidate {
  return {
    code,
    description_en: `desc ${code}`,
    description_ar: null,
    path_en: '',
    path_ar: '',
    rrf_score: 0.5,
    bm25_score: null,
    vector_score: null,
    trigram_score: null,
    source_arm: 'merchant_prefix',
    rerank_score: 0.53,
    rerank_features: { rrf_score: 0.5, chapter_agreement: false, identity_token_overlap_count: 0, arm_boost: 0.03 },
  };
}

beforeEach(() => {
  runIdentifyFastMock.mockReset();
  runIdentifyWebMock.mockReset();
  resolveMerchantMock.mockReset();
  runMultiArmRetrievalMock.mockReset();
  runPickMock.mockReset();
  generateSubmissionMock.mockReset();
  runSanityMock.mockReset();
  lookupCatalogMock.mockReset();
  loadOperatorConfigMock.mockReset();
  // Default safe mocks
  loadOperatorConfigMock.mockResolvedValue({ overridesEnabled: true });
  lookupCatalogMock.mockResolvedValue({ leafAr: 'تيشيرت', leafEn: 'cotton t-shirt', pathAr: 'a > b', pathEn: 'a > b' });
  generateSubmissionMock.mockResolvedValue({ invoked: 'llm', descriptionAr: 'تيشيرت قطن', latencyMs: 50, attempts: 1 });
  runSanityMock.mockResolvedValue({ verdict: 'PASS', rationale: 'plausible', latency_ms: 80, attempts: 1, degraded: false });
});

describe('runPipelineV2 — scenario 1: clean product, merchant agrees → accept', () => {
  it('returns accepted with final_code, no audit, no HITL', async () => {
    runIdentifyFastMock.mockResolvedValueOnce(cleanIdentify({ family: '61' }));
    resolveMerchantMock.mockResolvedValueOnce({ state: 'active', resolved_code: '610910000000' });
    runMultiArmRetrievalMock.mockResolvedValueOnce({ candidates: [rc('610910000000')], per_arm_counts: { merchant_prefix: 1 } });
    runPickMock.mockResolvedValueOnce(acceptedPick('610910000000'));

    const r = await runPipelineV2(item(), 'naqel', 'i-1');
    expect(r.final_code).toBe('610910000000');
    expect(r.sanity_verdict).toBe('PASS');
    expect(r.classification_status).toBe('AGREEMENT');
    expect(r.hitl).toBeNull();
    expect(r.trace.verify?.result).toBe('PASS');
    // Web fallback should NOT have fired
    expect(runIdentifyWebMock).not.toHaveBeenCalled();
  });
});

describe('runPipelineV2 — scenario 2: clean product, merchant disagrees → audit flag', () => {
  it('picks from family_chapter arm with audit_flag and merchant_chapter_disagreement', async () => {
    runIdentifyFastMock.mockResolvedValueOnce(cleanIdentify({ family: '96', confidence: 0.9, canonical: 'disposable baby diapers' }));
    resolveMerchantMock.mockResolvedValueOnce({ state: 'active', resolved_code: '871500100000' }); // merchant=baby carriages
    runMultiArmRetrievalMock.mockResolvedValueOnce({
      candidates: [
        { ...rc('871500100000'), source_arm: 'merchant_prefix' },
        { ...rc('961900100000'), source_arm: 'family_chapter' },
      ],
      per_arm_counts: { merchant_prefix: 1, family_chapter: 1 },
    });
    runPickMock.mockResolvedValueOnce(
      acceptedPick('961900100000', {
        picked_from_arm: 'family_chapter',
        merchant_chapter_disagreement: true,
        trace: {
          llm_called: true,
          latency_ms: 5000,
          model: 'mock-sonnet',
          status: 'ok',
          candidate_count: 2,
          audit_flag: true,
        },
      }),
    );

    const r = await runPipelineV2(item({ description: 'pampers diapers', merchantHsCode: '871500100000' }), 'naqel', 'i-2');
    expect(r.final_code).toBe('961900100000');
    expect(r.hitl).toBeNull();
    expect(r.trace.pick.kind).toBe('accepted');
    if (r.trace.pick.kind === 'accepted') {
      expect(r.trace.pick.merchant_chapter_disagreement).toBe(true);
      expect(r.trace.pick.trace.audit_flag).toBe(true);
    }
  });
});

describe('runPipelineV2 — scenario 3: brand-only → web fallback → accept', () => {
  it('fires identify_web when identify_fast returns uninformative+genuine, then accepts', async () => {
    runIdentifyFastMock.mockResolvedValueOnce({
      kind: 'uninformative',
      cause: 'genuine',
      reason: 'unrecognised brand',
      trace: {
        pass: 'fast',
        llm_called: true,
        latency_ms: 2500,
        model: 'mock-sonnet',
        status: 'ok',
        web_search_used: false,
        evidence_mismatch: false,
      },
    });
    runIdentifyWebMock.mockResolvedValueOnce(
      cleanIdentify({ family: '85', confidence: 0.82, canonical: 'interactive flat-panel display', tokens: ['maxhub'], pass: 'web' }),
    );
    resolveMerchantMock.mockResolvedValueOnce({ state: 'absent' });
    runMultiArmRetrievalMock.mockResolvedValueOnce({ candidates: [rc('852852000000')], per_arm_counts: { family_chapter: 1 } });
    runPickMock.mockResolvedValueOnce(acceptedPick('852852000000'));

    const r = await runPipelineV2(item({ description: 'maxhub', merchantHsCode: null }), 'naqel', 'i-3');
    expect(runIdentifyWebMock).toHaveBeenCalledTimes(1);
    expect(r.final_code).toBe('852852000000');
    expect(r.trace.identify.trace.pass).toBe('web');
  });

  it('also fires web fallback on multi_product (gives the web pass a chance to recover Arabic-tokenization edge cases)', async () => {
    runIdentifyFastMock.mockResolvedValueOnce({
      kind: 'multi_product',
      products: ['a', 'b'],
      trace: {
        pass: 'fast',
        llm_called: true,
        latency_ms: 2000,
        model: 'mock-sonnet',
        status: 'ok',
        web_search_used: false,
        evidence_mismatch: false,
      },
    });
    runIdentifyWebMock.mockResolvedValueOnce(cleanIdentify({ family: '85', pass: 'web' })); // web recovers as single
    resolveMerchantMock.mockResolvedValueOnce({ state: 'absent' });
    runMultiArmRetrievalMock.mockResolvedValueOnce({ candidates: [rc('852852000000')], per_arm_counts: { family_chapter: 1 } });
    runPickMock.mockResolvedValueOnce(acceptedPick('852852000000'));

    const r = await runPipelineV2(item({ description: 'compound desc', merchantHsCode: null }), 'naqel', 'i-3b');
    expect(runIdentifyWebMock).toHaveBeenCalledTimes(1);
    expect(r.final_code).toBe('852852000000');
  });
});

describe('runPipelineV2 — scenario 4: multi_product → scope escalate (truly degenerate)', () => {
  it('short-circuits to escalate when products[] is empty (degenerate model output)', async () => {
    // Truly degenerate: model claimed multi_product but emitted no
    // products. No signal at all → escalate. Realistic multi_product
    // lines with non-empty products take the unconstrained-rescue
    // path (covered in scope-select.test.ts + pick.test.ts) and do
    // call retrieval + picker.
    runIdentifyFastMock.mockResolvedValueOnce({
      kind: 'multi_product',
      products: [],
      trace: {
        pass: 'fast',
        llm_called: true,
        latency_ms: 2000,
        model: 'mock-sonnet',
        status: 'ok',
        web_search_used: false,
        evidence_mismatch: false,
      },
    });
    runIdentifyWebMock.mockResolvedValueOnce({
      kind: 'multi_product',
      products: [],
      trace: {
        pass: 'web',
        llm_called: true,
        latency_ms: 8000,
        model: 'mock-sonnet',
        status: 'ok',
        web_search_used: true,
        evidence_mismatch: false,
      },
    });
    resolveMerchantMock.mockResolvedValueOnce({ state: 'absent' });

    const r = await runPipelineV2(item({ description: 'shirt + bag', merchantHsCode: null }), 'naqel', 'i-4');
    expect(r.final_code).toBeNull();
    expect(r.classification_status).toBe('ZERO_SIGNAL');
    expect(r.hitl?.reason).toBe('verdict_escalate');
    expect(runMultiArmRetrievalMock).not.toHaveBeenCalled();
    expect(runPickMock).not.toHaveBeenCalled();
  });
});

describe('runPipelineV2 — scenario 5: verifier UNCERTAIN → FLAG via HITL', () => {
  it('routes to verifier_uncertain HITL when identify chapter disagrees with picked chapter at confidence >= 0.90', async () => {
    runIdentifyFastMock.mockResolvedValueOnce(cleanIdentify({ family: '85', confidence: 0.92 }));
    resolveMerchantMock.mockResolvedValueOnce({ state: 'active', resolved_code: '610910000000' }); // chapter 61
    runMultiArmRetrievalMock.mockResolvedValueOnce({
      candidates: [rc('610910000000')],
      per_arm_counts: { merchant_prefix: 1 },
    });
    // Picker chooses chapter-61 candidate even though identify says 85 (e.g. dedupe brought
    // only merchant candidates and picker took the best of what was offered)
    runPickMock.mockResolvedValueOnce(acceptedPick('610910000000', { picked_from_arm: 'merchant_prefix' }));

    const r = await runPipelineV2(item(), 'naqel', 'i-5');
    expect(r.final_code).toBe('610910000000');
    expect(r.trace.verify?.result).toBe('UNCERTAIN');
    expect(r.hitl?.reason).toBe('verifier_uncertain');
    expect(r.classification_status).toBe('DRIFT');
  });
});

describe('runPipelineV2 — parse rejection short-circuit', () => {
  it('returns no code, null sanity_verdict, and identify.cause=short_circuit when description is empty', async () => {
    const r = await runPipelineV2(item({ description: '' }), 'naqel', 'i-block');
    // sanity_verdict is null because sanity did not run (replaces the
    // legacy 'BLOCK' sanity value — see SanityVerdict type).
    expect(r.sanity_verdict).toBeNull();
    expect(r.final_code).toBeNull();
    expect(r.hitl).toBeNull();
    // The durable short-circuit marker lives on identify.cause and is
    // what downstream consumers (dispatch.use-case, dispatch-v1) read.
    expect(r.trace.identify.kind).toBe('uninformative');
    if (r.trace.identify.kind === 'uninformative') {
      expect(r.trace.identify.cause).toBe('short_circuit');
    }
    // None of the LLM stages should have been called.
    expect(runIdentifyFastMock).not.toHaveBeenCalled();
    expect(runPickMock).not.toHaveBeenCalled();
    expect(runSanityMock).not.toHaveBeenCalled();
  });
});

describe('runPipelineV2 — sanity FLAG → HITL', () => {
  it('routes to sanity_flag HITL when sanity returns FLAG', async () => {
    runIdentifyFastMock.mockResolvedValueOnce(cleanIdentify({ family: '85', canonical: 'gaming monitor' }));
    resolveMerchantMock.mockResolvedValueOnce({ state: 'active', resolved_code: '852852000000' });
    runMultiArmRetrievalMock.mockResolvedValueOnce({ candidates: [rc('852852000000')], per_arm_counts: { merchant_prefix: 1 } });
    runPickMock.mockResolvedValueOnce(acceptedPick('852852000000'));
    runSanityMock.mockResolvedValueOnce({ verdict: 'FLAG', rationale: 'value too low', latency_ms: 80, attempts: 1, degraded: false });

    const r = await runPipelineV2(item({ valueAmount: 5 }), 'naqel', 'i-flag');
    expect(r.final_code).toBe('852852000000');
    expect(r.sanity_verdict).toBe('FLAG');
    expect(r.hitl?.reason).toBe('sanity_flag');
  });
});

describe('runPipelineV2 — picker escalate → HITL verdict_escalate', () => {
  // 2026-05-19 (remediation plan §1.1.1): last_chance retry was DISABLED.
  // When the first picker pass returns no_candidate_fits we no longer
  // retry with `last_chance: true` (which would coerce a wrong pick at
  // confidence 0.40 and ship it as a real classification). Instead the
  // row falls through to buildHitl() as verdict_escalate.

  it('routes to verdict_escalate when picker returns no_candidate_fits — single pick call, no retry', async () => {
    runIdentifyFastMock.mockResolvedValueOnce(cleanIdentify());
    resolveMerchantMock.mockResolvedValueOnce({ state: 'active', resolved_code: '610910000000' });
    runMultiArmRetrievalMock.mockResolvedValueOnce({ candidates: [rc('610910000000')], per_arm_counts: { merchant_prefix: 1 } });
    runPickMock.mockResolvedValueOnce(escalatePick('no_candidate_fits'));

    const r = await runPipelineV2(item(), 'naqel', 'i-esc');
    expect(r.final_code).toBeNull();
    expect(r.classification_status).toBe('ZERO_SIGNAL');
    expect(r.hitl?.reason).toBe('verdict_escalate');
    expect(runSanityMock).not.toHaveBeenCalled();
    // ONE picker call — last_chance retry retired.
    expect(runPickMock).toHaveBeenCalledTimes(1);
    expect(runPickMock.mock.calls[0]![0].last_chance).toBeUndefined();
  });

  it('no_candidate_fits never produces an accepted row, regardless of candidate pool size', async () => {
    runIdentifyFastMock.mockResolvedValueOnce(cleanIdentify());
    resolveMerchantMock.mockResolvedValueOnce({ state: 'active', resolved_code: '610910000000' });
    runMultiArmRetrievalMock.mockResolvedValueOnce({ candidates: [rc('610910000000')], per_arm_counts: { merchant_prefix: 1 } });
    runPickMock.mockResolvedValueOnce(escalatePick('no_candidate_fits'));

    const r = await runPipelineV2(item(), 'naqel', 'i-no-rescue');
    // Previously the last_chance retry might have rescued this with a
    // partial pick at conf 0.40. Now it correctly escalates to HITL
    // with no code — the reviewer supplies the right code.
    expect(r.final_code).toBeNull();
    expect(r.hitl?.reason).toBe('verdict_escalate');
    expect(runPickMock).toHaveBeenCalledTimes(1);
  });

  it('routes to low_information when identify_no_query + identify uninformative+genuine', async () => {
    runIdentifyFastMock.mockResolvedValueOnce({
      kind: 'uninformative',
      cause: 'genuine',
      reason: 'placeholder',
      trace: {
        pass: 'fast',
        llm_called: true,
        latency_ms: 2000,
        model: 'mock-sonnet',
        status: 'ok',
        web_search_used: false,
        evidence_mismatch: false,
      },
    });
    runIdentifyWebMock.mockResolvedValueOnce({
      kind: 'uninformative',
      cause: 'genuine',
      reason: 'web also failed',
      trace: {
        pass: 'web',
        llm_called: true,
        latency_ms: 8000,
        model: 'mock-sonnet',
        status: 'ok',
        web_search_used: true,
        evidence_mismatch: false,
      },
    });
    resolveMerchantMock.mockResolvedValueOnce({ state: 'active', resolved_code: '640420000000' });
    runMultiArmRetrievalMock.mockResolvedValueOnce({ candidates: [rc('640420000000')], per_arm_counts: { merchant_prefix: 1 } });
    runPickMock.mockResolvedValueOnce(escalatePick('identify_no_query'));

    const r = await runPipelineV2(item({ description: 'parcel', merchantHsCode: '640420000000' }), 'naqel', 'i-low');
    expect(r.hitl?.reason).toBe('low_information');
  });
});
