/**
 * GET /batches — handler-level tests for the list endpoint.
 *
 * Mocks the repository so the test runs without a DB. Covers:
 *   - pagination bounds (limit + offset validation)
 *   - status comma-list parsing + whitelist
 *   - ISO-8601 date parsing + ordering invariant
 *   - response envelope shape (items, total, has_more, next_offset)
 *
 * Does NOT cover the repo SQL itself — that's exercised by the
 * integration tests against a real Postgres (DB-backed, gated on
 * DATABASE_URL like the rest of the declaration-runs suite).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listBatchesMock = vi.fn();
vi.mock(
  '../../src/modules/declaration-runs/declaration-run.repository.js',
  () => ({
    listBatches: (...args: unknown[]) => listBatchesMock(...args),
    // The controller imports these too — stub them so the module loads.
    cancelBatchIfActive: vi.fn(),
    countItemsByStatus: vi.fn(),
    getBatch: vi.fn(),
  }),
);

import { handleListBatches } from '../../src/modules/declaration-runs/declaration-run.controller.js';
import { BatchValidationError } from '../../src/modules/declaration-runs/declaration-run.errors.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

function buildReply() {
  const sent: { body?: unknown; code?: number } = {};
  const reply: Partial<FastifyReply> = {
    send: (body: unknown) => {
      sent.body = body;
      return reply as FastifyReply;
    },
    code: (n: number) => {
      sent.code = n;
      return reply as FastifyReply;
    },
  };
  return { reply: reply as FastifyReply, sent };
}

function buildReq(query: Record<string, string | undefined>) {
  return { query } as unknown as FastifyRequest<{ Querystring: Record<string, string | undefined> }>;
}

const sampleRow = {
  id: '019e2ba9-05fe-7c25-a897-a9cc44fb1672',
  operatorSlug: 'naqel',
  mode: 'classify_only' as const,
  status: 'processing' as const,
  classificationStatus: 'running' as const,
  declarationStatus: null,
  rowCount: 30,
  createdAt: new Date('2026-05-15T12:42:38.061Z'),
  startedAt: new Date('2026-05-15T12:42:38.061Z'),
  completedAt: null,
  error: null,
};

beforeEach(() => {
  listBatchesMock.mockReset();
});

describe('handleListBatches — pagination', () => {
  it('returns the slim wire shape on a successful page', async () => {
    listBatchesMock.mockResolvedValueOnce({ items: [sampleRow], total: 1 });
    const { reply, sent } = buildReply();
    await handleListBatches(buildReq({}), reply);
    expect(sent.body).toMatchObject({
      items: [
        {
          id: '019e2ba9-05fe-7c25-a897-a9cc44fb1672',
          operator_slug: 'naqel',
          mode: 'classify_only',
          status: 'processing',
          classification_status: 'running',
          declaration_status: null,
          row_count: 30,
          created_at: '2026-05-15T12:42:38.061Z',
          started_at: '2026-05-15T12:42:38.061Z',
          completed_at: null,
          error: null,
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
      has_more: false,
      next_offset: null,
    });
  });

  it('defaults limit=50 and offset=0 when neither is provided', async () => {
    listBatchesMock.mockResolvedValueOnce({ items: [], total: 0 });
    const { reply } = buildReply();
    await handleListBatches(buildReq({}), reply);
    expect(listBatchesMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 50, offset: 0 }));
  });

  it('honors top-X via limit', async () => {
    listBatchesMock.mockResolvedValueOnce({ items: [], total: 0 });
    const { reply } = buildReply();
    await handleListBatches(buildReq({ limit: '5' }), reply);
    expect(listBatchesMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
  });

  it('reports has_more=true when total > offset + items.length', async () => {
    listBatchesMock.mockResolvedValueOnce({ items: [sampleRow], total: 50 });
    const { reply, sent } = buildReply();
    await handleListBatches(buildReq({ limit: '1', offset: '0' }), reply);
    expect((sent.body as { has_more: boolean }).has_more).toBe(true);
    expect((sent.body as { next_offset: number | null }).next_offset).toBe(1);
  });

  it('throws BatchValidationError on limit=0', async () => {
    const { reply } = buildReply();
    await expect(
      handleListBatches(buildReq({ limit: '0' }), reply),
    ).rejects.toBeInstanceOf(BatchValidationError);
  });

  it('throws BatchValidationError on limit=501 (above max)', async () => {
    const { reply } = buildReply();
    await expect(
      handleListBatches(buildReq({ limit: '501' }), reply),
    ).rejects.toBeInstanceOf(BatchValidationError);
  });

  it('throws BatchValidationError on negative offset', async () => {
    const { reply } = buildReply();
    await expect(
      handleListBatches(buildReq({ offset: '-1' }), reply),
    ).rejects.toBeInstanceOf(BatchValidationError);
  });
});

describe('handleListBatches — status filter', () => {
  it('parses a single status', async () => {
    listBatchesMock.mockResolvedValueOnce({ items: [], total: 0 });
    const { reply } = buildReply();
    await handleListBatches(buildReq({ status: 'processing' }), reply);
    expect(listBatchesMock).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: ['processing'] }),
    );
  });

  it('parses a comma-separated list', async () => {
    listBatchesMock.mockResolvedValueOnce({ items: [], total: 0 });
    const { reply } = buildReply();
    await handleListBatches(buildReq({ status: 'processing,completed' }), reply);
    expect(listBatchesMock).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: ['processing', 'completed'] }),
    );
  });

  it('rejects an unknown status', async () => {
    const { reply } = buildReply();
    await expect(
      handleListBatches(buildReq({ status: 'on_fire' }), reply),
    ).rejects.toBeInstanceOf(BatchValidationError);
  });

  it('omits the statuses filter when status param is missing', async () => {
    listBatchesMock.mockResolvedValueOnce({ items: [], total: 0 });
    const { reply } = buildReply();
    await handleListBatches(buildReq({}), reply);
    const args = listBatchesMock.mock.calls[0]![0];
    expect(args.statuses).toBeUndefined();
  });
});

describe('handleListBatches — date filters', () => {
  it('parses created_since as an ISO date', async () => {
    listBatchesMock.mockResolvedValueOnce({ items: [], total: 0 });
    const { reply } = buildReply();
    await handleListBatches(buildReq({ created_since: '2026-05-01T00:00:00Z' }), reply);
    const args = listBatchesMock.mock.calls[0]![0];
    expect(args.createdSince).toBeInstanceOf(Date);
    expect((args.createdSince as Date).toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('parses created_until as an ISO date', async () => {
    listBatchesMock.mockResolvedValueOnce({ items: [], total: 0 });
    const { reply } = buildReply();
    await handleListBatches(buildReq({ created_until: '2026-05-15T23:59:59Z' }), reply);
    const args = listBatchesMock.mock.calls[0]![0];
    expect((args.createdUntil as Date).toISOString()).toBe('2026-05-15T23:59:59.000Z');
  });

  it('rejects a malformed timestamp', async () => {
    const { reply } = buildReply();
    await expect(
      handleListBatches(buildReq({ created_since: 'not-a-date' }), reply),
    ).rejects.toBeInstanceOf(BatchValidationError);
  });

  it('rejects since > until', async () => {
    const { reply } = buildReply();
    await expect(
      handleListBatches(
        buildReq({
          created_since: '2026-05-15T00:00:00Z',
          created_until: '2026-05-01T00:00:00Z',
        }),
        reply,
      ),
    ).rejects.toBeInstanceOf(BatchValidationError);
  });
});
