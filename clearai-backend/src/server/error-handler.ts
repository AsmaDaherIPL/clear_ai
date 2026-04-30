/**
 * Global Fastify error handler — preserves the shared decision contract for
 * operational failures.
 *
 * Without this, route dependencies that throw synchronously (or return rejected
 * promises) bypass the contract entirely:
 *   - `loadThresholds()` throws fail-closed when `setup_meta` is misconfigured
 *     (ADR-0009).
 *   - prompt file reads (`gir-system.md`, `picker-*.md`) can fail.
 *   - the embedder's first call can fail to load the ONNX model.
 *   - the Postgres pool can throw at acquire time during a brief outage.
 * In all those cases Fastify's default would emit a generic `{ statusCode: 500,
 * error: 'Internal Server Error' }` body and **no `classification_events` row
 * would land** — exactly the moment operators most need the audit trail.
 *
 * This handler:
 *   1. Returns the shared envelope shape (`decision_status`, `decision_reason`,
 *      `model: { embedder, llm }`) with `status='degraded'` /
 *      `reason='llm_unavailable'`. We reuse the closed enum rather than adding
 *      a new reason — by definition, when a precondition for classification
 *      fails, the LLM did not get called.
 *   2. Best-effort writes a `classification_events` row tagged with the same
 *      values plus the truncated error message. Never throws from the handler
 *      itself: if even the log-event insert fails (e.g. DB is down), we just
 *      log to the Fastify logger and move on.
 *   3. Keeps Fastify's built-in 400 handling for Zod validation errors that
 *      bubble out of the route bodies — those still come back as
 *      `{error:'invalid_body', detail:...}` from the routes themselves, before
 *      any throw, so they never reach this handler.
 *   4. Replies with HTTP 503 (Service Unavailable) so batch consumers can
 *      cleanly distinguish operational degradation from a 200 OK
 *      `needs_clarification` outcome.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logEvent } from '../observability/log-event.js';
import { EMBEDDER_VERSION } from '../embeddings/embedder.js';

// Maps URL paths → the persisted `endpoint` enum on classification_events.
// We keep the persisted enum stable ('describe' / 'expand') even after the
// 2026 URL refactor so historical trace queries don't need a UNION.
const CLASSIFY_ENDPOINTS = new Map<string, 'describe' | 'expand'>([
  ['/classifications', 'describe'],
  ['/classifications/expand', 'expand'],
]);

function endpointFor(req: FastifyRequest): 'describe' | 'expand' | null {
  // Strip query string and trailing slash defensively.
  const path = (req.url ?? '').split('?')[0]?.replace(/\/+$/, '') ?? '';
  return CLASSIFY_ENDPOINTS.get(path) ?? null;
}

function envelope(): {
  decision_status: 'degraded';
  decision_reason: 'llm_unavailable';
  alternatives: never[];
  model: { embedder: string; llm: null };
} {
  return {
    decision_status: 'degraded',
    decision_reason: 'llm_unavailable',
    alternatives: [],
    model: { embedder: safeEmbedderVersion(), llm: null },
  };
}

function safeEmbedderVersion(): string {
  try {
    return EMBEDDER_VERSION();
  } catch {
    // env() can throw at very early startup; degrade to a stable sentinel.
    return 'unknown';
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(async (err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    // Fastify's own validation errors (e.g. JSON parse) carry a statusCode in 4xx.
    // We pass those through unchanged so the client still gets a 400, not a 503.
    const status = (err as FastifyError & { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: err.code ?? 'bad_request', message: err.message });
    }

    const endpoint = endpointFor(req);
    const errMsg = (err.message ?? String(err)).slice(0, 500);
    req.log.error({ err, endpoint }, 'route_failed_before_decision_resolved');

    if (endpoint) {
      // Best-effort audit log. Swallow any failure — we are already in the
      // error path and must not throw from the error handler.
      logEvent({
        endpoint,
        request: (req.body as unknown) ?? null,
        languageDetected: null,
        decisionStatus: 'degraded',
        decisionReason: 'llm_unavailable',
        confidenceBand: null,
        chosenCode: null,
        alternatives: [],
        topRetrievalScore: null,
        top2Gap: null,
        candidateCount: null,
        branchSize: null,
        llmUsed: false,
        llmStatus: null,
        guardTripped: false,
        modelCalls: null,
        embedderVersion: safeEmbedderVersion(),
        llmModel: null,
        totalLatencyMs: 0,
        error: errMsg,
        rationale: null,
      }).catch((logErr) => req.log.error({ logErr }, 'logEvent failed in error handler'));

      return reply.code(503).send(envelope());
    }

    // Non-classify route (e.g. /health). Keep the default behaviour.
    return reply.code(500).send({ error: 'internal_error', message: err.message });
  });
}
