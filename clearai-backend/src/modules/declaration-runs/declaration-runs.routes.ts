/**
 * Declaration-set endpoints. Routes are thin — delegation lives in
 * declaration-run.controller.ts.
 *
 *   POST   /declaration-runs                     multipart upload, returns 202
 *   GET    /declaration-runs/:id                 DeclarationRunSummary
 *   GET    /declaration-runs/:id/classifications per-item canonical + result + trace
 *   GET    /declaration-runs/:id/declarations    Phase 5 (404 here until landed)
 *   PATCH  /declaration-runs/:id                 cancel
 */
import type { FastifyInstance } from 'fastify';
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

  app.get<{ Params: { id: string } }>('/declaration-runs/:id/classifications', async (req, reply) => {
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
}
