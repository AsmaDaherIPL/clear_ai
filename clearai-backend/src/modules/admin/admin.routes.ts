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
import { lookup as dnsLookup } from 'node:dns/promises';
import { getPool } from '../../db/client.js';
import { env } from '../../config/env.js';

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

  // -------------------------------------------------------------------
  // GET /admin/llm-probe
  //
  // Diagnostic probe added 2026-05-20 to determine why the container's
  // calls to Foundry time out at 15s while identical calls from a
  // laptop succeed in ~2.5s. Captures DNS resolution time, total fetch
  // time, response status, and the first 500 chars of the response
  // body. Cheap to leave in (one extra HTTPS request per call, gated
  // on ADMIN_PROBE_SECRET) — remove once the egress/route issue is
  // diagnosed and fixed.
  //
  // Usage:
  //   curl -H "x-admin-probe-secret: $SECRET" \
  //        "$BASE/admin/llm-probe?model=claude-haiku-4-5-clearai-dev&timeout_ms=20000"
  //
  // The Anthropic POST is constructed identically to the production
  // call-site in src/inference/llm/client.ts — same URL, same auth
  // headers, same body shape — so the result is directly comparable
  // to a real classification request.
  // -------------------------------------------------------------------
  const ProbeQuery = z.object({
    model: z.string().min(1).max(128).optional(),
    timeout_ms: z.coerce.number().int().positive().max(60_000).default(20_000),
    target: z.enum(['anthropic', 'dns_only']).default('anthropic'),
  });

  app.get<{
    Querystring: { model?: string; timeout_ms?: string; target?: string };
    Headers: { 'x-admin-probe-secret'?: string };
  }>('/admin/llm-probe', async (req, reply) => {
    const e = env();
    const expected = process.env.ADMIN_PROBE_SECRET;
    if (!expected) {
      return reply.code(503).send({
        error: {
          code: 'probe_disabled',
          message: 'ADMIN_PROBE_SECRET env var not set; probe is disabled.',
        },
      });
    }
    const provided = req.headers['x-admin-probe-secret'];
    if (provided !== expected) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'Missing or wrong probe secret.' } });
    }

    const parsed = ProbeQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid_query',
          message: 'Query validation failed.',
          details: parsed.error.flatten(),
        },
      });
    }
    const { timeout_ms, target } = parsed.data;
    const model = parsed.data.model ?? e.LLM_MODEL;

    const targetUrl = e.ANTHROPIC_BASE_URL;
    let hostname: string;
    try {
      hostname = new URL(targetUrl).hostname;
    } catch (err) {
      return reply.code(500).send({
        error: { code: 'bad_base_url', message: `ANTHROPIC_BASE_URL is not a URL: ${(err as Error).message}` },
      });
    }

    const dnsStart = Date.now();
    let dns: { addresses: string[]; ms: number; error: string | null };
    try {
      const all = await dnsLookup(hostname, { all: true });
      dns = {
        addresses: all.map((a) => `${a.address} (${a.family === 6 ? 'IPv6' : 'IPv4'})`),
        ms: Date.now() - dnsStart,
        error: null,
      };
    } catch (err) {
      dns = {
        addresses: [],
        ms: Date.now() - dnsStart,
        error: (err as Error).message,
      };
    }

    if (target === 'dns_only' || dns.error) {
      return reply.code(200).send({
        target: targetUrl,
        hostname,
        dns,
        anthropic_attempt: null,
      });
    }

    // Anthropic POST — identical shape to src/inference/llm/client.ts.
    const body = {
      model,
      max_tokens: 32,
      temperature: 0,
      messages: [{ role: 'user', content: 'OK' }],
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout_ms);
    const fetchStart = Date.now();
    let attempt: Record<string, unknown>;
    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${e.ANTHROPIC_API_KEY}`,
          'api-key': e.ANTHROPIC_API_KEY,
          'x-api-key': e.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const ttfb = Date.now() - fetchStart;
      const text = await res.text().catch(() => '');
      attempt = {
        ok: res.ok,
        status: res.status,
        ttfb_ms: ttfb,
        bytes: text.length,
        body_preview: text.slice(0, 500),
        headers: {
          'content-type': res.headers.get('content-type'),
          'x-request-id': res.headers.get('x-request-id'),
          'apim-request-id': res.headers.get('apim-request-id'),
          'x-ms-region': res.headers.get('x-ms-region'),
        },
      };
    } catch (err) {
      clearTimeout(timer);
      const elapsed = Date.now() - fetchStart;
      const e2 = err as { name?: string; message?: string; cause?: { code?: string } };
      attempt = {
        ok: false,
        status: null,
        ttfb_ms: elapsed,
        error_name: e2.name ?? null,
        error_message: e2.message ?? null,
        error_cause_code: e2.cause?.code ?? null,
        aborted: e2.name === 'AbortError',
      };
    }

    return reply.code(200).send({
      target: targetUrl,
      hostname,
      model,
      timeout_ms,
      dns,
      anthropic_attempt: attempt,
    });
  });
}
