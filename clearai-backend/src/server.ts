/**
 * Fastify v5 entry. Local dev only — production deployment is Phase 2 (Azure).
 */
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import { env } from './config/env.js';
import { describeRoute } from './routes/describe.js';
import { expandRoute } from './routes/expand.js';
import { boostRoute } from './routes/boost.js';
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
