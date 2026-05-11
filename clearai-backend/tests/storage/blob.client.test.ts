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

  it('list returns blobs under a prefix with sizes and content types', async () => {
    const { getBlobClient } = await import('../../src/storage/blob.client.js');
    const client = getBlobClient();
    await client.put('naqel/2026/05/08/r1/manifest.json', Buffer.from('{}', 'utf8'), 'application/json');
    await client.put('naqel/2026/05/08/r1/hv/a.xml', Buffer.from('<a/>', 'utf8'), 'application/xml');
    await client.put('naqel/2026/05/08/r1/lv/b.xml', Buffer.from('<bbb/>', 'utf8'), 'application/xml');
    // Out-of-prefix sibling — must not appear.
    await client.put('naqel/2026/05/09/r2/manifest.json', Buffer.from('{}', 'utf8'), 'application/json');

    const items = await client.list('naqel/2026/05/08/r1');
    expect(items).toHaveLength(3);
    const keys = items.map((i) => i.key).sort();
    expect(keys).toEqual([
      'naqel/2026/05/08/r1/hv/a.xml',
      'naqel/2026/05/08/r1/lv/b.xml',
      'naqel/2026/05/08/r1/manifest.json',
    ]);
    const xml = items.find((i) => i.key.endsWith('hv/a.xml'))!;
    expect(xml.contentType).toBe('application/xml');
    expect(xml.sizeBytes).toBe(4);
  });

  it('getReadSasUrl returns a file:// url with a future expiry', async () => {
    const { getBlobClient } = await import('../../src/storage/blob.client.js');
    const client = getBlobClient();
    await client.put('demo/x.txt', Buffer.from('hi', 'utf8'), 'text/plain');

    const t0 = Date.now();
    const sas = await client.getReadSasUrl('demo/x.txt', 60_000);
    expect(sas.url.startsWith('file://')).toBe(true);
    expect(new Date(sas.expiresAt).getTime()).toBeGreaterThan(t0);
  });

  it('getReadSasUrl on a missing key throws BlobNotFoundError', async () => {
    const { getBlobClient } = await import('../../src/storage/blob.client.js');
    const { BlobNotFoundError } = await import('../../src/storage/blob.types.js');
    await expect(getBlobClient().getReadSasUrl('nope/missing.bin', 1000)).rejects.toBeInstanceOf(
      BlobNotFoundError,
    );
  });
});

describe('blob.paths', () => {
  const PREFIX = 'naqel/2026/05/08/aa11bb22-cccc-dddd-eeee-ff0011223344';

  it('declarationRunPrefix builds {operator}/YYYY/MM/DD/{runId} with UTC zero-pad', async () => {
    const { declarationRunPrefix } = await import('../../src/storage/blob.paths.js');
    const prefix = declarationRunPrefix({
      operatorSlug: 'naqel',
      // Pick a date that exercises zero-padding on both fields.
      createdAt: new Date(Date.UTC(2026, 4, 8, 23, 59, 59)),
      runId: 'aa11bb22-cccc-dddd-eeee-ff0011223344',
    });
    expect(prefix).toBe(PREFIX);
  });

  it('builds keys under the prefix', async () => {
    const { inputKey, classificationsKey, runIndexKey, legacyRunIndexKey, filingKey } = await import(
      '../../src/storage/blob.paths.js'
    );
    expect(inputKey(PREFIX, 'csv')).toBe(`${PREFIX}/input.csv`);
    expect(inputKey(PREFIX, 'xlsx')).toBe(`${PREFIX}/input.xlsx`);
    expect(classificationsKey(PREFIX)).toBe(`${PREFIX}/classifications.json`);
    expect(runIndexKey(PREFIX)).toBe(`${PREFIX}/run-index.json`);
    // Legacy filename for pre-rename batches still resolves via the
    // legacyRunIndexKey helper — read paths fall back to this when
    // run-index.json is absent.
    expect(legacyRunIndexKey(PREFIX)).toBe(`${PREFIX}/manifest.json`);
    expect(filingKey({ prefix: PREFIX, strategy: 'HV_STANDALONE', filingId: 'f1' })).toBe(
      `${PREFIX}/hv/f1.xml`,
    );
    expect(filingKey({ prefix: PREFIX, strategy: 'LV_BUNDLED', filingId: 'f2' })).toBe(
      `${PREFIX}/lv/f2.xml`,
    );
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
