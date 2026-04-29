import { describe, it, expect } from 'vitest';
import { resolve } from '../../src/classification/resolve.js';
import type { GateOutcome } from '../../src/classification/evidence-gate.js';
import type { LlmPickResult } from '../../src/classification/llm-pick.js';

const gatePass: GateOutcome = { passed: true, topRetrievalScore: 0.7, top2Gap: 0.2 };
const gateFailWeak: GateOutcome = {
  passed: false,
  reason: 'weak_retrieval',
  topRetrievalScore: 0.1,
  top2Gap: 0.0,
};

const okLlm = (chosen: string | null): LlmPickResult => ({
  llmStatus: 'ok',
  llmModel: 'claude-haiku-test',
  latencyMs: 100,
  guardTripped: false,
  parseFailed: false,
  chosenCode: chosen,
  rationale: 'because',
  missingAttributes: [],
  rawText: 'json',
});

describe('resolve', () => {
  it('boost short-circuit → already_most_specific', () => {
    const r = resolve({ gate: gatePass, llm: null, alreadyMostSpecific: true });
    expect(r.decisionStatus).toBe('accepted');
    expect(r.decisionReason).toBe('already_most_specific');
  });

  it('gate weak_retrieval → needs_clarification', () => {
    const r = resolve({ gate: gateFailWeak, llm: null });
    expect(r.decisionStatus).toBe('needs_clarification');
    expect(r.decisionReason).toBe('weak_retrieval');
  });

  it('LLM error after gate passed → degraded llm_unavailable', () => {
    const r = resolve({
      gate: gatePass,
      llm: {
        ...okLlm(null),
        llmStatus: 'error',
        rawError: 'HTTP 503',
      },
    });
    expect(r.decisionStatus).toBe('degraded');
    expect(r.decisionReason).toBe('llm_unavailable');
  });

  it('LLM picks a code → accepted strong_match', () => {
    const r = resolve({ gate: gatePass, llm: okLlm('010121100000') });
    expect(r.decisionStatus).toBe('accepted');
    expect(r.decisionReason).toBe('strong_match');
    expect(r.chosenCode).toBe('010121100000');
  });

  it('LLM guard tripped → needs_clarification guard_tripped', () => {
    const r = resolve({
      gate: gatePass,
      llm: { ...okLlm('999999999999'), guardTripped: true, chosenCode: null },
    });
    expect(r.decisionStatus).toBe('needs_clarification');
    expect(r.decisionReason).toBe('guard_tripped');
  });

  it('LLM abstains (chosenCode null) → needs_clarification ambiguous', () => {
    const r = resolve({ gate: gatePass, llm: okLlm(null) });
    expect(r.decisionStatus).toBe('needs_clarification');
    expect(r.decisionReason).toBe('ambiguous_top_candidates');
  });
});
