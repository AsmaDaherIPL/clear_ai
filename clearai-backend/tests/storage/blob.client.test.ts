/**
 * Local-disk adapter integration tests. We never exercise the Azure adapter
 * here — that requires a real connection string and is out of scope for unit
 * tests.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  originalEnv = { ...process.env };
  tmpDir = await mkdtemp(join(tmpdir(), 'clearai-blob-'));
  process.env = {
    ...process.env,
    DATABASE_URL: 'postgres://u:p@localhost:5432/clearai',
    ANTHROPIC_API_KEY: 'sk-test',
    ANTHROPIC_BASE_URL: 'https://example.com/v1/messages',
    BATCH_BLOB_CONNECTION: `file://${tmpDir}`,
    BATCH_BLOB_CONTAINER: 'batches',
    ZATCA_DECLARATION_NS: 'http://www.saudiedi.com/schema/decsub',
    ZATCA_SUBMITTER_CARRIER_ID: 'TEST',
    ZATCA_SUBMITTER_NAME: 'Test',
  };
  vi.resetModules();
});

afterEach(async () => {
  process.env = originalEnv;
  await rm(tmpDir, { recursive: true, force: true });
});

describe('LocalBlobClient (file:// adapter)', () => {
  it('put/get/exists/delete round-trip', async () => {
    const { getBlobClient } = await import('../../src/storage/blob.client.js');
    const client = getBlobClient();
    const key = 'batches/abc/input.csv';
    const body = Buffer.from('col1,col2\nfoo,bar\n', 'utf8');

    const ref = await client.put(key, body, 'text/csv');
    expect(ref.key).toBe(key);
    expect(ref.sizeBytes).toBe(body.byteLength);
    expect(ref.contentType).toBe('text/csv');

    expect(await client.exists(key)).toBe(true);

    const got = await client.get(key);
    expect(got.equals(body)).toBe(true);

    await client.delete(key);
    expect(await client.exists(key)).toBe(false);
  });

  it('get throws BlobNotFoundError for absent key', async () => {
    const { getBlobClient } = await import('../../src/storage/blob.client.js');
    const { BlobNotFoundError } = await import('../../src/storage/blob.types.js');
    await expect(getBlobClient().get('does/not/exist.bin')).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it('rejects keys containing ..', async () => {
    const { getBlobClient } = await import('../../src/storage/blob.client.js');
    await expect(
      getBlobClient().put('../escape', Buffer.from('x'), 'text/plain'),
    ).rejects.toThrow(/\.\./);
  });

  it('exists returns false for absent key', async () => {
    const { getBlobClient } = await import('../../src/storage/blob.client.js');
    expect(await getBlobClient().exists('nope/nada.bin')).toBe(false);
  });

  it('delete is idempotent for absent key', async () => {
    const { getBlobClient } = await import('../../src/storage/blob.client.js');
    await expect(getBlobClient().delete('does/not/exist.bin')).resolves.toBeUndefined();
  });
});

describe('blob.paths', () => {
  it('builds deterministic input/result keys', async () => {
    const { inputKey, classificationsResultKey, declarationKey } = await import(
      '../../src/storage/blob.paths.js'
    );
    expect(inputKey('abc', 'csv')).toBe('declaration-sets/abc/input.csv');
    expect(inputKey('abc', 'xlsx')).toBe('declaration-sets/abc/input.xlsx');
    expect(classificationsResultKey('abc')).toBe('declaration-sets/abc/result.json');
    expect(declarationKey('abc', 0)).toBe('declaration-sets/abc/declarations/0000.xml');
    expect(declarationKey('abc', 17)).toBe('declaration-sets/abc/declarations/0017.xml');
  });

  it('rejects negative bundle indices', async () => {
    const { declarationKey } = await import('../../src/storage/blob.paths.js');
    expect(() => declarationKey('abc', -1)).toThrow(RangeError);
  });
});

describe('semaphore', () => {
  it('caps concurrency at the supplied limit', async () => {
    const { withSemaphore } = await import('../../src/common/concurrency/semaphore.js');
    const run = withSemaphore(2);
    let inFlight = 0;
    let maxInFlight = 0;
    const task = async (): Promise<void> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    };
    await Promise.all(Array.from({ length: 8 }, () => run(task)));
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('rejects non-positive limits', async () => {
    const { withSemaphore } = await import('../../src/common/concurrency/semaphore.js');
    expect(() => withSemaphore(0)).toThrow(RangeError);
    expect(() => withSemaphore(-1)).toThrow(RangeError);
    expect(() => withSemaphore(1.5)).toThrow(RangeError);
  });
});
