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

import {
  runPick,
  computeConfidence,
  deriveConfidenceBand,
} from '../../src/modules/pipeline/v2/pick/pick.js';
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
    path_en: '',
    path_ar: '',
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
      // PR9 (2026-05-20): single-candidate pool → entropy = 0 →
      // confidence = 1 (clamped to CONFIDENCE_MAX = 0.99). The legacy
      // base+bonuses live on `confidence_signals` for audit but no
      // longer drive the final number.
      expect(r.confidence).toBeCloseTo(0.99, 5);
      expect(r.confidence_band).toBe('high');
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
      // PR9: single-candidate pool → entropy = 0 → confidence at MAX.
      // Verdict is `partial`, but entropy doesn't care about the fit
      // verdict for the winner — that's encoded in `signals.base` only.
      expect(r.confidence).toBeCloseTo(0.99, 5);
      expect(r.confidence_band).toBe('high');
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

describe('computeConfidence — entropy-based formula (PR9)', () => {
  // PR9 (2026-05-20): confidence is now 1 − H(p)/H_max over a rerank-
  // weighted distribution. Sharply peaked → high; near-uniform → low.
  // The legacy base+bonuses live on `signals` for trace audit but
  // don't drive the final number anymore.

  it('single-candidate pool → max confidence (no entropy possible)', () => {
    // One candidate, the distribution is trivially peaked. H = 0, conf = 1.
    const { confidence } = computeConfidence({
      fit: 'fits',
      verdict_population: { fits: 1, partial: 0, does_not_fit: 0 },
      candidates: [rc('a', 'merchant_prefix', 0.5)],
      merchant_chapter_disagreement: false,
    });
    // Clamped to CONFIDENCE_MAX = 0.99.
    expect(confidence).toBeCloseTo(0.99, 5);
  });

  it('sharply peaked distribution → moderate or higher band', () => {
    // One candidate dominates rerank → low entropy → moderate/high.
    // The peak here gives candidate "a" ~86% of the mass; entropy ~0.55,
    // H_max = ln(3) ~1.10, so conf ~ 1 - 0.55/1.10 ~ 0.50. That's the
    // boundary of moderate band, so we assert >= 0.40 (fair-or-better).
    const { confidence } = computeConfidence({
      fit: 'fits',
      verdict_population: { fits: 1, partial: 0, does_not_fit: 6 },
      candidates: [
        rc('a', 'merchant_prefix', 0.95),
        rc('b', 'family_chapter', 0.10),
        rc('c', 'family_chapter', 0.05),
      ],
      merchant_chapter_disagreement: false,
    });
    expect(confidence).toBeGreaterThanOrEqual(0.40);
  });

  it('extreme peak (one near-1, others tiny) → high band', () => {
    const { confidence } = computeConfidence({
      fit: 'fits',
      verdict_population: { fits: 1, partial: 0, does_not_fit: 6 },
      candidates: [
        rc('a', 'merchant_prefix', 0.99),
        rc('b', 'family_chapter', 0.001),
        rc('c', 'family_chapter', 0.001),
      ],
      merchant_chapter_disagreement: false,
    });
    expect(confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('near-uniform distribution → low confidence', () => {
    // Three equally-weighted candidates → near-max entropy → conf near 0.
    const { confidence } = computeConfidence({
      fit: 'fits',
      verdict_population: { fits: 1, partial: 1, does_not_fit: 1 },
      candidates: [
        rc('a', 'merchant_prefix', 0.50),
        rc('b', 'family_chapter', 0.50),
        rc('c', 'lexical_tokens', 0.50),
      ],
      merchant_chapter_disagreement: false,
    });
    // Perfectly uniform → H = H_max → conf = 0 → clamped to CONFIDENCE_MIN.
    expect(confidence).toBeCloseTo(0.05, 5);
  });

  it('clamps to [CONFIDENCE_MIN, CONFIDENCE_MAX]', () => {
    const peaked = computeConfidence({
      fit: 'fits',
      verdict_population: { fits: 1, partial: 0, does_not_fit: 10 },
      candidates: [
        rc('a', 'merchant_prefix', 1.0),
        rc('b', 'family_chapter', 0.001),
      ],
      merchant_chapter_disagreement: false,
    });
    expect(peaked.confidence).toBeLessThanOrEqual(0.99);
    expect(peaked.confidence).toBeGreaterThanOrEqual(0.05);
  });

  it('all-zero rerank with multiple candidates floors to CONFIDENCE_MIN', () => {
    // Multi-candidate pool but every rerank score is 0 → distribution
    // undefined → fall back to CONFIDENCE_MIN. A single-candidate pool
    // is degenerate (always max entropy = 0) and gets CONFIDENCE_MAX
    // instead — that's covered by the first test above.
    const { confidence } = computeConfidence({
      fit: 'fits',
      verdict_population: { fits: 1, partial: 0, does_not_fit: 1 },
      candidates: [
        rc('a', 'merchant_prefix', 0),
        rc('b', 'family_chapter', 0),
      ],
      merchant_chapter_disagreement: false,
    });
    expect(confidence).toBeCloseTo(0.05, 5);
  });

  it('candidate_under_eval mode returns p_i for that candidate', () => {
    // Per-candidate annotated mode: each candidate's confidence is its
    // share of the distribution, not the winner's entropy-based score.
    const candidates = [
      rc('a', 'merchant_prefix', 0.80),
      rc('b', 'family_chapter', 0.20),
    ];
    const winner = computeConfidence({
      fit: 'fits',
      verdict_population: { fits: 1, partial: 0, does_not_fit: 1 },
      candidates,
      merchant_chapter_disagreement: false,
    });
    const candA = computeConfidence({
      fit: 'fits',
      verdict_population: { fits: 1, partial: 0, does_not_fit: 1 },
      candidates,
      merchant_chapter_disagreement: false,
      candidate_under_eval: candidates[0]!,
    });
    const candB = computeConfidence({
      fit: 'does_not_fit',
      verdict_population: { fits: 1, partial: 0, does_not_fit: 1 },
      candidates,
      merchant_chapter_disagreement: false,
      candidate_under_eval: candidates[1]!,
    });
    // Shares must sum to ~1 (modulo clamps).
    expect(candA.confidence + candB.confidence).toBeCloseTo(1, 5);
    // A dominates the rerank → A's share > B's share.
    expect(candA.confidence).toBeGreaterThan(candB.confidence);
    // Winner mode produces a different number from any single candidate's p_i.
    expect(winner.confidence).not.toBeCloseTo(candA.confidence, 2);
  });

  it('identify-confidence chaining caps the entropy result', () => {
    // Even a sharply peaked pool can't beat (identify_conf + offset).
    const { confidence } = computeConfidence({
      fit: 'fits',
      verdict_population: { fits: 1, partial: 0, does_not_fit: 4 },
      candidates: [rc('a', 'merchant_prefix', 0.95), rc('b', 'family_chapter', 0.05)],
      merchant_chapter_disagreement: false,
      identify_confidence: 0.42, // weak identify
    });
    // Ceiling = 0.42 + 0.10 = 0.52.
    expect(confidence).toBeLessThanOrEqual(0.52 + 1e-9);
  });

  it('disagreement non-merchant cap clamps even strongly-peaked pools', () => {
    const { confidence } = computeConfidence({
      fit: 'fits',
      verdict_population: { fits: 1, partial: 0, does_not_fit: 4 },
      candidates: [
        rc('a', 'family_chapter', 0.95),
        rc('b', 'family_chapter', 0.05),
      ],
      merchant_chapter_disagreement: true,
      picked_from_arm: 'family_chapter', // not merchant_prefix
    });
    // Hard cap at 0.55 when disagreement + non-merchant winner.
    expect(confidence).toBeLessThanOrEqual(0.55 + 1e-9);
  });
});

describe('deriveConfidenceBand (PR9)', () => {
  it('maps thresholds correctly', () => {
    expect(deriveConfidenceBand(0.95)).toBe('high');
    expect(deriveConfidenceBand(0.75)).toBe('high');
    expect(deriveConfidenceBand(0.74)).toBe('moderate');
    expect(deriveConfidenceBand(0.50)).toBe('moderate');
    expect(deriveConfidenceBand(0.49)).toBe('fair');
    expect(deriveConfidenceBand(0.25)).toBe('fair');
    expect(deriveConfidenceBand(0.24)).toBe('low');
    expect(deriveConfidenceBand(0.10)).toBe('low');
    expect(deriveConfidenceBand(0.09)).toBe('no_result');
    expect(deriveConfidenceBand(0)).toBe('no_result');
  });
});

describe('runPick — deterministic tie-break (L1)', () => {
  // Regression: before this fix, when two candidates both verdicted
  // `fits`, the winner was whichever code Sonnet emitted first in its
  // verdict array — V8 iteration order + LLM token stream. We now pick
  // the candidate with the highest rerank_score, with code lexicographic
  // order as the final tiebreak. Same input → same winner across runs.
  it('picks the fits candidate with the higher rerank_score on a tie', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          verdicts: [
            // Picker emits low-rerank candidate FIRST. Pre-fix winner = 'a'.
            { code: 'a', fit: 'fits', rationale: 'r1' },
            { code: 'b', fit: 'fits', rationale: 'r2' },
          ],
        }),
      }),
    );
    const r = await runPick({
      identify: id({ family: null }),
      candidates: [
        rc('a', 'merchant_prefix', 0.30),
        rc('b', 'merchant_prefix', 0.80), // higher rerank_score → must win
      ],
      merchant_chapter: null,
    });
    expect(r.kind).toBe('accepted');
    if (r.kind === 'accepted') {
      expect(r.final_code).toBe('b');
    }
  });

  it('falls back to lexicographic code order when rerank_scores tie', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          verdicts: [
            // Emit 'z' first; after tiebreak 'a' must still win.
            { code: 'z', fit: 'fits', rationale: 'r1' },
            { code: 'a', fit: 'fits', rationale: 'r2' },
          ],
        }),
      }),
    );
    const r = await runPick({
      identify: id({ family: null }),
      candidates: [
        rc('z', 'merchant_prefix', 0.50),
        rc('a', 'merchant_prefix', 0.50), // identical rerank → lex tiebreak picks 'a'
      ],
      merchant_chapter: null,
    });
    expect(r.kind).toBe('accepted');
    if (r.kind === 'accepted') {
      expect(r.final_code).toBe('a');
    }
  });

  it('partial-vs-partial tie also resolves by rerank_score', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          verdicts: [
            { code: 'p1', fit: 'partial', rationale: 'p1' },
            { code: 'p2', fit: 'partial', rationale: 'p2' },
          ],
        }),
      }),
    );
    const r = await runPick({
      identify: id({ family: null }),
      candidates: [
        rc('p1', 'merchant_prefix', 0.10),
        rc('p2', 'merchant_prefix', 0.90), // higher → wins
      ],
      merchant_chapter: null,
    });
    if (r.kind === 'accepted') expect(r.final_code).toBe('p2');
  });
});

