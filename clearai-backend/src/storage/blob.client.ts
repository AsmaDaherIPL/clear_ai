/**
 * Blob client with three adapters under one interface.
 *
 *   • BATCH_BLOB_BACKEND='azure-blob' + BATCH_BLOB_ACCOUNT='<short>'
 *       → Azure SDK with DefaultAzureCredential (Container Apps MI in
 *         prod / dev Azure; az login locally — but local Azure access
 *         is normally blocked by firewall, so use 'file' there).
 *
 *   • BATCH_BLOB_BACKEND='file' (or unset, with BATCH_BLOB_CONNECTION
 *       set to file://...)
 *       → local-disk adapter under the resolved root.
 *
 *   • BATCH_BLOB_CONNECTION='<azure connection string>' (legacy)
 *       → Azure SDK with shared-key auth. Kept for environments where
 *         the account allows shared keys; the dev account does not.
 *
 * The choice is made once at module load. Tests can call
 * `_resetClientForTests()` to force re-detection with a different env.
 */
import {
  mkdir,
  readFile,
  unlink,
  writeFile,
  stat,
  readdir,
} from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { env } from '../config/env.js';
import {
  BlobNotFoundError,
  BlobUploadError,
  type BlobClient,
  type BlobListItem,
  type BlobRef,
  type SignedReadUrl,
} from './blob.types.js';

function fileUriToPath(uri: string): string {
  const after = uri.slice('file://'.length);
  if (after.startsWith('./')) return resolve(process.cwd(), after.slice(2));
  if (after.startsWith('/')) return after;
  return resolve(process.cwd(), after);
}

