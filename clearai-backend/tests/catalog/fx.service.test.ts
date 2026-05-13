import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  getPool: vi.fn(),
}));

import { convertToSar, listCurrentFxRates, FxRateMissingError } from '../../src/modules/reference-data/fx.service.js';
import { getPool } from '../../src/db/client.js';

describe('convertToSar', () => {
  const mockQuery = vi.fn();

  beforeEach(() => {
    vi.mocked(getPool).mockReturnValue({
      query: mockQuery,
    } as unknown as ReturnType<typeof getPool>);
    mockQuery.mockReset();
  });

  it('passes through SAR without hitting the DB', async () => {
    const c = await convertToSar(100, 'SAR');
    expect(c.sarAmount).toBe(100);
    expect(c.rate).toBe(1);
    expect(c.rateId).toBe('sar-passthrough');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('converts USD to SAR at the table rate', async () => {
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 'fx-1', rate: '3.75', as_of_date: '2026-05-13', source: 'manual_seed' }],
    });
    const c = await convertToSar(100, 'USD');
    expect(c.sarAmount).toBe(375);
    expect(c.rate).toBe(3.75);
    expect(c.rateAsOf).toBe('2026-05-13');
    expect(c.originalAmount).toBe(100);
    expect(c.originalCurrency).toBe('USD');
  });

  it('rounds SAR amount to 2 decimals', async () => {
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 'fx-1', rate: '3.756789', as_of_date: '2026-05-13', source: 'manual_seed' }],
    });
    const c = await convertToSar(7, 'USD');
    expect(c.sarAmount).toBe(26.3);
  });

  it('uppercases the supplied currency code', async () => {
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 'fx-1', rate: '4.05', as_of_date: '2026-05-13', source: 'manual_seed' }],
    });
    await convertToSar(10, 'eur');
    expect(mockQuery.mock.calls[0]?.[1]?.[0]).toBe('EUR');
  });

  it('throws FxRateMissingError when no rate is on file', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(convertToSar(50, 'XYZ')).rejects.toBeInstanceOf(FxRateMissingError);
  });

  it('throws when the rate row contains an invalid number', async () => {
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 'fx-1', rate: 'NaN', as_of_date: '2026-05-13', source: 'manual_seed' }],
    });
    await expect(convertToSar(50, 'USD')).rejects.toBeInstanceOf(FxRateMissingError);
  });

  it('honours asOfDate override for replay queries', async () => {
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 'fx-1', rate: '3.7', as_of_date: '2025-12-01', source: 'manual_seed' }],
    });
    await convertToSar(100, 'USD', { asOfDate: '2025-12-15' });
    expect(mockQuery.mock.calls[0]?.[1]?.[1]).toBe('2025-12-15');
  });
});

describe('listCurrentFxRates', () => {
  const mockQuery = vi.fn();

  beforeEach(() => {
    vi.mocked(getPool).mockReturnValue({
      query: mockQuery,
    } as unknown as ReturnType<typeof getPool>);
    mockQuery.mockReset();
  });

  it('returns the most recent rate per currency', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { quote_currency: 'AED', rate: '1.02', as_of_date: '2026-05-13' },
        { quote_currency: 'USD', rate: '3.75', as_of_date: '2026-05-13' },
      ],
    });
    const out = await listCurrentFxRates();
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ quoteCurrency: 'AED', rate: 1.02, asOfDate: '2026-05-13' });
  });
});

describe('FxRateMissingError', () => {
  it('carries the missing currency and date for callers to surface', () => {
    const err = new FxRateMissingError('XYZ', '2026-05-13');
    expect(err.code).toBe('fx_rate_missing');
    expect(err.currency).toBe('XYZ');
    expect(err.asOfDate).toBe('2026-05-13');
    expect(err.message).toContain('XYZ');
  });
});
