/**
 * Declaration-set endpoints. Routes are thin — delegation lives in
 * declaration-run.controller.ts.
 *
 *   POST   /declaration-runs                       multipart upload, returns 202
 *   GET    /declaration-runs/:id                   DeclarationRunSummary
 *   GET    /declaration-runs/:id/classifications   per-item canonical + result + trace
 *   GET    /declaration-runs/:id/declarations      Phase 5 (404 here until landed)
 *   GET    /declaration-runs/:id/download-links    short-lived SAS URLs for the run's blobs
 *   GET    /declaration-runs/:id/files/*           stream a single blob through the backend
 *   PATCH  /declaration-runs/:id                   cancel
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  attachDeclarationRunPlugins,
  handleCreateDeclarationRun,
  handleGetDeclarationRun,
  handleListClassifications,
  handlePatchDeclarationRun,
  mapDeclarationRunError,
} from './declaration-run.controller.js';
import type { DispatchFn } from '../dispatch/dispatch.contract.ts';
import { dispatch as realDispatch } from '../dispatch/dispatch.use-case.js';
import { getPool } from '../../db/client.js';
import { getBlobClient } from '../../storage/blob.client.js';
import { BlobNotFoundError } from '../../storage/blob.types.js';

export interface DeclarationRunsRoutesOpts {
  /**
   * Dispatch implementation. Defaults to the real 5-stage pipeline shipped
   * by the dispatch-flow agent (modules/dispatch/dispatch.use-case.ts).
   * Tests pass a mock to bypass the LLM.
   */
  dispatch?: DispatchFn;
}

