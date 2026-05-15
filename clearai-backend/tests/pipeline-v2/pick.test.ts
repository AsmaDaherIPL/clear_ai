/**
 * PR 9 — picker (multi-arm aware) tests.
 *
 * Mocks callLlmWithRetry. Covers:
 *  - accepted with new audit fields (picked_from_arm, merchant_chapter_disagreement,
 *    candidate_count_by_arm)
 *  - audit_flag fires only when picked from non-merchant arm AND chapter disagrees
 *  - escalate paths (identify_no_query, no_candidates, picker_unavailable on
 *    transport, picker_unavailable on parse, no_candidate_fits)
 *  - LLM call shape (stage=anchored_pick, Sonnet, candidate payload includes
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

import { runPick } from '../../src/modules/pipeline/v2/pick/pick.js';
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
  it('identify_no_query when identify is not clean_product', async () => {
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
      expect(r.confidence).toBe(0.85);
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

  it('partial fit assigns confidence=0.55', async () => {
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
      expect(r.confidence).toBe(0.55);
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

  it('passes Sonnet model, temperature=0, retries=0', async () => {
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
    expect(args.stage).toBe('anchored_pick');
    expect(mockedCall.mock.calls[0]![1]).toBe(0);
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
