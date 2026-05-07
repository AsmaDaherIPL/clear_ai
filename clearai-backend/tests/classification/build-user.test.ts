/**
 * Picker user-message format tests.
 *
 * The picker prompt has one canonical layout: per candidate, emit
 *   N. code=<12-digit>
 *      path_en: <breadcrumb ending with leaf's own EN label>
 *      path_ar: <breadcrumb ending with leaf's own AR label>
 *
 * `path_en` / `path_ar` are produced by ingest-zatca-hs-code-display.ts as
 * a single comma-joined sentence (en: ", " — ar: "، "), so the last segment
 * after the final separator IS the leaf's own description. We deliberately
 * do NOT emit a separate `description_en`/`description_ar` block — that
 * data is already the tail of the path.
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

const candidates: Candidate[] = [
  cand({
    code: '150910100000',
    description_en: 'Virgin olive oil',
    description_ar: 'زيت زيتون بكر',
    path_en: 'Olive oil and its fractions, Virgin olive oil',
    path_ar: 'زيت زيتون ومجزآته، زيت زيتون بكر',
    path_codes: ['150900000000', '150910100000'],
  }),
  cand({
    code: '151000100000',
    description_en: 'Crude',
    description_ar: 'خام',
    path_en: 'Other oils obtained solely from olives, Crude',
    path_ar: 'زيوت أخرى محضرة من الزيتون، خام',
    path_codes: ['151000000000', '151000100000'],
  }),
];

describe('buildUser — picker prompt format', () => {
  it('emits a numbered list with path_en + path_ar per candidate', () => {
    const out = buildUser('olive oil', candidates);
    expect(out).toContain('User description:\nolive oil');
    expect(out).toContain('1. code=150910100000');
    expect(out).toContain('   path_en: Olive oil and its fractions, Virgin olive oil');
    expect(out).toContain('   path_ar: زيت زيتون ومجزآته، زيت زيتون بكر');
    expect(out).toContain('2. code=151000100000');
    expect(out).toContain('   path_en: Other oils obtained solely from olives, Crude');
  });

  it('does NOT emit separate `description_en` / `description_ar` lines', () => {
    const out = buildUser('olive oil', candidates);
    expect(out).not.toContain('description_en:');
    expect(out).not.toContain('description_ar:');
    expect(out).not.toMatch(/^\s+en:/m);
    expect(out).not.toMatch(/^\s+ar:/m);
  });

  it('does NOT emit Heading group headers', () => {
    const out = buildUser('olive oil', candidates);
    expect(out).not.toMatch(/^Heading \d{4}/m);
  });

  it('does NOT emit the legacy `path:` breadcrumb-with-arrows line', () => {
    const out = buildUser('olive oil', candidates);
    expect(out).not.toContain('path:'); // path_en / path_ar yes, bare "path:" no
    expect(out).not.toContain(' › '); // legacy mode-2 separator
    expect(out).not.toContain(' > '); // legacy storage separator
  });

  it('handles parentPrefix when provided', () => {
    const out = buildUser('olive oil', candidates, '1509');
    expect(out.startsWith('Declared parent prefix: 1509')).toBe(true);
  });

  it('falls back to description_en/ar as path_en/ar when path data is missing', () => {
    const orphan: Candidate[] = [
      cand({
        code: '999999000000',
        description_en: 'Orphan leaf',
        description_ar: 'ورقة يتيمة',
        path_en: '',
        path_ar: '',
        path_codes: [],
      }),
    ];
    const out = buildUser('orphan', orphan);
    expect(out).toContain('1. code=999999000000');
    // Defensive fallback: when LEFT JOIN to display missed, emit raw labels
    // under the path_en/ar keys so the picker still sees something.
    expect(out).toContain('   path_en: Orphan leaf');
    expect(out).toContain('   path_ar: ورقة يتيمة');
  });

  it('emits "(none)" when path data is missing AND descriptions are null', () => {
    const empty: Candidate[] = [
      cand({
        code: '888888000000',
        description_en: null,
        description_ar: null,
        path_en: '',
        path_ar: '',
      }),
    ];
    const out = buildUser('empty', empty);
    expect(out).toContain('1. code=888888000000');
    expect(out).toContain('   path_en: (none)');
    expect(out).toContain('   path_ar: (none)');
  });
});
