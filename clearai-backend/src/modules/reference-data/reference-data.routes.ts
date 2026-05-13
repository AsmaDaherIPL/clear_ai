import type { FastifyInstance } from 'fastify';
import { db } from '../../db/client.js';
import { tabadulCodes } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { listCurrentFxRates } from './fx.service.js';

export async function registerReferenceDataRoutes(app: FastifyInstance): Promise<void> {
  app.get('/reference-data/currencies', async (_req, reply) => {
    const rows = await db()
      .select({ sourceValue: tabadulCodes.sourceValue })
      .from(tabadulCodes)
      .where(eq(tabadulCodes.codeType, 'currency_code'));

    const currencies = rows.map((r) => r.sourceValue).sort();
    return reply.code(200).send({ currencies });
  });

  // GET /reference-data/fx-rates — current SAR conversion rates (one row per
  // quote currency, most recent at-or-before today). SAR itself is implicit
  // (rate = 1). Consumers should treat any currency not in this list as
  // unsupported — parse will reject items in those currencies.
  app.get('/reference-data/fx-rates', async (_req, reply) => {
    const rates = await listCurrentFxRates();
    return reply.code(200).send({
      base: 'SAR',
      rates: rates.map((r) => ({
        currency: r.quoteCurrency,
        sar_per_unit: r.rate,
        as_of: r.asOfDate,
      })),
    });
  });
}