// ---------------------------------------------------------------------------
// Local-disk adapter
// ---------------------------------------------------------------------------

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

  async list(prefix: string): Promise<BlobListItem[]> {
    const root = this.toFsPath(prefix);
    const out: BlobListItem[] = [];
    await this.walkDir(root, prefix, out);
    return out;
  }

  private async walkDir(dir: string, prefix: string, out: BlobListItem[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walkDir(full, prefix, out);
        continue;
      }
      // Skip the sidecar metadata files
      if (entry.name.endsWith('.meta.json')) continue;
      const rel = relative(this.rootDir, full).split(/[/\\]/).join('/');
      let contentType: string | null = null;
      try {
        const meta = await readFile(`${full}.meta.json`, 'utf8');
        contentType = (JSON.parse(meta) as { contentType?: string }).contentType ?? null;
      } catch {
        contentType = null;
      }
      const st = await stat(full);
      out.push({ key: rel, sizeBytes: st.size, contentType });
    }
  }

  /**
   * Local "SAS" — returns a file:// URL. Route handlers should treat
   * file-driver URLs as a signal to stream bytes through themselves
   * rather than redirecting the client. Useful as a uniform return
   * shape so test code doesn't branch on adapter type.
   */
  async getReadSasUrl(key: string, ttlMs: number): Promise<SignedReadUrl> {
    const fsPath = this.toFsPath(key);
    if (!(await this.exists(key))) throw new BlobNotFoundError(key);
    return {
      url: pathToFileURL(fsPath).toString(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Azure adapters
// ---------------------------------------------------------------------------
//
// Two construction paths share the same operational surface area:
//   - fromConnectionString (legacy account-key auth)
//   - fromMi (DefaultAzureCredential, used on the dev/prod accounts
//     that have allowSharedKeyAccess=false)
//
// Both produce a ContainerClient and a BlobServiceClient — the latter
// is needed for getUserDelegationKey() during SAS minting.

interface AzureSdk {
  BlobServiceClient: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  BlobSASPermissions: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  SASProtocol: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  generateBlobSASQueryParameters: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

interface AzureClients {
  account: string;
  container: string;
  containerClient: {
    getBlockBlobClient: (key: string) => {
      uploadData: (
        body: Buffer,
        opts?: { blobHTTPHeaders?: { blobContentType: string } },
      ) => Promise<unknown>;
      downloadToBuffer: () => Promise<Buffer>;
      deleteIfExists: () => Promise<unknown>;
      exists: () => Promise<boolean>;
    };
    listBlobsFlat: (opts: { prefix: string }) => AsyncIterable<{
      name: string;
      properties: { contentLength?: number; contentType?: string };
    }>;
    createIfNotExists?: () => Promise<unknown>;
  };
  serviceClient: {
    getUserDelegationKey: (start: Date, end: Date) => Promise<unknown>;
  };
  sdk: AzureSdk;
  authMode: 'connection-string' | 'managed-identity';
}

class AzureBlobClient implements BlobClient {
  private clientsPromise: Promise<AzureClients>;

  constructor(opts: {
    container: string;
    connectionString?: string;
    accountName?: string;
  }) {
    this.clientsPromise = (async () => {
      const sb = await import('@azure/storage-blob');
      let serviceClient: any; // eslint-disable-line @typescript-eslint/no-explicit-any
      let account: string;
      let authMode: 'connection-string' | 'managed-identity';

      if (opts.connectionString) {
        serviceClient = sb.BlobServiceClient.fromConnectionString(opts.connectionString);
        // Extract account name from the connection string for SAS host construction.
        const m = opts.connectionString.match(/AccountName=([^;]+)/i);
        account = m ? m[1]! : '';
        authMode = 'connection-string';
      } else if (opts.accountName) {
        const id = await import('@azure/identity');
        const credential = new id.DefaultAzureCredential();
        serviceClient = new sb.BlobServiceClient(
          `https://${opts.accountName}.blob.core.windows.net`,
          credential,
        );
        account = opts.accountName;
        authMode = 'managed-identity';
      } else {
        throw new Error('AzureBlobClient requires either a connection string or an account name.');
      }

      const containerClient = serviceClient.getContainerClient(opts.container);
      // Idempotent. Skipped on MI auth where the container is provisioned
      // by infra (the MI may not have container-create rights).
      if (authMode === 'connection-string') {
        await containerClient.createIfNotExists();
      }
      return { account, container: opts.container, containerClient, serviceClient, sdk: sb, authMode };
    })();
  }

  async put(key: string, body: Buffer, contentType: string): Promise<BlobRef> {
    const c = await this.clientsPromise;
    try {
      await c.containerClient
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
    const c = await this.clientsPromise;
    const client = c.containerClient.getBlockBlobClient(key);
    if (!(await client.exists())) throw new BlobNotFoundError(key);
    return client.downloadToBuffer();
  }

  async delete(key: string): Promise<void> {
    const c = await this.clientsPromise;
    await c.containerClient.getBlockBlobClient(key).deleteIfExists();
  }

  async exists(key: string): Promise<boolean> {
    const c = await this.clientsPromise;
    return c.containerClient.getBlockBlobClient(key).exists();
  }

  async list(prefix: string): Promise<BlobListItem[]> {
    const c = await this.clientsPromise;
    const out: BlobListItem[] = [];
    for await (const blob of c.containerClient.listBlobsFlat({ prefix })) {
      out.push({
        key: blob.name,
        sizeBytes: blob.properties.contentLength ?? null,
        contentType: blob.properties.contentType ?? null,
      });
    }
    return out;
  }

  async getReadSasUrl(key: string, ttlMs: number): Promise<SignedReadUrl> {
    const c = await this.clientsPromise;
    if (!(await c.containerClient.getBlockBlobClient(key).exists())) {
      throw new BlobNotFoundError(key);
    }

    const startsOn = new Date(Date.now() - 5 * 60 * 1000); // 5-min skew tolerance
    const expiresOn = new Date(Date.now() + ttlMs);

    const sasOptions = {
      containerName: c.container,
      blobName: key,
      permissions: c.sdk.BlobSASPermissions.parse('r'),
      protocol: c.sdk.SASProtocol.Https,
      startsOn,
      expiresOn,
    };

    let sasToken: string;
    if (c.authMode === 'managed-identity') {
      // User-delegation SAS — signed with a key fetched from the
      // service principal, no shared key required. The SDK requires
      // an account name string for the URL construction.
      const userDelegationKey = await c.serviceClient.getUserDelegationKey(startsOn, expiresOn);
      sasToken = c.sdk
        .generateBlobSASQueryParameters(sasOptions, userDelegationKey, c.account)
        .toString();
    } else {
      // Account-key SAS path. Connection-string auth retains the key
      // internally; the SDK signs against it directly.
      const creds = (c.serviceClient as unknown as { credential: unknown }).credential;
      sasToken = c.sdk.generateBlobSASQueryParameters(sasOptions, creds).toString();
    }

    return {
      url: `https://${c.account}.blob.core.windows.net/${c.container}/${encodeURIComponent(key).replace(/%2F/g, '/')}?${sasToken}`,
      expiresAt: expiresOn.toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Adapter selection
// ---------------------------------------------------------------------------

let _client: BlobClient | null = null;

function buildClient(): BlobClient {
  const e = env();
  const backend = e.BATCH_BLOB_BACKEND;

  // 1. Explicit MI path
  if (backend === 'azure-blob') {
    if (!e.BATCH_BLOB_ACCOUNT) {
      throw new Error(
        "BATCH_BLOB_BACKEND='azure-blob' requires BATCH_BLOB_ACCOUNT (storage account short name).",
      );
    }
    return new AzureBlobClient({
      container: e.BATCH_BLOB_CONTAINER,
      accountName: e.BATCH_BLOB_ACCOUNT,
    });
  }

  // 2. Explicit file path
  if (backend === 'file') {
    const conn = e.BATCH_BLOB_CONNECTION;
    if (!conn || !conn.startsWith('file://')) {
      throw new Error(
        "BATCH_BLOB_BACKEND='file' requires BATCH_BLOB_CONNECTION='file://<path>'.",
      );
    }
    return new LocalBlobClient(fileUriToPath(conn));
  }

  // 3. Legacy / unset path — sniff BATCH_BLOB_CONNECTION
  const conn = e.BATCH_BLOB_CONNECTION;
  if (!conn) {
    throw new Error(
      'No blob backend configured. Set BATCH_BLOB_BACKEND=azure-blob (with BATCH_BLOB_ACCOUNT) ' +
        'for production, or BATCH_BLOB_BACKEND=file (with BATCH_BLOB_CONNECTION=file://...) for dev.',
    );
  }

  if (conn.startsWith('file://')) {
    return new LocalBlobClient(fileUriToPath(conn));
  }
  if (conn === 'UseDevelopmentStorage' || conn.startsWith('UseDevelopmentStorage')) {
    return new LocalBlobClient(resolve(process.cwd(), '.local-blob'));
  }
  return new AzureBlobClient({
    container: e.BATCH_BLOB_CONTAINER,
    connectionString: conn,
  });
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
