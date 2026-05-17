/**
 * PR 9 — picker (multi-arm aware) tests.
 *
 * Mocks callLlmWithRetry. Covers:
 *  - accepted with new audit fields (picked_from_arm, merchant_chapter_disagreement,
 *    candidate_count_by_arm)
 *  - audit_flag fires only when picked from non-merchant arm AND chapter disagrees
 *  - escalate paths (identify_no_query, no_candidates, picker_unavailable on
 *    transport, picker_unavailable on parse, no_candidate_fits)
 *  - LLM call shape (stage=pick, Sonnet, candidate payload includes
 *    source_arm)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/inference/llm/client.js', () => ({
  callLlmWithRetry: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('mock-pick-prompt'),
}));
vi.mock('../../src/config/env.js', () => ({
  env: () => ({ LLM_MODEL: 'mock-haiku', LLM_MODEL_STRONG: 'mock-sonnet' }),
}));

import { runPick, computeConfidence } from '../../src/modules/pipeline/v2/pick/pick.js';
import { callLlmWithRetry } from '../../src/inference/llm/client.js';
import type {
  IdentifyCallTrace,
  IdentifyResult,
  RerankedCandidate,
} from '../../src/modules/pipeline/v2/types.js';

const mockedCall = vi.mocked(callLlmWithRetry);

const fastTrace: IdentifyCallTrace = {
  pass: 'fast',
  llm_called: true,
  latency_ms: 2000,
  model: 'mock-sonnet',
  status: 'ok',
  web_search_used: false,
  evidence_mismatch: false,
};

function id(opts: { family?: string | null; tokens?: string[]; canonical?: string } = {}): IdentifyResult {
  return {
    kind: 'clean_product',
    canonical: opts.canonical ?? 'cotton t-shirt',
    family_chapter: 'family' in opts ? opts.family ?? null : '61',
    identity_tokens: opts.tokens ?? [],
    confidence: 0.9,
    evidence: 'world_knowledge',
    trace: fastTrace,
  };
}

function uninf(): IdentifyResult {
  return { kind: 'uninformative', cause: 'genuine', reason: 'r', trace: fastTrace };
}

function multi(products: string[] = ['T-shirt', 'Pants']): IdentifyResult {
  return { kind: 'multi_product', products, trace: fastTrace };
}

function rc(
  code: string,
  arm: RerankedCandidate['source_arm'] = 'merchant_prefix',
  rrf = 0.5,
): RerankedCandidate {
  return {
    code,
    description_en: `desc ${code}`,
    description_ar: null,
    rrf_score: rrf,
    bm25_score: null,
    vector_score: null,
    trigram_score: null,
    source_arm: arm,
    rerank_score: rrf + 0.03,
    rerank_features: {
      rrf_score: rrf,
      chapter_agreement: false,
      identity_token_overlap_count: 0,
      arm_boost: 0.03,
    },
  };
}

function llmReturns(opts: { text: string; latencyMs?: number; model?: string }) {
  return {
    status: 'ok' as const,
    text: opts.text,
    raw: { content: [{ type: 'text', text: opts.text }] },
    latencyMs: opts.latencyMs ?? 5000,
    model: opts.model ?? 'mock-sonnet',
  };
}

beforeEach(() => mockedCall.mockReset());

describe('runPick — short-circuit paths', () => {
  it('identify_no_query when identify is not clean_product AND no fallback_query', async () => {
    const r = await runPick({
      identify: uninf(),
      candidates: [rc('610910000000')],
      merchant_chapter: '61',
    });
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') {
      expect(r.reason).toBe('identify_no_query');
    }
    // No LLM call
    expect(mockedCall).not.toHaveBeenCalled();
  });

  it('brand-only rescue: uninformative identify + fallback_query runs picker against merchant leaf', async () => {
    // Real scenario: description="THE RING" + merchant=640420 (chap 64
    // footwear). Identify is uninformative; orchestrator pre-computes
    // fallback_query from the merchant leaf's catalog text. Picker
    // runs with that as the query and verdicts the merchant's
    // candidate as the best fit.
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          verdicts: [
            { code: '640420000000', fit: 'partial', rationale: 'Footwear with leather outer sole — closest leaf under merchant prefix (GIR 3(a))' },
          ],
        }),
      }),
    );
    const r = await runPick({
      identify: uninf(),
      candidates: [rc('640420000000', 'merchant_prefix')],
      merchant_chapter: '64',
      fallback_query: 'footwear with outer soles of leather',
    });
    expect(r.kind).toBe('accepted');
    expect(mockedCall).toHaveBeenCalledOnce();
    if (r.kind === 'accepted') {
      expect(r.final_code).toBe('640420000000');
      expect(r.fit).toBe('partial');
    }
  });

  it('no_candidates when candidates list is empty', async () => {
    const r = await runPick({
      identify: id(),
      candidates: [],
      merchant_chapter: '61',
    });
    if (r.kind === 'escalate') {
      expect(r.reason).toBe('no_candidates');
    }
    expect(mockedCall).not.toHaveBeenCalled();
  });

  it('multi_product DOES call the picker (using first product as query) when candidates are present (regression 2026-05-15)', async () => {
    // Before this fix, identify.kind=multi_product produced an empty
    // buildQuery() and short-circuited to identify_no_query. After the
    // fix, the picker runs with products[0] as the canonical query,
    // letting the merchant_prefix arm rescue rows where the items in a
    // multi-product line share a chapter (e.g. "skirt + shirt, cotton"
    // both under chapter 62).
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          verdicts: [{ code: '610910000000', fit: 'fits', rationale: 'subset (GIR 1)' }],
        }),
      }),
    );
    const r = await runPick({
      identify: multi(['T-shirt', 'Pants']),
      candidates: [rc('610910000000', 'merchant_prefix')],
      merchant_chapter: '61',
    });
    expect(r.kind).toBe('accepted');
    expect(mockedCall).toHaveBeenCalledOnce();
  });
});

describe('runPick — accepted with audit fields', () => {
  it('picks from merchant_prefix arm, chapters agree → no audit_flag, no disagreement', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          verdicts: [{ code: '610910000000', fit: 'fits', rationale: 'subset (GIR 1)' }],
        }),
      }),
    );
    const r = await runPick({
      identify: id({ family: '61' }),
      candidates: [rc('610910000000', 'merchant_prefix')],
      merchant_chapter: '61',
    });
    expect(r.kind).toBe('accepted');
    if (r.kind === 'accepted') {
      expect(r.final_code).toBe('610910000000');
      expect(r.fit).toBe('fits');
      // Computed confidence (Option A): base(fits)=0.65 + pool_clean(1
      // fits, 0 partial)=+0.10 + arm_agree=0 (single arm) + rerank_gap=0
      // (single candidate) = 0.75. See computeConfidence() in pick.ts.
      expect(r.confidence).toBe(0.75);
      expect(r.confidence_signals.base).toBe(0.65);
      expect(r.confidence_signals.pool_cleanness_bonus).toBe(0.10);
      expect(r.gir_applied).toBe('GIR 1');
      expect(r.picked_from_arm).toBe('merchant_prefix');
      expect(r.merchant_chapter_disagreement).toBe(false);
      expect(r.candidate_count_by_arm.merchant_prefix).toBe(1);
      expect(r.trace.audit_flag).toBe(false);
    }
  });

  it('picks from family_chapter arm when merchant chapter disagrees → audit_flag fires', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          verdicts: [
            { code: '871500100000', fit: 'does_not_fit', rationale: 'wrong product class' },
            { code: '961900100000', fit: 'fits', rationale: 'paper diapers (GIR 1)' },
          ],
        }),
      }),
    );
    const r = await runPick({
      identify: id({ family: '96', canonical: 'disposable baby diapers' }),
      candidates: [
        rc('871500100000', 'merchant_prefix'), // baby carriages
        rc('961900100000', 'family_chapter'), // sanitary articles / diapers
      ],
      merchant_chapter: '87',
    });
    expect(r.kind).toBe('accepted');
    if (r.kind === 'accepted') {
      expect(r.final_code).toBe('961900100000');
      expect(r.picked_from_arm).toBe('family_chapter');
      expect(r.merchant_chapter_disagreement).toBe(true);
      expect(r.trace.audit_flag).toBe(true);
    }
  });

  it('picks from lexical_tokens arm → picked_from_arm reflects the arm', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          verdicts: [{ code: '950300900000', fit: 'fits', rationale: 'lego construction toy' }],
        }),
      }),
    );
    const r = await runPick({
      identify: id({ family: '95', tokens: ['lego'] }),
      candidates: [rc('950300900000', 'lexical_tokens')],
      merchant_chapter: '95',
    });
    if (r.kind === 'accepted') {
      expect(r.picked_from_arm).toBe('lexical_tokens');
      // merchant chapter agrees → no audit even though picked from non-merchant arm
      expect(r.merchant_chapter_disagreement).toBe(false);
      expect(r.trace.audit_flag).toBe(false);
    }
  });

  it('audit_flag does NOT fire when picked from non-merchant arm but chapters agree', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          verdicts: [{ code: '610910000000', fit: 'fits', rationale: 'match' }],
        }),
      }),
    );
    const r = await runPick({
      identify: id({ family: '61' }),
      candidates: [rc('610910000000', 'family_chapter')],
      merchant_chapter: '61', // same chapter
    });
    if (r.kind === 'accepted') {
      expect(r.merchant_chapter_disagreement).toBe(false);
      expect(r.trace.audit_flag).toBe(false);
    }
  });

  it('audit_flag does NOT fire when merchant_chapter is null (no merchant)', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          verdicts: [{ code: '610910000000', fit: 'fits', rationale: 'match' }],
        }),
      }),
    );
    const r = await runPick({
      identify: id({ family: '61' }),
      candidates: [rc('610910000000', 'family_chapter')],
      merchant_chapter: null,
    });
    if (r.kind === 'accepted') {
      expect(r.merchant_chapter_disagreement).toBe(false);
      expect(r.trace.audit_flag).toBe(false);
    }
  });

  it('partial fit on a clean single-arm pool computes a base-only confidence', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          verdicts: [{ code: '610910000000', fit: 'partial', rationale: 'material silent' }],
        }),
      }),
    );
    const r = await runPick({
      identify: id(),
      candidates: [rc('610910000000')],
      merchant_chapter: '61',
    });
    if (r.kind === 'accepted') {
      // base(partial)=0.45 + pool_clean=0 (no fits) + arm=0 (single arm)
      // + rerank=0 (single candidate). See computeConfidence().
      expect(r.confidence).toBe(0.45);
      expect(r.confidence_signals.base).toBe(0.45);
      expect(r.fit).toBe('partial');
    }
  });

  it('aggregates candidate_count_by_arm correctly', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          verdicts: [
            { code: 'a', fit: 'fits', rationale: 'x' },
            { code: 'b', fit: 'does_not_fit', rationale: 'y' },
            { code: 'c', fit: 'does_not_fit', rationale: 'z' },
            { code: 'd', fit: 'does_not_fit', rationale: 'w' },
          ],
        }),
      }),
    );
    const r = await runPick({
      identify: id({ family: null }),
      candidates: [
        rc('a', 'merchant_prefix'),
        rc('b', 'merchant_prefix'),
        rc('c', 'family_chapter'),
        rc('d', 'lexical_tokens'),
      ],
      merchant_chapter: null,
    });
    if (r.kind === 'accepted') {
      expect(r.candidate_count_by_arm).toEqual({
        merchant_prefix: 2,
        family_chapter: 1,
        lexical_tokens: 1,
      });
    }
  });

  it('prefers fits over partial when both are present', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          verdicts: [
            { code: 'partial-one', fit: 'partial', rationale: 'p' },
            { code: 'fits-one', fit: 'fits', rationale: 'f' },
          ],
        }),
      }),
    );
    const r = await runPick({
      identify: id({ family: null }),
      candidates: [rc('partial-one'), rc('fits-one')],
      merchant_chapter: null,
    });
    if (r.kind === 'accepted') expect(r.final_code).toBe('fits-one');
  });
});

describe('runPick — escalate paths', () => {
  it('no_candidate_fits when all verdicts are does_not_fit', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          verdicts: [
            { code: 'a', fit: 'does_not_fit', rationale: 'x' },
            { code: 'b', fit: 'does_not_fit', rationale: 'y' },
          ],
        }),
      }),
    );
    const r = await runPick({
      identify: id({ family: null }),
      candidates: [rc('a'), rc('b')],
      merchant_chapter: null,
    });
    if (r.kind === 'escalate') expect(r.reason).toBe('no_candidate_fits');
  });

  it('picker_unavailable when LLM transport fails', async () => {
    mockedCall.mockResolvedValueOnce({
      status: 'timeout',
      text: null,
      raw: null,
      error: 'aborted',
      latencyMs: 15000,
      model: 'mock-sonnet',
    });
    const r = await runPick({
      identify: id(),
      candidates: [rc('a')],
      merchant_chapter: null,
    });
    if (r.kind === 'escalate') {
      expect(r.reason).toBe('picker_unavailable');
      expect(r.trace.status).toBe('timeout');
    }
  });

  it('picker_unavailable when parse retries exhausted', async () => {
    mockedCall
      .mockResolvedValueOnce(llmReturns({ text: 'not json' }))
      .mockResolvedValueOnce(llmReturns({ text: 'still not json' }))
      .mockResolvedValueOnce(llmReturns({ text: '{ broken' }));
    const r = await runPick({
      identify: id(),
      candidates: [rc('a')],
      merchant_chapter: null,
    });
    if (r.kind === 'escalate') {
      expect(r.reason).toBe('picker_unavailable');
      expect(r.trace.status).toBe('parse');
    }
  });
});

describe('runPick — LLM call shape', () => {
  it('passes candidate source_arm in user payload', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          verdicts: [{ code: 'a', fit: 'fits', rationale: 'x' }],
        }),
      }),
    );
    await runPick({
      identify: id(),
      candidates: [rc('a', 'family_chapter')],
      merchant_chapter: null,
    });
    const userPayload = JSON.parse(mockedCall.mock.calls[0]![0].user);
    expect(userPayload.candidates[0].source_arm).toBe('family_chapter');
    expect(userPayload.candidates[0].code).toBe('a');
  });

  it('passes Sonnet model, temperature=0, retries=1', async () => {
    // 2026-05-16: was retries=0; raised to 1 after batch 019e3103
    // showed single-shot picker timeouts (rows 139, 156) escalating
    // to picker_unavailable that would have succeeded on retry.
    // Picker is idempotent; 2 × 15s worst case fits the 50s budget.
    mockedCall.mockResolvedValueOnce(
      llmReturns({ text: JSON.stringify({ verdicts: [] }) }),
    );
    await runPick({
      identify: id(),
      candidates: [rc('a')],
      merchant_chapter: null,
    });
    const args = mockedCall.mock.calls[0]![0];
    expect(args.model).toBe('mock-sonnet');
    expect(args.temperature).toBe(0);
    expect(args.stage).toBe('pick');
    expect(mockedCall.mock.calls[0]![1]).toBe(1);
  });

  it('includes identity_tokens in the description query', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({ text: JSON.stringify({ verdicts: [] }) }),
    );
    await runPick({
      identify: id({ tokens: ['maxhub', 'IFP'] }),
      candidates: [rc('a')],
      merchant_chapter: null,
    });
    const userPayload = JSON.parse(mockedCall.mock.calls[0]![0].user);
    expect(userPayload.description).toBe('cotton t-shirt maxhub IFP');
  });
});

describe('computeConfidence — signal-based formula', () => {
  it('clean single-arm fits → base + pool_clean only', () => {
    // base(fits)=0.65 + pool_clean(1 fits, 0 partial)=0.10 + 0 + 0 = 0.75
    const { confidence, signals } = computeConfidence({
      fit: 'fits',
      verdict_population: { fits: 1, partial: 0, does_not_fit: 0 },
      candidates: [rc('a', 'merchant_prefix', 0.5)],
      merchant_chapter_disagreement: false,
    });
    expect(confidence).toBeCloseTo(0.75, 5);
    expect(signals.base).toBe(0.65);
    expect(signals.pool_cleanness_bonus).toBe(0.10);
    expect(signals.arm_agreement_bonus).toBe(0);
    expect(signals.rerank_gap_bonus).toBe(0);
  });

  it('multi-arm fits with chapter agreement and wide rerank gap → all bonuses', () => {
    // base 0.65 + pool_clean 0.10 + arm_agree 0.10 + rerank_gap 0.05 = 0.90
    const { confidence } = computeConfidence({
      fit: 'fits',
      verdict_population: { fits: 1, partial: 0, does_not_fit: 6 },
      candidates: [
        rc('a', 'merchant_prefix', 0.80),
        rc('b', 'family_chapter', 0.30),
      ],
      merchant_chapter_disagreement: false,
    });
    // pool_dominated also fires (6/7 = 0.857 >= 0.7) so +0.05 more = 0.95
    expect(confidence).toBeCloseTo(0.95, 5);
  });

  it('merchant chapter disagreement penalizes even on a fits verdict', () => {
    // base 0.65 + pool_clean 0.10 + arm_disagree -0.10 + rerank_gap 0 = 0.65
    const { confidence } = computeConfidence({
      fit: 'fits',
      verdict_population: { fits: 1, partial: 0, does_not_fit: 1 },
      candidates: [
        rc('a', 'merchant_prefix', 0.50),
        rc('b', 'family_chapter', 0.49),
      ],
      merchant_chapter_disagreement: true,
    });
    expect(confidence).toBeCloseTo(0.65, 5);
  });

  it('partial verdict starts at lower base', () => {
    // base(partial) 0.45 + pool_clean 0 (no fits) + 0 + 0 = 0.45
    const { confidence } = computeConfidence({
      fit: 'partial',
      verdict_population: { fits: 0, partial: 1, does_not_fit: 0 },
      candidates: [rc('a')],
      merchant_chapter_disagreement: false,
    });
    expect(confidence).toBeCloseTo(0.45, 5);
  });

  it('clamps to [0.05, 0.99]', () => {
    // A theoretical max input still respects the ceiling.
    const allBonuses = computeConfidence({
      fit: 'fits',
      verdict_population: { fits: 1, partial: 0, does_not_fit: 10 },
      candidates: [
        rc('a', 'merchant_prefix', 1.0),
        rc('b', 'family_chapter', 0.1),
      ],
      merchant_chapter_disagreement: false,
    });
    expect(allBonuses.confidence).toBeLessThanOrEqual(0.99);
    expect(allBonuses.confidence).toBeGreaterThanOrEqual(0.05);
  });

  it('rerank gap requires >=10% relative separation', () => {
    // Gap (0.50 - 0.46)/0.50 = 0.08 → no bonus
    const tightGap = computeConfidence({
      fit: 'fits',
      verdict_population: { fits: 1, partial: 0, does_not_fit: 0 },
      candidates: [rc('a', 'merchant_prefix', 0.50), rc('b', 'merchant_prefix', 0.46)],
      merchant_chapter_disagreement: false,
    });
    expect(tightGap.signals.rerank_gap_bonus).toBe(0);

    // Gap (0.50 - 0.40)/0.50 = 0.20 → bonus fires
    const wideGap = computeConfidence({
      fit: 'fits',
      verdict_population: { fits: 1, partial: 0, does_not_fit: 0 },
      candidates: [rc('a', 'merchant_prefix', 0.50), rc('b', 'merchant_prefix', 0.40)],
      merchant_chapter_disagreement: false,
    });
    expect(wideGap.signals.rerank_gap_bonus).toBe(0.05);
  });
});
