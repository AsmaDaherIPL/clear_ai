/**
 * Storage layer types. The blob client interface is the single shape every
 * caller (batches use-case, declaration service) imports — both adapters
 * (Azure SDK + local-disk dev fallback) implement it.
 */

export interface BlobRef {
  /** Path inside BATCH_BLOB_CONTAINER, e.g. 'batches/<id>/input.csv'. */
  key: string;
  /** Bytes written. */
  sizeBytes: number;
  /** MIME content-type recorded with the blob. */
  contentType: string;
  /** ISO-8601 UTC timestamp of write. */
  writtenAt: string;
}

export interface BlobListItem {
  /** Full key including any prefix the caller queried for. */
  key: string;
  /** Bytes; null when the adapter cannot cheaply determine size (file adapter populates it). */
  sizeBytes: number | null;
  /** MIME type if known. */
  contentType: string | null;
}

export interface SignedReadUrl {
  url: string;
  expiresAt: string; // ISO-8601 UTC
}

export interface BlobClient {
  put(key: string, body: Buffer, contentType: string): Promise<BlobRef>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** List blobs under a prefix. Returns full keys, not relative names. */
  list(prefix: string): Promise<BlobListItem[]>;
  /**
   * Mint a short-lived read URL for a single blob.
   *
   * - Azure adapter: user-delegation SAS signed with the MI's key
   *   (Storage Blob Data Contributor includes getUserDelegationKey).
   * - File adapter: returns a synthetic `file:///` URL the route handler
   *   should reject for direct client use — local-dev callers stream
   *   the bytes through the backend's single-file endpoint instead.
   */
  getReadSasUrl(key: string, ttlMs: number): Promise<SignedReadUrl>;
}

export class BlobNotFoundError extends Error {
  readonly code = 'blob_not_found';
  constructor(key: string) {
    super(`Blob not found: ${key}`);
    this.name = 'BlobNotFoundError';
  }
}

export class BlobUploadError extends Error {
  readonly code = 'blob_upload_failed';
  constructor(key: string, cause: unknown) {
    super(`Failed to upload blob: ${key}`);
    this.name = 'BlobUploadError';
    (this as unknown as { cause: unknown }).cause = cause;
  }
}