export async function declarationRunsRoutes(app: FastifyInstance, opts?: DeclarationRunsRoutesOpts): Promise<void> {
  await attachDeclarationRunPlugins(app);
  const dispatch = opts?.dispatch ?? realDispatch;

  app.post('/declaration-runs', async (req, reply) => {
    try {
      return await handleCreateDeclarationRun(req, reply, dispatch);
    } catch (err) {
      const mapped = mapDeclarationRunError(err);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/declaration-runs/:id', async (req, reply) => {
    try {
      return await handleGetDeclarationRun(req, reply);
    } catch (err) {
      const mapped = mapDeclarationRunError(err);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
      throw err;
    }
  });

  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; offset?: string };
  }>('/declaration-runs/:id/classifications', async (req, reply) => {
    try {
      return await handleListClassifications(req, reply);
    } catch (err) {
      const mapped = mapDeclarationRunError(err);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
      throw err;
    }
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/declaration-runs/:id', async (req, reply) => {
    try {
      return await handlePatchDeclarationRun(req, reply);
    } catch (err) {
      const mapped = mapDeclarationRunError(err);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
      throw err;
    }
  });

  // -------------------------------------------------------------------
  // Blob read endpoints
  // -------------------------------------------------------------------
  // Both rely on declaration_runs.blob_prefix (added in 0061). Runs
  // created before that migration ran will not have a prefix and
  // return 404 here — they're served via the legacy declarations
  // listing path until backfill (out of scope for now).
  //
  // SECURITY POSTURE (current — Layer A: immediate hardening only):
  //
  // These endpoints are reachable to any caller with a valid Entra JWT
  // (APIM enforces validate-jwt on the outer policy). What they're NOT
  // doing yet:
  //   - per-user ownership check    (no `created_by_oid` column exists)
  //   - per-operator scope check    (caller's allowed operators not modelled)
  //   - per-tenant scope check      (single-tenant deployment today)
  //
  // Net consequence: anyone with a valid token who learns or guesses a
  // declaration_run_id can pull SAS URLs for that run's input.csv (raw
  // commercial-invoice data: HS codes, values, consignee names, mobiles,
  // national IDs).
  //
  // What Layer A *does* do, right here, right now:
  //   1. ID format check enforces UUIDv7 shape (timestamp-prefixed). UUIDv7
  //      has 74 random bits in the entropy region, so blind guessing is
  //      computationally infeasible. Sequential id enumeration is also
  //      infeasible (the random tail is per-row). Attacker still wins if
  //      they exfiltrate a real id from logs / a screenshot / another bug.
  //   2. Path-traversal guard on the relative path component below.
  //   3. SAS URLs are scoped to a single blob (not a wildcard prefix) and
  //      expire in 5 minutes (SAS_TTL_MS), limiting replay window.
  //
  // What Layer B (separate task — handover brief in tracker):
  //   1. Add `created_by_oid text NULL` to `declaration_runs` (Drizzle
  //      migration 0062 or next).
  //   2. JWT verification middleware: parse `Authorization: Bearer ...`,
  //      verify signature against Entra JWKS, attach `req.user.oid` and
  //      `req.user.preferred_username` to the request.
  //   3. POST /declaration-runs stamps `created_by_oid` from req.user.oid.
  //   4. Both endpoints below add `AND created_by_oid = $2` (with an admin
  //      role bypass for support).
  //   5. Backfill choice: NULL == "legacy, anyone-can-download" OR assign
  //      all existing rows to the operator's primary oid. Decision deferred
  //      until Layer B starts.
  //
  // Tracker brief: tracker/AGENT_BRIEFS/backend-agent-download-authz-2026-05-09.md

  // UUIDv7 strict matcher: 8-4-4-4-12 hex with version nibble = 7.
  // Standard z.uuid() accepts v1/v4/v7 etc. — we narrow to the version
  // we actually mint, so callers can't slip a guessable v1 (MAC + ts).
  const UuidV7Schema = z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, {
      message: 'id must be a UUIDv7',
    });

  // 5-minute SAS expiry. Long enough for the SPA to start parallel
  // downloads and for slow networks; short enough to limit replay.
  const SAS_TTL_MS = 5 * 60 * 1000;

  app.get<{ Params: { id: string } }>('/declaration-runs/:id/download-links', async (req, reply) => {
    const idParse = UuidV7Schema.safeParse(req.params.id);
    if (!idParse.success) {
      return reply.code(400).send({ error: { code: 'invalid_id', message: 'id must be a UUIDv7.' } });
    }

    const pool = getPool();
    const r = await pool.query<{ id: string; blob_prefix: string | null }>(
      `SELECT id, blob_prefix FROM declaration_runs WHERE id = $1 LIMIT 1`,
      [idParse.data],
    );
    if (r.rowCount === 0) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'declaration_run not found' } });
    }
    const row = r.rows[0]!;
    if (!row.blob_prefix) {
      return reply
        .code(409)
        .send({ error: { code: 'no_blob_prefix', message: 'Run has no blob output yet (legacy or unfinished).' } });
    }

    const blob = getBlobClient();
    const items = await blob.list(row.blob_prefix);
    if (items.length === 0) {
      return reply.code(404).send({ error: { code: 'no_files', message: 'No files under run prefix.' } });
    }

    const files = await Promise.all(
      items.map(async (item) => {
        const sas = await blob.getReadSasUrl(item.key, SAS_TTL_MS);
        return {
          name: item.key.startsWith(`${row.blob_prefix}/`)
            ? item.key.slice(row.blob_prefix!.length + 1)
            : item.key,
          url: sas.url,
          sizeBytes: item.sizeBytes,
          contentType: item.contentType,
        };
      }),
    );

    return reply.code(200).send({
      runId: row.id,
      expiresAt: new Date(Date.now() + SAS_TTL_MS).toISOString(),
      files,
    });
  });

  app.get<{ Params: { id: string; '*': string } }>(
    '/declaration-runs/:id/files/*',
    async (req, reply) => {
      const idParse = UuidV7Schema.safeParse(req.params.id);
      if (!idParse.success) {
        return reply.code(400).send({ error: { code: 'invalid_id', message: 'id must be a UUIDv7.' } });
      }
      // Path-traversal hardening:
      //   - reject empty
      //   - reject any '..' segment (handles "../", "x/../y", URL-encoded
      //     decodes done by Fastify before this point — Fastify's wildcard
      //     route gives us the already-decoded path, so '..' is the only
      //     literal we need to look for here).
      //   - reject leading '/' (would let a caller bypass the prefix join)
      //   - reject backslash (Windows-style path injection on the blob name)
      const relPath = req.params['*'];
      if (!relPath || relPath.startsWith('/') || relPath.includes('..') || relPath.includes('\\')) {
        return reply.code(400).send({ error: { code: 'invalid_path', message: 'Bad relative path.' } });
      }

      const pool = getPool();
      const r = await pool.query<{ blob_prefix: string | null }>(
        `SELECT blob_prefix FROM declaration_runs WHERE id = $1 LIMIT 1`,
        [idParse.data],
      );
      if (r.rowCount === 0 || !r.rows[0]?.blob_prefix) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'declaration_run not found' } });
      }

      const key = `${r.rows[0]!.blob_prefix}/${relPath}`;
      const blob = getBlobClient();
      try {
        const buf = await blob.get(key);
        const contentType =
          relPath.endsWith('.xml')
            ? 'application/xml'
            : relPath.endsWith('.json')
              ? 'application/json'
              : 'application/octet-stream';
        reply.header('content-type', contentType);
        reply.header(
          'content-disposition',
          `attachment; filename="${relPath.split('/').pop() ?? 'file'}"`,
        );
        return reply.send(buf);
      } catch (err) {
        if (err instanceof BlobNotFoundError) {
          return reply.code(404).send({ error: { code: 'not_found', message: 'file not found in run' } });
        }
        throw err;
      }
    },
  );
}
