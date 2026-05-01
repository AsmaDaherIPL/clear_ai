/**
 * Global Fastify error handler. Returns the shared decision envelope with
 * status='degraded' and writes a best-effort classification_events row so
 * thrown route dependencies still produce an audit trail.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logEvent } from '../observability/log-event.js';
import { EMBEDDER_VERSION } from '../embeddings/embedder.js';

const CLASSIFY_ENDPOINTS = new Map<string, 'describe' | 'expand'>([
  ['/classifications', 'describe'],
  ['/classifications/expand', 'expand'],
]);

function endpointFor(req: FastifyRequest): 'describe' | 'expand' | null {
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
    return 'unknown';
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(async (err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    const status = (err as FastifyError & { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: err.code ?? 'bad_request', message: err.message });
    }

    const endpoint = endpointFor(req);
    const errMsg = (err.message ?? String(err)).slice(0, 500);
    req.log.error({ err, endpoint }, 'route_failed_before_decision_resolved');

    if (endpoint) {
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

    return reply.code(500).send({ error: 'internal_error', message: err.message });
  });
}
