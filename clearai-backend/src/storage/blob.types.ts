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

export interface BlobClient {
  put(key: string, body: Buffer, contentType: string): Promise<BlobRef>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
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
