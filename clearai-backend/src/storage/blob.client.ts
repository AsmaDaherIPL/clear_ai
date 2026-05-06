/**
 * Blob client with two adapters under one interface.
 *
 *   • file://./.local-blob   -> local-disk adapter (dev fallback)
 *   • UseDevelopmentStorage  -> local-disk adapter (Azurite-like shortcut)
 *   • <anything else>        -> Azure Blob SDK adapter
 *
 * The choice is made once at module load by inspecting BATCH_BLOB_CONNECTION
 * via env(). Tests can call `_resetClientForTests()` to force re-detection
 * with a different env.
 */
import {
  mkdir,
  readFile,
  unlink,
  writeFile,
  stat,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { env } from '../config/env.js';
import { BlobNotFoundError, BlobUploadError, type BlobClient, type BlobRef } from './blob.types.js';

/**
 * Resolve a `file://` URI to an absolute filesystem path.
 *   file://./local           -> resolve(cwd, 'local')
 *   file:///abs/path         -> '/abs/path'
 *   file:///C:/Users/...     -> 'C:/Users/...' (best-effort; primary target is darwin/linux)
 *
 * We hand-roll this rather than using URL+fileURLToPath because
 * fileURLToPath rejects relative file URLs ('file://./foo') with
 * "File URL host must be \"localhost\" or empty", which is the dev
 * fallback we want to support.
 */
function fileUriToPath(uri: string): string {
  const after = uri.slice('file://'.length);
  // file://./relative  -> 'relative' under cwd
  if (after.startsWith('./')) return resolve(process.cwd(), after.slice(2));
  if (after.startsWith('/')) return after;
  // file://relative (no leading slash) -> treat as cwd-relative.
  return resolve(process.cwd(), after);
}

class LocalBlobClient implements BlobClient {
  constructor(private readonly rootDir: string) {}

  private toFsPath(key: string): string {
    if (key.includes('..')) {
      throw new Error(`Refusing blob key with '..': ${key}`);
    }
    return join(this.rootDir, key);
  }

  async put(key: string, body: Buffer, contentType: string): Promise<BlobRef> {
    const fsPath = this.toFsPath(key);
    try {
      await mkdir(dirname(fsPath), { recursive: true });
      await writeFile(fsPath, body);
      // Sidecar metadata file, used to round-trip contentType locally.
      await writeFile(`${fsPath}.meta.json`, JSON.stringify({ contentType }));
    } catch (err) {
      throw new BlobUploadError(key, err);
    }
    return {
      key,
      sizeBytes: body.byteLength,
      contentType,
      writtenAt: new Date().toISOString(),
    };
  }

  async get(key: string): Promise<Buffer> {
    const fsPath = this.toFsPath(key);
    try {
      return await readFile(fsPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new BlobNotFoundError(key);
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const fsPath = this.toFsPath(key);
    try {
      await unlink(fsPath);
      await unlink(`${fsPath}.meta.json`).catch(() => undefined);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.toFsPath(key));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Azure adapter. Lazy-imports @azure/storage-blob so the local-disk path
 * has zero runtime dependency on it during dev.
 */
class AzureBlobClient implements BlobClient {
  private containerClientPromise: Promise<{
    getBlockBlobClient: (key: string) => {
      uploadData: (
        body: Buffer,
        opts?: { blobHTTPHeaders?: { blobContentType: string } },
      ) => Promise<unknown>;
      downloadToBuffer: () => Promise<Buffer>;
      deleteIfExists: () => Promise<unknown>;
      exists: () => Promise<boolean>;
    };
  }>;

  constructor(connectionString: string, container: string) {
    this.containerClientPromise = (async () => {
      const sb = await import('@azure/storage-blob');
      const service = sb.BlobServiceClient.fromConnectionString(connectionString);
      const cc = service.getContainerClient(container);
      // Lazy-create the container; idempotent.
      await cc.createIfNotExists();
      return cc as unknown as {
        getBlockBlobClient: (key: string) => {
          uploadData: (
            body: Buffer,
            opts?: { blobHTTPHeaders?: { blobContentType: string } },
          ) => Promise<unknown>;
          downloadToBuffer: () => Promise<Buffer>;
          deleteIfExists: () => Promise<unknown>;
          exists: () => Promise<boolean>;
        };
      };
    })();
  }

  async put(key: string, body: Buffer, contentType: string): Promise<BlobRef> {
    const cc = await this.containerClientPromise;
    try {
      await cc
        .getBlockBlobClient(key)
        .uploadData(body, { blobHTTPHeaders: { blobContentType: contentType } });
    } catch (err) {
      throw new BlobUploadError(key, err);
    }
    return {
      key,
      sizeBytes: body.byteLength,
      contentType,
      writtenAt: new Date().toISOString(),
    };
  }

  async get(key: string): Promise<Buffer> {
    const cc = await this.containerClientPromise;
    const client = cc.getBlockBlobClient(key);
    if (!(await client.exists())) throw new BlobNotFoundError(key);
    return client.downloadToBuffer();
  }

  async delete(key: string): Promise<void> {
    const cc = await this.containerClientPromise;
    await cc.getBlockBlobClient(key).deleteIfExists();
  }

  async exists(key: string): Promise<boolean> {
    const cc = await this.containerClientPromise;
    return cc.getBlockBlobClient(key).exists();
  }
}

let _client: BlobClient | null = null;

function buildClient(): BlobClient {
  const e = env();
  const conn = e.BATCH_BLOB_CONNECTION;

  if (!conn) {
    throw new Error(
      'BATCH_BLOB_CONNECTION is not set. Configure it on the Container App ' +
      'env (Azure Blob connection string, or `file://<path>` for local dev) ' +
      'before invoking storage operations.',
    );
  }

  if (conn.startsWith('file://')) {
    return new LocalBlobClient(fileUriToPath(conn));
  }
  if (conn === 'UseDevelopmentStorage' || conn.startsWith('UseDevelopmentStorage')) {
    // Treat the Azurite shortcut as a local dev signal — but still default
    // to a disk-backed dir under .local-blob/. If users specifically want
    // Azurite, they can install it and use a real connection string.
    return new LocalBlobClient(resolve(process.cwd(), '.local-blob'));
  }
  return new AzureBlobClient(conn, e.BATCH_BLOB_CONTAINER);
}

/** Lazy-init module-singleton. The first call locks the adapter choice. */
export function getBlobClient(): BlobClient {
  if (_client) return _client;
  _client = buildClient();
  return _client;
}

/** TEST-ONLY: drop the cached client so the next getBlobClient() re-reads env. */
export function _resetClientForTests(): void {
  _client = null;
}