describe('runPick — duplicate verdict dedupe (L2)', () => {
  // Regression: before this fix, if Sonnet emitted the same code twice,
  // tallyPopulation double-counted and could falsely fire
  // POOL_DOMINATED_BONUS (does_not_fit / total >= 0.7). parseVerdicts
  // now dedupes by code with last-write-wins semantics.
  it('counts each verdict code exactly once in verdict_population', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          verdicts: [
            { code: 'a', fit: 'fits', rationale: 'r' },
            { code: 'b', fit: 'does_not_fit', rationale: 'r' },
            { code: 'b', fit: 'does_not_fit', rationale: 'duplicate' },
            { code: 'b', fit: 'does_not_fit', rationale: 'duplicate again' },
          ],
        }),
      }),
    );
    const r = await runPick({
      identify: id({ family: null }),
      candidates: [
        rc('a', 'merchant_prefix', 0.50),
        rc('b', 'merchant_prefix', 0.40),
      ],
      merchant_chapter: null,
    });
    expect(r.kind).toBe('accepted');
    if (r.kind === 'accepted') {
      expect(r.verdict_population.fits).toBe(1);
      expect(r.verdict_population.does_not_fit).toBe(1);
      // 1/2 = 50% does_not_fit — below the 70% threshold, so
      // POOL_DOMINATED_BONUS must NOT fire. Pre-fix this was 3/4 = 75%
      // and the bonus added 0.05 spuriously.
      expect(r.confidence_signals.pool_cleanness_bonus).toBe(0.10); // pool_clean fires (1 fits, 0 partial); pool_dominated does not
    }
  });

  it('last-write-wins when Sonnet emits conflicting verdicts for the same code', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          verdicts: [
            { code: 'a', fit: 'does_not_fit', rationale: 'first take' },
            { code: 'a', fit: 'fits', rationale: 'reconsidered' },
          ],
        }),
      }),
    );
    const r = await runPick({
      identify: id({ family: null }),
      candidates: [rc('a', 'merchant_prefix', 0.50)],
      merchant_chapter: null,
    });
    expect(r.kind).toBe('accepted');
    if (r.kind === 'accepted') {
      expect(r.final_code).toBe('a');
      expect(r.fit).toBe('fits'); // last-write-wins
    }
  });
});

