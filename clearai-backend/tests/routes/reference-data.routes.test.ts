import { describe, expect, it, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../../src/db/client.js', () => {
  return {
    db: vi.fn(),
    getPool: vi.fn(),
  };
});

import { registerReferenceDataRoutes } from '../../src/modules/reference-data/reference-data.routes.js';
import { db } from '../../src/db/client.js';

function mockDbReturning<T>(rows: T[]): void {
  vi.mocked(db).mockReturnValue({
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  } as unknown as ReturnType<typeof db>);
}

describe('GET /reference-data/currencies', () => {
  beforeEach(() => {
    vi.mocked(db).mockReset();
  });

  it('returns currencies sorted alphabetically', async () => {
    mockDbReturning([
      { sourceValue: 'USD' },
      { sourceValue: 'AED' },
      { sourceValue: 'SAR' },
      { sourceValue: 'EUR' },
    ]);

    const app = Fastify();
    await app.register(registerReferenceDataRoutes);

    const res = await app.inject({ method: 'GET', url: '/reference-data/currencies' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ currencies: ['AED', 'EUR', 'SAR', 'USD'] });
    await app.close();
  });

  it('returns empty array when no currencies are seeded', async () => {
    mockDbReturning([]);
    const app = Fastify();
    await app.register(registerReferenceDataRoutes);

    const res = await app.inject({ method: 'GET', url: '/reference-data/currencies' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ currencies: [] });
    await app.close();
  });
});
