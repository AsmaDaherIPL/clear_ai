/**
 * PR 1 — Foundation test.
 *
 * Asserts that:
 *   1. v2/types.ts compiles + exports the canonical discriminated unions
 *   2. v2/orchestrator.ts compiles + exports the public entry point
 *   3. The stub throws a sentinel error (callers can't accidentally
 *      route live traffic here until PR 11)
 *   4. Discriminated-union exhaustiveness compiles
 *
 * No real LLM calls. No DB. No retrieval. This test exists to lock the
 * import surface for PRs 2-11; every subsequent PR will replace one of
 * the asserted-on stubs with a real implementation.
 */
import { describe, expect, it } from 'vitest';
import { runPipelineV2 } from '../../src/modules/pipeline/v2/orchestrator.js';
import type {
  CanonicalLineItem,
  IdentifyResult,
  MerchantResolution,
  PickResult,
  RetrievalArm,
  ScopeSelection,
  VerifierResult,
} from '../../src/modules/pipeline/v2/types.js';

describe('runPipelineV2 — stub (PR 1)', () => {
  it('throws a sentinel error until PR 11 wires the stages', async () => {
    const item = {} as CanonicalLineItem;
    await expect(runPipelineV2(item, 'naqel', 'item-1')).rejects.toThrow(
      /runPipelineV2 not implemented/,
    );
  });

  it('sentinel error mentions PR 1 of 15 so logs trace back to this stub', async () => {
    const item = {} as CanonicalLineItem;
    await expect(runPipelineV2(item, 'naqel', 'item-1')).rejects.toThrow(
      /PR 1 of 15/,
    );
  });
});

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
