/**
 * PR-A-5 — Anchored orchestrator end-to-end.
 *
 * Wires identify → constrain → pick → submission_description → sanity
 * into a PipelineResult. These tests mock each stage at the module
 * boundary (no real LLM / DB) and assert:
 *
 *   - Stage call ordering and argument plumbing
 *   - PipelineResult contract matches what legacy emits
 *   - Trace shape: pipeline_architecture='anchored', anchored_* fields
 *     populated, legacy track_a/track_b/verdict null
 *   - HITL intent routing across escalate / sanity-flag paths
 *   - infra_degraded propagation from identify transport failures
 *   - Identity tokens flow from identify into submission
 *   - The four production failure cases (maxhub, TORY 45, GPU, Joolz)
 *     produce the expected anchored outcomes
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ───────────────────────────────────────────────────────────────────────
// Stage mocks (each anchored stage + submission + sanity + catalog)
// ───────────────────────────────────────────────────────────────────────

const runIdentifyMock = vi.fn();
vi.mock('../../src/modules/pipeline/identify/identify.js', () => ({
  runIdentify: (...args: unknown[]) => runIdentifyMock(...args),
}));

const runConstrainMock = vi.fn();
vi.mock('../../src/modules/pipeline/constrain/constrain.js', () => ({
  runConstrain: (...args: unknown[]) => runConstrainMock(...args),
}));

const runPickMock = vi.fn();
vi.mock('../../src/modules/pipeline/pick/pick.js', () => ({
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

// parseItem is deterministic but reads from the canonical item; mock
// it so tests don't depend on the canonical schema. Pass-through that
// returns a minimal accept shape with the description carried.
// merchant_code_state reflects the real MerchantCodeState union — see
// parse.ts:classifyMerchantCode. Tests pass through these values rather
// than invent a synthetic 'present' marker.
function classifyMerchantCodeForMock(raw: string | null): 'twelve_digit' | 'short_prefix' | 'malformed' | 'absent' {
  if (!raw || raw.trim() === '') return 'absent';
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 12) return 'twelve_digit';
  if (digits.length >= 6 && digits.length <= 11) return 'short_prefix';
  return 'malformed';
}
vi.mock('../../src/modules/pipeline/parse/parse.js', () => ({
  parseItem: (item: { description: string | null; merchantHsCode: string | null; valueAmount: number | null }) => {
    // Mirror parse.ts: reject when description is empty/whitespace.
    const desc = typeof item.description === 'string' ? item.description.trim() : null;
    if (!desc) {
      return { rejected: true, reason: 'no_description' };
    }
    const digits = item.merchantHsCode ? item.merchantHsCode.replace(/\D/g, '') : null;
    return {
      rejected: false,
      item: {
        raw_description: desc,
        raw_merchant_code: digits || null,
        merchant_code_state: classifyMerchantCodeForMock(item.merchantHsCode),
        value_amount: item.valueAmount,
        currency_code: 'SAR',
        identifiers: [],
      },
    };
  },
}));

vi.mock('../../src/config/env.js', () => ({
  env: () => ({
    PIPELINE_ARCHITECTURE: 'anchored' as const,
    LLM_MODEL: 'mock-haiku',
    LLM_MODEL_STRONG: 'mock-sonnet',
  }),
}));

import { runAnchoredPipeline } from '../../src/modules/pipeline/anchored-orchestrator.js';
import type { CanonicalLineItem } from '../../src/modules/operators/operator-config.types.js';
import type {
  IdentifyResult,
  IdentifyCallTrace,
} from '../../src/modules/pipeline/identify/identify.types.js';
import type {
  ConstrainResult,
  RetrievalScope,
  MerchantResolution,
} from '../../src/modules/pipeline/constrain/constrain.types.js';
import type { PickResult, PickCallTrace } from '../../src/modules/pipeline/pick/pick.types.js';

// ───────────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────────

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

function pickTrace(): PickCallTrace {
  return {
    llm_called: true,
    latency_ms: 150,
    candidate_count: 12,
    status: 'ok',
    model: 'mock-sonnet',
    audit_flag: false,
  };
}

function cleanIdentify(opts: { canonical?: string; family_chapter?: string | null; confidence?: number; identity_tokens?: string[] } = {}): IdentifyResult {
  return {
    kind: 'clean_product',
    canonical: opts.canonical ?? 'cotton t-shirt',
    family_chapter: 'family_chapter' in opts ? opts.family_chapter! : '61',
    identity_tokens: opts.identity_tokens ?? [],
    confidence: opts.confidence ?? 0.9,
    evidence: 'world_knowledge',
    trace: identifyTrace(),
  };
}

function constrainResult(opts: {
  scopeKind?: 'merchant_prefix' | 'family_chapter' | 'unconstrained' | 'escalate';
  prefix?: string;
  audit_flag?: boolean;
  resolution?: MerchantResolution;
} = {}): ConstrainResult {
  const kind = opts.scopeKind ?? 'merchant_prefix';
  let scope: RetrievalScope;
  if (kind === 'merchant_prefix') {
    scope = {
      kind: 'merchant_prefix',
      prefix: opts.prefix ?? '610910',
      source: 'merchant_active',
      audit_flag: opts.audit_flag ?? false,
    };
  } else if (kind === 'family_chapter') {
    scope = {
      kind: 'family_chapter',
      chapter: opts.prefix ?? '61',
      source: 'identify',
      audit_flag: opts.audit_flag ?? false,
    };
  } else if (kind === 'unconstrained') {
    scope = { kind: 'unconstrained', reason: 'no_merchant_low_confidence_identify' };
  } else {
    scope = { kind: 'escalate', reason: 'identify_multi_product' };
  }
  return {
    resolution: opts.resolution ?? { state: 'active', resolved_code: '610910000000' },
    scope,
    trace: { llm_called: false, latency_ms: 5, override_attempted: false, override_matched: false },
  };
}

function acceptedPick(code = '610910000000', fit: 'fits' | 'partial' = 'fits'): PickResult {
  return {
    kind: 'accepted',
    final_code: code,
    confidence: fit === 'fits' ? 0.85 : 0.55,
    gir_applied: '',
    fit,
    verdict_population: { fits: fit === 'fits' ? 1 : 0, partial: fit === 'partial' ? 1 : 0, does_not_fit: 0 },
    trace: pickTrace(),
  };
}

function escalatePick(reason: 'scope_escalate' | 'no_candidates' | 'no_candidate_fits' | 'identify_no_query' | 'picker_unavailable' = 'no_candidate_fits'): PickResult {
  return {
    kind: 'escalate',
    reason,
    detail: `test ${reason}`,
    trace: { ...pickTrace(), llm_called: reason !== 'scope_escalate' && reason !== 'identify_no_query' && reason !== 'no_candidates' },
  };
}

function buildItem(overrides: Partial<CanonicalLineItem> = {}): CanonicalLineItem {
  return {
    itemId: '00000000-0000-0000-0000-000000000001',
    rowIndex: 1,
    operatorId: 'op-1',
    operatorSlug: 'naqel',
    description: 'wireless headphones',
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

beforeEach(() => {
  runIdentifyMock.mockReset();
  runConstrainMock.mockReset();
  runPickMock.mockReset();
  generateSubmissionMock.mockReset();
  runSanityMock.mockReset();
  lookupCatalogMock.mockReset();
  // Default safe mocks (each test overrides what it cares about).
  lookupCatalogMock.mockResolvedValue({
    leafAr: 'تيشيرت قطن', leafEn: 'cotton t-shirt', pathAr: 'a > b', pathEn: 'a > b',
  });
  generateSubmissionMock.mockResolvedValue({
    invoked: 'llm', descriptionAr: 'تيشيرت قطن للرجال', latencyMs: 50, attempts: 1, retried_reasons: [],
  });
  runSanityMock.mockResolvedValue({
    verdict: 'PASS', rationale: 'plausible', latency_ms: 80, model: 'mock-sonnet', attempts: 1, retried_reasons: [], degraded: false,
  });
  loadOperatorConfigMock.mockResolvedValue({ overridesEnabled: true });
});

// ───────────────────────────────────────────────────────────────────────
// Happy path
// ───────────────────────────────────────────────────────────────────────

describe('runAnchoredPipeline — happy path', () => {
  it('returns final_code from pick + sanity_verdict=PASS + hitl=null', async () => {
    runIdentifyMock.mockResolvedValueOnce(cleanIdentify());
    runConstrainMock.mockResolvedValueOnce(constrainResult());
    runPickMock.mockResolvedValueOnce(acceptedPick('610910000000', 'fits'));
    const r = await runAnchoredPipeline(buildItem(), 'naqel', 'item-1');
    expect(r.final_code).toBe('610910000000');
    expect(r.sanity_verdict).toBe('PASS');
    expect(r.hitl).toBeNull();
    expect(r.goods_description_ar).toBe('تيشيرت قطن للرجال');
    expect(r.infra_degraded).toBe(false);
  });

  it('trace.pipeline_architecture is "anchored"', async () => {
    runIdentifyMock.mockResolvedValueOnce(cleanIdentify());
    runConstrainMock.mockResolvedValueOnce(constrainResult());
    runPickMock.mockResolvedValueOnce(acceptedPick());
    const r = await runAnchoredPipeline(buildItem(), 'naqel', 'item-1');
    expect(r.trace.pipeline_architecture).toBe('anchored');
  });

  it('trace.anchored_* fields populated, legacy track_a/b/verdict null', async () => {
    const id = cleanIdentify();
    const cn = constrainResult();
    const pk = acceptedPick();
    runIdentifyMock.mockResolvedValueOnce(id);
    runConstrainMock.mockResolvedValueOnce(cn);
    runPickMock.mockResolvedValueOnce(pk);
    const r = await runAnchoredPipeline(buildItem(), 'naqel', 'item-1');
    expect(r.trace.anchored_identify).toBe(id);
    expect(r.trace.anchored_constrain).toBe(cn);
    expect(r.trace.anchored_pick).toBe(pk);
    expect(r.trace.track_a).toBeNull();
    expect(r.trace.track_b).toBeNull();
    expect(r.trace.verdict).toBeNull();
  });

  it('runs stages in order: identify → constrain → pick → submission → sanity', async () => {
    const callOrder: string[] = [];
    runIdentifyMock.mockImplementationOnce(async () => {
      callOrder.push('identify');
      return cleanIdentify();
    });
    runConstrainMock.mockImplementationOnce(async () => {
      callOrder.push('constrain');
      return constrainResult();
    });
    runPickMock.mockImplementationOnce(async () => {
      callOrder.push('pick');
      return acceptedPick();
    });
    generateSubmissionMock.mockImplementationOnce(async () => {
      callOrder.push('submission');
      return { invoked: 'llm', descriptionAr: 'x', latencyMs: 1, attempts: 1, retried_reasons: [] };
    });
    runSanityMock.mockImplementationOnce(async () => {
      callOrder.push('sanity');
      return { verdict: 'PASS', rationale: 'x', latency_ms: 1, model: 'm', attempts: 1, retried_reasons: [], degraded: false };
    });
    await runAnchoredPipeline(buildItem(), 'naqel', 'item-1');
    expect(callOrder).toEqual(['identify', 'constrain', 'pick', 'submission', 'sanity']);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Identity tokens flow into submission stage
// ───────────────────────────────────────────────────────────────────────

describe('runAnchoredPipeline — submission stage receives identity_tokens', () => {
  it('passes identify.identity_tokens to generateSubmissionDescription', async () => {
    runIdentifyMock.mockResolvedValueOnce(cleanIdentify({ identity_tokens: ['lego', 'duplo'] }));
    runConstrainMock.mockResolvedValueOnce(constrainResult());
    runPickMock.mockResolvedValueOnce(acceptedPick());
    await runAnchoredPipeline(buildItem(), 'naqel', 'item-1');
    expect(generateSubmissionMock).toHaveBeenCalledTimes(1);
    const callArgs = generateSubmissionMock.mock.calls[0]![0];
    expect(callArgs.identityTokens).toEqual(['lego', 'duplo']);
  });

  it('passes empty identity_tokens for uninformative identify (no canonical, fallback to raw description)', async () => {
    runIdentifyMock.mockResolvedValueOnce({
      kind: 'uninformative', reason: 'unknown', cause: 'genuine', trace: identifyTrace(),
    });
    runConstrainMock.mockResolvedValueOnce(constrainResult());
    // pick will return escalate (identify_no_query) — submission shouldn't be called.
    runPickMock.mockResolvedValueOnce(escalatePick('identify_no_query'));
    const r = await runAnchoredPipeline(buildItem(), 'naqel', 'item-1');
    expect(r.final_code).toBeNull();
    expect(generateSubmissionMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Escalation paths route to HITL
// ───────────────────────────────────────────────────────────────────────

describe('runAnchoredPipeline — escalation paths', () => {
  it('scope_escalate → final_code=null, hitl=verdict_escalate, no submission/sanity', async () => {
    runIdentifyMock.mockResolvedValueOnce({ kind: 'multi_product', products: ['a', 'b'], trace: identifyTrace() });
    runConstrainMock.mockResolvedValueOnce(constrainResult({ scopeKind: 'escalate' }));
    runPickMock.mockResolvedValueOnce(escalatePick('scope_escalate'));
    const r = await runAnchoredPipeline(buildItem(), 'naqel', 'item-1');
    expect(r.final_code).toBeNull();
    expect(r.hitl?.reason).toBe('verdict_escalate');
    expect(generateSubmissionMock).not.toHaveBeenCalled();
    expect(runSanityMock).not.toHaveBeenCalled();
  });

  it('no_candidate_fits → final_code=null, hitl=verdict_escalate', async () => {
    runIdentifyMock.mockResolvedValueOnce(cleanIdentify());
    runConstrainMock.mockResolvedValueOnce(constrainResult());
    runPickMock.mockResolvedValueOnce(escalatePick('no_candidate_fits'));
    const r = await runAnchoredPipeline(buildItem(), 'naqel', 'item-1');
    expect(r.final_code).toBeNull();
    expect(r.hitl?.reason).toBe('verdict_escalate');
  });

  it('identify uninformative + cause=transport → infra_degraded=true', async () => {
    runIdentifyMock.mockResolvedValueOnce({
      kind: 'uninformative', reason: 'timeout', cause: 'transport',
      trace: { ...identifyTrace(), status: 'timeout', llm_called: true },
    });
    runConstrainMock.mockResolvedValueOnce(constrainResult({ scopeKind: 'escalate' }));
    runPickMock.mockResolvedValueOnce(escalatePick('scope_escalate'));
    const r = await runAnchoredPipeline(buildItem(), 'naqel', 'item-1');
    expect(r.infra_degraded).toBe(true);
  });

  it('uninformative + cause=transport + identify_no_query → hitl=verdict_escalate (not low_information; transport is an infra failure, not a genuine give-up)', async () => {
    runIdentifyMock.mockResolvedValueOnce({
      kind: 'uninformative', reason: 'timeout', cause: 'transport',
      trace: { ...identifyTrace(), status: 'timeout', llm_called: true },
    });
    runConstrainMock.mockResolvedValueOnce(constrainResult());
    runPickMock.mockResolvedValueOnce(escalatePick('identify_no_query'));
    const r = await runAnchoredPipeline(buildItem(), 'naqel', 'item-1');
    expect(r.hitl?.reason).toBe('verdict_escalate');
    expect(r.infra_degraded).toBe(true);
  });

  it('uninformative + cause=genuine + no_candidate_fits (not identify_no_query) → hitl=verdict_escalate (low_information requires both predicates)', async () => {
    // identify gave up genuinely, but pick reached a different escalate
    // reason. low_information is reserved for the specific identify+pick
    // combination; other pairings stay verdict_escalate.
    runIdentifyMock.mockResolvedValueOnce({
      kind: 'uninformative', reason: 'too vague', cause: 'genuine', trace: identifyTrace(),
    });
    runConstrainMock.mockResolvedValueOnce(constrainResult());
    runPickMock.mockResolvedValueOnce(escalatePick('no_candidate_fits'));
    const r = await runAnchoredPipeline(buildItem(), 'naqel', 'item-1');
    expect(r.hitl?.reason).toBe('verdict_escalate');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Sanity FLAG routes to HITL with sanity_flag
// ───────────────────────────────────────────────────────────────────────

describe('runAnchoredPipeline — sanity FLAG', () => {
  it('sanity returns FLAG → hitl=sanity_flag, final_code present', async () => {
    runIdentifyMock.mockResolvedValueOnce(cleanIdentify());
    runConstrainMock.mockResolvedValueOnce(constrainResult());
    runPickMock.mockResolvedValueOnce(acceptedPick('610910000000'));
    runSanityMock.mockResolvedValueOnce({
      verdict: 'FLAG', rationale: 'value implausible', latency_ms: 80, model: 'm', attempts: 1, retried_reasons: [], degraded: false,
    });
    const r = await runAnchoredPipeline(buildItem(), 'naqel', 'item-1');
    expect(r.final_code).toBe('610910000000');
    expect(r.sanity_verdict).toBe('FLAG');
    expect(r.hitl?.reason).toBe('sanity_flag');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Parse rejection — upstream guard before any LLM stage runs
// ───────────────────────────────────────────────────────────────────────

describe('runAnchoredPipeline — parse rejection', () => {
  it('parse rejects empty description → sanity_verdict=BLOCK, final_code=null, no downstream stages invoked', async () => {
    // BLOCK is reserved for inputs the pipeline refuses to even attempt
    // (no description → parse can't classify and sanity can't evaluate).
    // None of identify/constrain/pick/submission/sanity should run.
    const r = await runAnchoredPipeline(buildItem({ description: '' }), 'naqel', 'item-1');
    expect(r.sanity_verdict).toBe('BLOCK');
    expect(r.final_code).toBeNull();
    expect(r.goods_description_ar).toBeNull();
    expect(r.hitl).toBeNull();
    expect(r.infra_degraded).toBe(false);
    expect(runIdentifyMock).not.toHaveBeenCalled();
    expect(runConstrainMock).not.toHaveBeenCalled();
    expect(runPickMock).not.toHaveBeenCalled();
    expect(generateSubmissionMock).not.toHaveBeenCalled();
    expect(runSanityMock).not.toHaveBeenCalled();
  });

  it('parse rejection still emits anchored pipeline_architecture in trace', async () => {
    const r = await runAnchoredPipeline(buildItem({ description: '' }), 'naqel', 'item-1');
    expect(r.trace.pipeline_architecture).toBe('anchored');
    // Legacy stage outputs must remain null on the rejection path —
    // buildTrace's exclusivity assertion guarantees this even if a
    // future caller accidentally tries to pass legacy fields.
    expect(r.trace.track_a).toBeNull();
    expect(r.trace.track_b).toBeNull();
    expect(r.trace.verdict).toBeNull();
    // Anchored stage outputs are also null because no anchored stage
    // ran; the parse stage trace is still present in stages[].
    expect(r.trace.anchored_identify).toBeNull();
    expect(r.trace.anchored_constrain).toBeNull();
    expect(r.trace.anchored_pick).toBeNull();
    expect(r.trace.stages.some((s) => s.name === 'stage-0a/parse')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Production-failure-case integration tests
// ───────────────────────────────────────────────────────────────────────

describe('runAnchoredPipeline — production failure cases now resolve', () => {
  it('maxhub: no merchant, identify resolves Ch 85 via web, family_chapter scope, fits → Ch 85 final', async () => {
    runIdentifyMock.mockResolvedValueOnce(cleanIdentify({
      canonical: 'interactive flat-panel display for conference rooms',
      family_chapter: '85',
      identity_tokens: ['maxhub'],
      confidence: 0.82,
    }));
    runConstrainMock.mockResolvedValueOnce(constrainResult({
      scopeKind: 'family_chapter', prefix: '85',
      resolution: { state: 'absent' },
    }));
    runPickMock.mockResolvedValueOnce(acceptedPick('852852000000', 'fits'));
    const r = await runAnchoredPipeline(buildItem({ merchantHsCode: null }), 'naqel', 'item-1');
    expect(r.final_code).toBe('852852000000');
    expect(r.final_code?.startsWith('85')).toBe(true);
    expect(r.hitl).toBeNull();
  });

  it('TORY 45: identify uninformative+genuine, merchant 6404 active, pick escalates identify_no_query → hitl=low_information', async () => {
    // Legacy preserved a distinct `low_information` HITL reason for the
    // "researcher cleanly gave up AND description thin" path — different
    // reviewer SLA and queue routing. Anchored maps that to
    // identify.cause='genuine' + pick.reason='identify_no_query'.
    runIdentifyMock.mockResolvedValueOnce({
      kind: 'uninformative', reason: 'unable to identify product', cause: 'genuine', trace: identifyTrace(),
    });
    runConstrainMock.mockResolvedValueOnce(constrainResult({
      scopeKind: 'merchant_prefix', prefix: '640420',
      resolution: { state: 'active', resolved_code: '640420000000' },
    }));
    runPickMock.mockResolvedValueOnce(escalatePick('identify_no_query'));
    const r = await runAnchoredPipeline(buildItem({ merchantHsCode: '640420000000' }), 'naqel', 'item-1');
    expect(r.final_code).toBeNull();
    expect(r.hitl?.reason).toBe('low_information');
    // The trace still carries the merchant resolution + identify
    // uninformative cause — HITL queue can show "merchant said
    // 640420 / Ch 64, identify couldn't confirm".
    expect(r.trace.anchored_constrain?.resolution.state).toBe('active');
  });

  it('GPU: identify clean Ch 84, merchant 8471 active, fits → Ch 84 final (not Ch 85 ICs)', async () => {
    runIdentifyMock.mockResolvedValueOnce(cleanIdentify({
      canonical: 'GPU graphics card, PCIe expansion card for computers',
      family_chapter: '84',
      identity_tokens: ['RTX 5070'],
      confidence: 0.92,
    }));
    runConstrainMock.mockResolvedValueOnce(constrainResult({
      scopeKind: 'merchant_prefix', prefix: '847180',
      resolution: { state: 'active', resolved_code: '847180000000' },
    }));
    runPickMock.mockResolvedValueOnce(acceptedPick('847330000000', 'fits'));
    const r = await runAnchoredPipeline(buildItem({ merchantHsCode: '8471804000' }), 'naqel', 'item-1');
    expect(r.final_code?.startsWith('84')).toBe(true);
    expect(r.final_code).not.toContain('8542');
  });

  it('Joolz cot: identify Ch 87, merchant override Ch 87, fits → Ch 87 final', async () => {
    runIdentifyMock.mockResolvedValueOnce(cleanIdentify({
      canonical: 'baby cot accessory for use with stroller',
      family_chapter: '87',
      identity_tokens: ['joolz'],
      confidence: 0.78,
    }));
    runConstrainMock.mockResolvedValueOnce(constrainResult({
      scopeKind: 'merchant_prefix', prefix: '871500',
      resolution: {
        state: 'override_applied',
        resolved_code: '871500100000',
        source_code: '87150010',
        override_matched_length: 8,
      },
    }));
    runPickMock.mockResolvedValueOnce(acceptedPick('871500100000', 'fits'));
    const r = await runAnchoredPipeline(buildItem({ merchantHsCode: '87150010' }), 'naqel', 'item-1');
    expect(r.final_code).toBe('871500100000');
    expect(r.final_code?.startsWith('87')).toBe(true);
  });
});
