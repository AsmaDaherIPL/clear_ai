/**
 * Tests for the procedures-codes catalog helper.
 *
 * Post-0031: `parseProceduresField` is removed (procedures column is now
 * text[] in PG, no parsing needed). `lookupProcedures` accepts string[]
 * directly + still tolerates legacy comma-string inputs for transitional
 * callers; the back-compat string overload is what these tests exercise.
 *
 * lookupProcedures hits the real DB in production but is unit-tested here
 * via a mocked pool to avoid pulling the test DB into this module.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  getPool: vi.fn(),
}));

import { lookupProcedures } from '../../src/catalog/procedure-codes.js';
import { getPool } from '../../src/db/client.js';

describe('lookupProcedures', () => {
  const mockQuery = vi.fn();

  beforeEach(() => {
    vi.mocked(getPool).mockReturnValue({
      query: mockQuery,
    } as unknown as ReturnType<typeof getPool>);
    mockQuery.mockReset();
  });

  it('returns [] for null/empty input without hitting the DB', async () => {
    const out = await lookupProcedures(null);
    expect(out).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('resolves codes against the lookup table preserving input order', async () => {
    // DB returns rows in arbitrary order — helper must restore the
    // input order ("28" before "2") so the most-blocking procedure
    // shows first on the result card.
    mockQuery.mockResolvedValue({
      rows: [
        { code: '2', description_ar: 'موافقة وزارة البيئة', is_repealed: false },
        { code: '28', description_ar: 'موافقة تصدير المواشي', is_repealed: false },
      ],
    });
    const out = await lookupProcedures('28,2');
    expect(out.map((p) => p.code)).toEqual(['28', '2']);
    expect(out[0]!.description_ar).toBe('موافقة تصدير المواشي');
  });

  it('skips codes missing from the lookup table and warn-logs them', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ code: '2', description_ar: 'موافقة', is_repealed: false }],
    });
    const warn = vi.fn();
    const out = await lookupProcedures('2,99', { warn });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe('2');
    expect(warn).toHaveBeenCalledOnce();
    const [obj, msg] = warn.mock.calls[0]!;
    expect(obj).toMatchObject({ missing_procedure_codes: ['99'], raw_input: '2,99' });
    expect(msg).toMatch(/missing rows/);
  });

  it('does not warn when no codes are missing', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ code: '2', description_ar: 'x', is_repealed: false }],
    });
    const warn = vi.fn();
    await lookupProcedures('2', { warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns is_repealed flag from DB row verbatim', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { code: '5', description_ar: 'تعرض على الحجر الصحي (ملغي)', is_repealed: true },
      ],
    });
    const out = await lookupProcedures('5');
    expect(out[0]!.is_repealed).toBe(true);
  });

  it('queries with code = ANY array binding (not N+1)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await lookupProcedures('2,28,61');
    expect(mockQuery).toHaveBeenCalledOnce();
    const [, params] = mockQuery.mock.calls[0]!;
    expect(params).toEqual([['2', '28', '61']]);
  });
});
