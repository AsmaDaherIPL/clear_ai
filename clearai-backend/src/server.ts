/**
 * Fastify v5 entry. Local dev only — production deployment is Phase 2 (Azure).
 */
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env.js';
import { describeRoute } from './routes/describe.js';
import { expandRoute } from './routes/expand.js';
import { boostRoute } from './routes/boost.js';
import { traceRoute } from './routes/trace.js';
import { getPool, closeDb } from './db/client.js';
import { registerErrorHandler } from './server/error-handler.js';

const e = env();

const app = Fastify({
  logger: {
    level: e.LOG_LEVEL,
    ...(e.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', singleLine: true } } }
      : {}),
  },
  bodyLimit: 1 * 1024 * 1024,
});

await app.register(sensible);

// CORS — explicit allowlist from env (CORS_ORIGINS, comma-separated). We
// reflect the matched origin rather than echoing `*`, so future cookie/JWT
// auth doesn't break. Preflight returns 204; the same allowlist gates the
// actual POST that follows.
await app.register(cors, {
  origin: e.CORS_ORIGINS,
  methods: ['GET', 'POST', 'OPTIONS'],
  // No credentials yet (no cookie/JWT auth) — flip on when that lands.
  credentials: false,
  // APIM forwards this header on every request; allow it in preflight so
  // the browser doesn't trip on it after the env-var flip lands.
  allowedHeaders: ['content-type', 'x-apim-shared-secret', 'ocp-apim-subscription-key'],
});

// In-process per-IP rate limit — defence-in-depth alongside the APIM
// rate-limit policy. The two layers are intentional: APIM's limit can
// be bypassed by anyone who guesses the Container App FQDN, but the
// shared-secret hook below blocks them at 401 long before this matters.
// This limiter mostly exists to absorb runaway-script bursts from a
// legitimate APIM-fronted client where the per-IP fairness still applies.
await app.register(rateLimit, {
  max: e.RATE_LIMIT_MAX,
  timeWindow: e.RATE_LIMIT_WINDOW,
  // Don't rate-limit /health — Container Apps and APIM probes should
  // never get 429'd or the replica gets marked unhealthy and recycled.
  allowList: (req) => req.url.startsWith('/health'),
});

// Origin lock — every non-health request must carry the shared secret
// that APIM injects via inbound policy. Direct curls to the Container
// App FQDN (which is publicly hittable on Consumption tier — no VNet)
// fail closed with 401.
//
// Behaviour matrix:
//   NODE_ENV=production + secret unset  → fail closed (401 on everything,
//                                          loud signal that the wire-up
//                                          is broken; better than
//                                          silently allowing all traffic)
//   NODE_ENV=production + secret set    → enforce match
//   NODE_ENV=development                → bypass entirely (local dev
//                                          shouldn't need APIM)
//   /health on any env                  → always allowed (probe path)
app.addHook('onRequest', async (req, reply) => {
  if (req.url.startsWith('/health')) return;
  if (e.NODE_ENV !== 'production') return;

  const expected = e.APIM_SHARED_SECRET;
  const provided = req.headers['x-apim-shared-secret'];

  if (!expected) {
    req.log.error('APIM_SHARED_SECRET not set in production — blocking all non-health traffic');
    return reply.code(401).send({
      error: { code: 'origin_access_denied', message: 'gateway not configured' },
    });
  }
  if (provided !== expected) {
    return reply.code(401).send({
      error: { code: 'origin_access_denied', message: 'request did not come through the APIM gateway' },
    });
  }
});

// Global error handler — must be registered BEFORE the routes so any throw
// during route handling (incl. async dependency failures like loadThresholds())
// is mapped to the shared decision envelope rather than a generic 500.
// See src/server/error-handler.ts for the full rationale.
registerErrorHandler(app);

app.get('/health', async () => {
  // Cheap PG ping
  try {
    const r = await getPool().query<{ ok: number }>(`SELECT 1::int AS ok`);
    return { status: 'ok', db: r.rows[0]?.ok === 1 };
  } catch (err) {
    app.log.error({ err }, 'health PG fail');
    return { status: 'degraded', db: false };
  }
});

await app.register(describeRoute);
await app.register(expandRoute);
await app.register(boostRoute);
await app.register(traceRoute);

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: e.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await closeDb();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'shutdown error');
    process.exit(1);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void start();
