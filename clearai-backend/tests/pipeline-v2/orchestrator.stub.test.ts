/**
 * PR 1 — Foundation type-contract test.
 *
 * Asserts that the v2 discriminated unions compile and are
 * exhaustively typeable. If a new variant is added to one of the unions
 * and a switch is not updated, `tsc --noEmit` will fail and this test
 * file will break — that's the whole point.
 *
 * Behavioural integration tests for runPipelineV2 live in
 * orchestrator.test.ts (PR 11). The earlier stub-throws-sentinel
 * assertions were removed when PR 11 replaced the stub.
 */
import { describe, expect, it } from 'vitest';
import type {
  IdentifyResult,
  MerchantResolution,
  PickResult,
  RetrievalArm,
  ScopeSelection,
  VerifierResult,
} from '../../src/modules/pipeline/v2/types.js';

describe('v2 discriminated-union contracts compile and are exhaustively typeable', () => {
  // These functions exist purely for the typechecker. If a new variant
  // is added to one of the unions, the missing-case error will fail
  // `tsc --noEmit` and break this test file. That is intentional — the
  // discriminated-union shape is the contract for the rewrite.

  function describeIdentify(r: IdentifyResult): string {
    switch (r.kind) {
      case 'clean_product':
        return `clean_product(${r.canonical})`;
      case 'multi_product':
        return `multi_product(${r.products.length})`;
      case 'uninformative':
        return `uninformative(${r.cause})`;
    }
  }

  function describeMerchantResolution(r: MerchantResolution): string {
    switch (r.state) {
      case 'absent':
        return 'absent';
      case 'malformed':
        return `malformed(${r.source_code})`;
      case 'active':
        return `active(${r.resolved_code})`;
      case 'replaced_single':
        return `replaced_single(${r.resolved_code})`;
      case 'override_applied':
        return `override_applied(${r.resolved_code})`;
      case 'llm_picked_replacement':
        return `llm_picked_replacement(${r.resolved_code})`;
      case 'expanded_prefix':
        return `expanded_prefix(${r.resolved_code})`;
      case 'unknown':
        return `unknown(${r.cause})`;
    }
  }

  function describeArm(a: RetrievalArm): string {
    switch (a.kind) {
      case 'merchant_prefix':
        return `merchant_prefix(${a.prefix})`;
      case 'family_chapter':
        return `family_chapter(${a.chapter})`;
      case 'unconstrained':
        return `unconstrained(${a.reason})`;
      case 'lexical_tokens':
        return `lexical_tokens(${a.tokens.length})`;
      case 'escalate':
        return `escalate(${a.reason})`;
    }
  }

  function describePick(p: PickResult): string {
    switch (p.kind) {
      case 'accepted':
        return `accepted(${p.final_code})`;
      case 'escalate':
        return `escalate(${p.reason})`;
    }
  }

  function describeVerify(v: VerifierResult): string {
    switch (v.result) {
      case 'PASS':
        return 'PASS';
      case 'UNCERTAIN':
        return `UNCERTAIN(${v.rules_triggered.join(',')})`;
    }
  }

  it('IdentifyResult union is exhaustive', () => {
    const x: IdentifyResult = {
      kind: 'uninformative',
      cause: 'genuine',
      reason: 'test',
      trace: {
        pass: 'fast',
        llm_called: true,
        latency_ms: 100,
        model: 'mock',
        status: 'ok',
        web_search_used: false,
        evidence_mismatch: false,
      },
    };
    expect(describeIdentify(x)).toBe('uninformative(genuine)');
  });

  it('MerchantResolution union is exhaustive across 8 states', () => {
    const x: MerchantResolution = { state: 'absent' };
    expect(describeMerchantResolution(x)).toBe('absent');
  });

  it('RetrievalArm union is exhaustive across 5 kinds', () => {
    const x: RetrievalArm = {
      kind: 'lexical_tokens',
      tokens: ['maxhub', 'IFP'],
    };
    expect(describeArm(x)).toBe('lexical_tokens(2)');
  });

  it('PickResult union is exhaustive', () => {
    const x: PickResult = {
      kind: 'escalate',
      reason: 'no_candidate_fits',
      detail: 'test',
      trace: {
        llm_called: true,
        latency_ms: 5000,
        model: 'mock',
        status: 'ok',
        candidate_count: 12,
        audit_flag: false,
      },
    };
    expect(describePick(x)).toBe('escalate(no_candidate_fits)');
  });

  it('VerifierResult union is exhaustive', () => {
    const x: VerifierResult = {
      result: 'UNCERTAIN',
      rules_triggered: ['identify_chapter_disagreement'],
    };
    expect(describeVerify(x)).toBe('UNCERTAIN(identify_chapter_disagreement)');
  });

  it('ScopeSelection composes RetrievalArm + audit flags', () => {
    const s: ScopeSelection = {
      primary: { kind: 'merchant_prefix', prefix: '610910', source: 'merchant_active' },
      secondaries: [
        { kind: 'family_chapter', chapter: '85', source: 'identify' },
        { kind: 'lexical_tokens', tokens: ['maxhub'] },
      ],
      audit_flags: ['merchant_chapter_disagreement'],
    };
    expect(s.secondaries).toHaveLength(2);
    expect(s.audit_flags).toContain('merchant_chapter_disagreement');
  });
});
