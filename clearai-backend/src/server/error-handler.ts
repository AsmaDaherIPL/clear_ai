/**
 * Global Fastify error handler.
 *
 * 4xx are passed through to the client with their codes. 5xx are logged
 * server-side via `req.log.error()` (Pino structured logs) and returned
 * to the client as a generic `internal_error` envelope so driver
 * messages, library versions, and stack details aren't leaked.
 *
 * Audit logging for the dispatch pipeline now lives in
 * `pipeline_events` via recordPipelineEvent(). This handler does not
 * write any DB rows — exception paths skip the recorder, and that's
 * fine because the request never produced a usable trace anyway.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(async (err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    const status = (err as FastifyError & { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: err.code ?? 'bad_request', message: err.message });
    }

    req.log.error({ err }, 'route_failed_before_decision_resolved');

    // Phase 2.8: don't leak err.message to the client. Driver errors
    // ("getaddrinfo ENOTFOUND psql-..."), Zod stack traces, library
    // version strings — minor recon signals that aren't worth the
    // generic-5xx readability cost. The full err is already logged above
    // (`req.log.error({ err }, ...)`), so operators retain the detail.
    return reply.code(500).send({ error: 'internal_error' });
  });
}
