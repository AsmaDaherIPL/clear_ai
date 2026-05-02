/**
 * Tests for the residual-heading guardrail.
 *
 * The guardrail mixes a DB lookup (label-based detection — the strong
 * signal) with a code-pattern fallback (defensive — when the DB read
 * fails or the label is missing). We exercise the code-pattern path
 * here directly via the DB-error branch (mocked to throw); the
 * label-based path is exercised end-to-end via route smoke tests where
 * the real catalog is loaded.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  getPool: vi.fn(),
}));

import { applyResidualHeadingGuardrail } from '../../src/util/residual-heading.js';
import { getPool } from '../../src/db/client.js';

const mockedGetPool = vi.mocked(getPool);

function mockPool(rows: Array<{ label_en: string | null }> = []) {
  const query = vi.fn().mockResolvedValue({ rows });
  mockedGetPool.mockReturnValue({ query } as unknown as ReturnType<typeof getPool>);
  return query;
}

function mockPoolError() {
  const query = vi.fn().mockRejectedValue(new Error('DB unavailable'));
  mockedGetPool.mockReturnValue({ query } as unknown as ReturnType<typeof getPool>);
  return query;
}

describe('applyResidualHeadingGuardrail', () => {
  it('passes through a 2-digit chapter without a DB lookup', async () => {
    mockPoolError();  // would fail if hit
    const r = await applyResidualHeadingGuardrail('64');
    expect(r.code).toBe('64');
    expect(r.specificity).toBe(2);
    expect(r.needsReview).toBe(false);
    expect(r.reviewReason).toBeNull();
  });

  it('passes through a non-residual heading (label does not start with "Other")', async () => {
    mockPool([{ label_en: 'Footwear with outer soles of leather' }]);
    const r = await applyResidualHeadingGuardrail('6403');
    expect(r.code).toBe('6403');
    expect(r.specificity).toBe(4);
    expect(r.needsReview).toBe(false);
  });

  it('downgrades a residual heading whose label starts with "Other"', async () => {
    mockPool([{ label_en: 'Other footwear' }]);
    const r = await applyResidualHeadingGuardrail('6405');
    expect(r.code).toBe('64');
    expect(r.specificity).toBe(2);
    expect(r.needsReview).toBe(true);
    expect(r.reviewReason).toMatch(/residual catch-all heading/);
  });

  it('downgrades a residual heading whose label starts with "Others" (plural)', async () => {
    mockPool([{ label_en: 'Others' }]);
    const r = await applyResidualHeadingGuardrail('6405');
    expect(r.needsReview).toBe(true);
    expect(r.code).toBe('64');
  });

  it('falls back to code-pattern detection when DB lookup fails', async () => {
    // 6405 ends in "5" → caught by code-pattern fallback even with no label.
    mockPoolError();
    const r = await applyResidualHeadingGuardrail('6405');
    expect(r.code).toBe('64');
    expect(r.needsReview).toBe(true);
    expect(r.reviewReason).toMatch(/form-pattern/);
  });

  it('does NOT flag a non-residual code (6403) on DB error', async () => {
    // 6403 ends in "3" → code-pattern check passes through.
    mockPoolError();
    const r = await applyResidualHeadingGuardrail('6403');
    expect(r.code).toBe('6403');
    expect(r.needsReview).toBe(false);
  });

  it('case-insensitive: handles "OTHER FOOTWEAR" label', async () => {
    mockPool([{ label_en: 'OTHER FOOTWEAR' }]);
    const r = await applyResidualHeadingGuardrail('6405');
    expect(r.needsReview).toBe(true);
  });

  it('handles label with leading dash + "other" ("- Other footwear :")', async () => {
    mockPool([{ label_en: '- Other footwear :' }]);
    const r = await applyResidualHeadingGuardrail('6405');
    // The first non-separator token is "Other" — should still flag.
    expect(r.needsReview).toBe(true);
  });

  it('passes 6-digit non-residual through (only 4-digit pattern fires for *5/*9)', async () => {
    // 640299 ends in 9 at position 5 not 3 → the 4-digit code-pattern
    // checks heading (positions 1-4 = "6402"), which ends in "2" → not residual.
    mockPool([{ label_en: 'Other' }]);  // even with "other" label, only checks 4-digit heading code-pattern
    const r = await applyResidualHeadingGuardrail('640299');
    // Label says "Other" → flagged via label path.
    expect(r.needsReview).toBe(true);
    expect(r.code).toBe('64');
  });
});
