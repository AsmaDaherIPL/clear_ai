/**
 * Operational read endpoints for ClearAI infra observability.
 *
 *   GET /admin/llm-call-metrics?since_minutes=N&stage=picker
 *
 *     Aggregated counters for the Foundry LLM transport, sourced from
 *     `llm_call_metrics`. Returns per-stage call counts, outcome-class
 *     rates, and latency percentiles. Percentiles are computed in SQL
 *     via percentile_cont — never client-side; the table is indexed on
 *     (ts DESC) and (stage, ts DESC) so a 24h window stays cheap.
 *
 * Auth: standard APIM shared-secret + Entra JWT enforced by the
 * gateway. No additional checks in-app.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../../db/client.js';

const LlmMetricsQuery = z.object({
  since_minutes: z.coerce.number().int().positive().max(1440).default(60),
  stage: z.string().min(1).max(64).optional(),
});

interface AggregateRow {
  stage: string;
  calls: string;
  ok: string;
  auth_class: string;
  transient: string;
  other: string;
  p50_latency_ms: string | null;
  p95_latency_ms: string | null;
}

interface StageAggregate {
  calls: number;
  ok_rate: number;
  auth_class_rate: number;
  transient_rate: number;
  other_rate: number;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
}

function safeRate(numer: number, denom: number): number {
  if (denom === 0) return 0;
  return Number((numer / denom).toFixed(4));
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { since_minutes?: string; stage?: string } }>(
    '/admin/llm-call-metrics',
    async (req, reply) => {
      const parsed = LlmMetricsQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: 'invalid_query',
            message: 'Query validation failed.',
            details: parsed.error.flatten(),
          },
        });
      }
      const { since_minutes, stage } = parsed.data;

      const until = new Date();
      const since = new Date(until.getTime() - since_minutes * 60_000);

      const params: unknown[] = [since.toISOString()];
      let stageFilter = '';
      if (stage) {
        params.push(stage);
        stageFilter = ` AND stage = $${params.length}`;
      }

      const sql = `
        SELECT
          stage,
          COUNT(*)::bigint                                                AS calls,
          COUNT(*) FILTER (WHERE outcome_class = 'ok')::bigint             AS ok,
          COUNT(*) FILTER (WHERE outcome_class = 'auth_class')::bigint     AS auth_class,
          COUNT(*) FILTER (WHERE outcome_class = 'transient')::bigint      AS transient,
          COUNT(*) FILTER (WHERE outcome_class = 'other')::bigint          AS other,
          percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_ms)         AS p50_latency_ms,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)         AS p95_latency_ms
        FROM llm_call_metrics
        WHERE ts >= $1${stageFilter}
        GROUP BY stage
        ORDER BY stage
      `;

      const result = await getPool().query<AggregateRow>(sql, params);

      const by_stage: Record<string, StageAggregate> = {};
      let total_calls = 0;
      for (const row of result.rows) {
        const calls = Number(row.calls);
        total_calls += calls;
        by_stage[row.stage] = {
          calls,
          ok_rate: safeRate(Number(row.ok), calls),
          auth_class_rate: safeRate(Number(row.auth_class), calls),
          transient_rate: safeRate(Number(row.transient), calls),
          other_rate: safeRate(Number(row.other), calls),
          p50_latency_ms: row.p50_latency_ms === null ? null : Math.round(Number(row.p50_latency_ms)),
          p95_latency_ms: row.p95_latency_ms === null ? null : Math.round(Number(row.p95_latency_ms)),
        };
      }

      return reply.code(200).send({
        since: since.toISOString(),
        until: until.toISOString(),
        total_calls,
        by_stage,
      });
    },
  );
}