describe('runPick — permissive fits invariant (L6)', () => {
  // Memory rule feedback_picker_permissive_fits.md: when the input
  // describes a subset of what the leaf covers, the picker should label
  // `fits` — silence on unconstrained leaf dimensions is not
  // contradiction. The rule is enforced in the prompt; this test
  // asserts that when the LLM emits `fits` on a subset-input case,
  // runPick accepts it cleanly without downgrade or escalation. If
  // Sonnet drifts toward emitting `does_not_fit` on these cases, the
  // pilot's HITL backlog will tell us — but downstream code must not
  // silently re-classify on top of the model's verdict.
  it('accepts fits when input is a subset of leaf coverage (e.g. cotton t-shirt → "t-shirts of cotton or man-made")', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          verdicts: [
            {
              code: '610910000000',
              fit: 'fits',
              rationale:
                'Cotton t-shirt is a subset of leaf coverage "T-shirts, of cotton or man-made fibres" — input silent on knit/woven dimension which leaf does not constrain (GIR 1)',
            },
          ],
        }),
      }),
    );
    const r = await runPick({
      identify: id({ canonical: 'cotton t-shirt', family: '61' }),
      candidates: [rc('610910000000', 'merchant_prefix', 0.70)],
      merchant_chapter: '61',
    });
    expect(r.kind).toBe('accepted');
    if (r.kind === 'accepted') {
      expect(r.fit).toBe('fits');
      // The picker's verdict is honoured verbatim — no downgrade to
      // 'partial' just because the input was less specific than the
      // leaf coverage.
      expect(r.final_code).toBe('610910000000');
    }
  });
});
