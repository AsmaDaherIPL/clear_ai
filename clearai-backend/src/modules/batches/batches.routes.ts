/**
 * Batch endpoints. Routes are thin — delegation lives in batch.controller.ts.
 *
 *   POST   /batches                     multipart upload, returns 202
 *   GET    /batches/:id                 BatchSummary
 *   GET    /batches/:id/classifications per-item canonical + result + trace
 *   GET    /batches/:id/declarations    Phase 5 (404 here until landed)
 *   PATCH  /batches/:id                 cancel
 */
import type { FastifyInstance } from 'fastify';
import {
  attachBatchPlugins,
  handleCreateBatch,
  handleGetBatch,
  handleListClassifications,
  handlePatchBatch,
  mapBatchError,
} from './batch.controller.js';
import type { DispatchFn } from '../dispatch/dispatch.contract.ts';

export interface BatchesRoutesOpts {
  /**
   * Dispatch implementation. The default uses a stub that fails every item
   * with status='failed' until the dispatch agent ships the real one. Tests
   * pass a mock; production code wires the real dispatch.
   */
  dispatch?: DispatchFn;
}

const stubDispatch: DispatchFn = async () => {
  throw new Error('dispatch.use-case is not yet implemented');
};

export async function batchesRoutes(app: FastifyInstance, opts?: BatchesRoutesOpts): Promise<void> {
  await attachBatchPlugins(app);
  const dispatch = opts?.dispatch ?? stubDispatch;

  app.post('/batches', async (req, reply) => {
    try {
      return await handleCreateBatch(req, reply, dispatch);
    } catch (err) {
      const mapped = mapBatchError(err);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/batches/:id', async (req, reply) => {
    try {
      return await handleGetBatch(req, reply);
    } catch (err) {
      const mapped = mapBatchError(err);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/batches/:id/classifications', async (req, reply) => {
    try {
      return await handleListClassifications(req, reply);
    } catch (err) {
      const mapped = mapBatchError(err);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
      throw err;
    }
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/batches/:id', async (req, reply) => {
    try {
      return await handlePatchBatch(req, reply);
    } catch (err) {
      const mapped = mapBatchError(err);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
      throw err;
    }
  });
}
