import type { FastifyInstance } from 'fastify';
import { db } from '../../db/client.js';
import { tabadulCodes } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

export async function registerReferenceDataRoutes(app: FastifyInstance): Promise<void> {
  app.get('/reference-data/currencies', async (_req, reply) => {
    const rows = await db()
      .select({ sourceValue: tabadulCodes.sourceValue })
      .from(tabadulCodes)
      .where(eq(tabadulCodes.codeType, 'currency_code'));

    const currencies = rows.map((r) => r.sourceValue).sort();
    return reply.code(200).send({ currencies });
  });
}
