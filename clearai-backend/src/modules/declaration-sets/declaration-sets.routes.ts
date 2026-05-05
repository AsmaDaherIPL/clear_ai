/**
 * Declaration-set endpoints. Routes are thin — delegation lives in
 * declaration-set.controller.ts.
 *
 *   POST   /declaration-sets                     multipart upload, returns 202
 *   GET    /declaration-sets/:id                 DeclarationSetSummary
 *   GET    /declaration-sets/:id/classifications per-item canonical + result + trace
 *   GET    /declaration-sets/:id/declarations    Phase 5 (404 here until landed)
 *   PATCH  /declaration-sets/:id                 cancel
 */
import type { FastifyInstance } from 'fastify';
import {
  attachDeclarationSetPlugins,
  handleCreateDeclarationSet,
  handleGetDeclarationSet,
  handleListClassifications,
  handlePatchDeclarationSet,
  mapDeclarationSetError,
} from './declaration-set.controller.js';
import type { DispatchFn } from '../dispatch/dispatch.contract.ts';
import { dispatch as realDispatch } from '../dispatch/dispatch.use-case.js';

export interface DeclarationSetsRoutesOpts {
  /**
   * Dispatch implementation. Defaults to the real 5-stage pipeline shipped
   * by the dispatch-flow agent (modules/dispatch/dispatch.use-case.ts).
   * Tests pass a mock to bypass the LLM.
   */
  dispatch?: DispatchFn;
}

export async function declarationSetsRoutes(app: FastifyInstance, opts?: DeclarationSetsRoutesOpts): Promise<void> {
  await attachDeclarationSetPlugins(app);
  const dispatch = opts?.dispatch ?? realDispatch;

  app.post('/declaration-sets', async (req, reply) => {
    try {
      return await handleCreateDeclarationSet(req, reply, dispatch);
    } catch (err) {
      const mapped = mapDeclarationSetError(err);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/declaration-sets/:id', async (req, reply) => {
    try {
      return await handleGetDeclarationSet(req, reply);
    } catch (err) {
      const mapped = mapDeclarationSetError(err);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/declaration-sets/:id/classifications', async (req, reply) => {
    try {
      return await handleListClassifications(req, reply);
    } catch (err) {
      const mapped = mapDeclarationSetError(err);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
      throw err;
    }
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/declaration-sets/:id', async (req, reply) => {
    try {
      return await handlePatchDeclarationSet(req, reply);
    } catch (err) {
      const mapped = mapDeclarationSetError(err);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
      throw err;
    }
  });
}
