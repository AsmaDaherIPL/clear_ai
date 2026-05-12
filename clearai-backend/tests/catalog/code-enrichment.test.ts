import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  getPool: vi.fn(),
}));

import { enrichCodes, enrichCode } from '../../src/modules/reference-data/code-enrichment.service.js';
import { getPool } from '../../src/db/client.js';

describe('enrichCodes', () => {
  const mockQuery = vi.fn();

  beforeEach(() => {
    vi.mocked(getPool).mockReturnValue({
      query: mockQuery,
    } as unknown as ReturnType<typeof getPool>);
    mockQuery.mockReset();
  });

  it('returns empty map for empty input without hitting the DB', async () => {
    const out = await enrichCodes([]);
    expect(out.size).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns empty map when all inputs are null', async () => {
    const out = await enrichCodes([null, null]);
    expect(out.size).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('deduplicates codes before querying', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // hs_codes
    await enrichCodes(['851830000000', '851830000000', '851830000000']);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][1]).toEqual([['851830000000']]);
  });

  it('shapes duty_info from rate row', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { code: '851830000000', duty_rate_pct: '5', duty_status: 'rate', procedures: null },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // no procedures to look up
    const out = await enrichCodes(['851830000000']);
    expect(out.get('851830000000')).toEqual({
      duty_info: { rate_percent: 5, status: null },
      procedures: [],
    });
  });

  it('shapes duty_info from exemption row', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { code: '851830000000', duty_rate_pct: null, duty_status: 'exempted', procedures: null },
      ],
    });
    const out = await enrichCodes(['851830000000']);
    expect(out.get('851830000000')).toEqual({
      duty_info: { rate_percent: null, status: 'exempted' },
      procedures: [],
    });
  });

  it('returns null duty_info when row has no duty data', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { code: '851830000000', duty_rate_pct: null, duty_status: null, procedures: null },
      ],
    });
    const out = await enrichCodes(['851830000000']);
    expect(out.get('851830000000')?.duty_info).toBeNull();
  });

  it('looks up procedures and preserves per-code order', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { code: '851830000000', duty_rate_pct: null, duty_status: null, procedures: ['28', '2'] },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { code: '2', description_ar: 'two', is_repealed: false },
          { code: '28', description_ar: 'twenty-eight', is_repealed: false },
        ],
      });
    const out = await enrichCodes(['851830000000']);
    expect(out.get('851830000000')?.procedures.map((p) => p.code)).toEqual(['28', '2']);
  });

  it('enrichCode returns empty defaults when code is null', async () => {
    const out = await enrichCode(null);
    expect(out).toEqual({ duty_info: null, procedures: [] });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('enrichCode hits DB when code is non-null', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { code: '851830000000', duty_rate_pct: '15', duty_status: 'rate', procedures: null },
        ],
      });
    const out = await enrichCode('851830000000');
    expect(out.duty_info).toEqual({ rate_percent: 15, status: null });
    expect(out.procedures).toEqual([]);
  });

  it('returns empty defaults for codes not in hs_codes', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const out = await enrichCodes(['999999999999']);
    expect(out.size).toBe(0);
  });
});
