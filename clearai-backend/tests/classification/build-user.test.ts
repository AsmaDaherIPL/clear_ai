/**
 * Picker user-message format tests for the three PICKER_PATH_MODE values.
 *
 * Why this exists:
 *   buildUser() is the only place candidate-context is actually injected into
 *   the picker prompt. Mode 0/1/2 are gated by setup_meta and A/B-tested
 *   against the eval suite — these tests pin the wire format so a refactor
 *   can't silently change what the model sees (which would invalidate
 *   accuracy comparisons across runs).
 */
import { describe, expect, it } from 'vitest';
import { buildUser } from '../../src/modules/pipeline/track-a-description/picker/llm-pick.js';
import type { Candidate } from '../../src/inference/retrieval/retrieve.js';

function cand(overrides: Partial<Candidate>): Candidate {
  return {
    code: '000000000000',
    description_en: null,
    description_ar: null,
    parent10: '0000000000',
    path_en: '',
    path_ar: '',
    path_codes: [],
    vec_rank: 1,
    bm25_rank: 1,
    trgm_rank: 1,
    vec_score: 1,
    bm25_score: 1,
    trgm_score: 1,
    rrf_score: 1,
    ...overrides,
  };
}

// Two candidates from the same heading (1509), one from a different heading (1510).
// RRF order is preserved: A1, A2 (heading 1509), then B (heading 1510).
const candidates: Candidate[] = [
  cand({
    code: '150910100000',
    description_en: 'Virgin olive oil',
    description_ar: 'زيت زيتون بكر',
    path_en: 'Olive oil and its fractions > Virgin olive oil',
    path_ar: 'زيت زيتون ومجزآته > زيت زيتون بكر',
    path_codes: ['150900000000', '150910100000'],
  }),
  cand({
    code: '150910900000',
    description_en: 'Other',
    description_ar: 'غيرها',
    path_en: 'Olive oil and its fractions > Other',
    path_ar: 'زيت زيتون ومجزآته > غيرها',
    path_codes: ['150900000000', '150910900000'],
  }),
  cand({
    code: '151000100000',
    description_en: 'Crude',
    description_ar: 'خام',
    path_en: 'Other oils obtained solely from olives > Crude',
    path_ar: 'زيوت أخرى محضرة من الزيتون > خام',
    path_codes: ['151000000000', '151000100000'],
  }),
];

describe('buildUser — PICKER_PATH_MODE = 0 (none)', () => {
  it('emits the flat numbered list with no path lines or heading headers', () => {
    const out = buildUser('olive oil', candidates, 0);
    expect(out).toContain('User description:\nolive oil');
    expect(out).toContain('1. code=150910100000');
    expect(out).toContain('   en: Virgin olive oil');
    expect(out).toContain('   ar: زيت زيتون بكر');
    expect(out).toContain('2. code=150910900000');
    expect(out).toContain('3. code=151000100000');
    // No heading headers.
    expect(out).not.toContain('Heading 1509');
    expect(out).not.toContain('Heading 1510');
    // No path breadcrumbs.
    expect(out).not.toContain('path:');
  });

  it('handles parentPrefix when provided', () => {
    const out = buildUser('olive oil', candidates, 0, '1509');
    expect(out.startsWith('Declared parent prefix: 1509')).toBe(true);
  });
});

describe('buildUser — PICKER_PATH_MODE = 1 (heading-only grouping)', () => {
  it('groups consecutive same-heading candidates under a Heading header', () => {
    const out = buildUser('olive oil', candidates, 1);
    expect(out).toContain('Heading 1509 — Olive oil and its fractions');
    expect(out).toContain('Heading 1510 — Other oils obtained solely from olives');
    // Heading 1509 must appear before its leaves.
    const heading1509Idx = out.indexOf('Heading 1509');
    const leaf1509Idx = out.indexOf('150910100000');
    expect(heading1509Idx).toBeLessThan(leaf1509Idx);
    // Heading 1510 must appear after the 1509 leaves but before the 1510 leaf.
    const heading1510Idx = out.indexOf('Heading 1510');
    const leaf1510Idx = out.indexOf('151000100000');
    expect(heading1510Idx).toBeGreaterThan(leaf1509Idx);
    expect(heading1510Idx).toBeLessThan(leaf1510Idx);
  });

  it('preserves RRF rank numbering across headings (does not restart per-group)', () => {
    const out = buildUser('olive oil', candidates, 1);
    // Index 1, 2 in heading 1509; index 3 in heading 1510.
    expect(out).toContain('1. code=150910100000');
    expect(out).toContain('2. code=150910900000');
    expect(out).toContain('3. code=151000100000');
  });

  it('falls back to bare "Heading <NNNN>" when path data is missing', () => {
    const orphan: Candidate[] = [
      cand({
        code: '999999000000',
        description_en: 'Orphan leaf',
        description_ar: null,
        path_en: '',
        path_ar: '',
        path_codes: [],
      }),
    ];
    const out = buildUser('orphan', orphan, 1);
    expect(out).toContain('Heading 9999');
    expect(out).not.toContain('Heading 9999 —');
  });
});

describe('buildUser — PICKER_PATH_MODE = 2 (full breadcrumb per candidate)', () => {
  it('appends a `path:` line with " › " separator for each candidate', () => {
    const out = buildUser('olive oil', candidates, 2);
    expect(out).toContain('path: Olive oil and its fractions › Virgin olive oil');
    expect(out).toContain('path: Olive oil and its fractions › Other');
    expect(out).toContain('path: Other oils obtained solely from olives › Crude');
  });

  it('does NOT emit Heading group headers (no grouping in mode 2)', () => {
    const out = buildUser('olive oil', candidates, 2);
    expect(out).not.toContain('Heading 1509 —');
    expect(out).not.toContain('Heading 1510 —');
  });

  it('omits the `path:` line entirely for candidates with no path data', () => {
    const orphan: Candidate[] = [
      cand({
        code: '999999000000',
        description_en: 'Orphan leaf',
        path_en: '',
        path_ar: '',
        path_codes: [],
      }),
    ];
    const out = buildUser('orphan', orphan, 2);
    expect(out).toContain('1. code=999999000000');
    expect(out).not.toContain('path:');
  });
});
