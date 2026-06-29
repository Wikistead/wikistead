import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export interface StorageDriver {
  // Idempotent: create the bucket if it does not exist. Called at app startup.
  ensureBucket(): Promise<void>
  // Generate a presigned PUT URL for direct client upload (server never proxies bytes).
  presignPut(key: string, opts: { contentType: string; ttlSeconds: number }): Promise<string>
  // Server-mediated write of raw bytes. Used for SMALL, server-validated assets
  // (e.g. the tenant logo) where the server must inspect the bytes (magic-byte +
  // size) BEFORE storing — presignPut cannot validate content. Callers MUST have
  // validated size + content type first.
  putObject(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  // Generate a presigned GET URL for direct client download.
  // Returns JSON { downloadUrl } — NOT a 302 redirect, to avoid URL leaking
  // into browser history, Referer headers, and access logs.
  presignGet(key: string, opts: { ttlSeconds: number }): Promise<string>
  // Delete an object. No-op (does not throw) if the object does not exist.
  deleteObject(key: string): Promise<void>
  // Return the actual size of an uploaded object from S3 metadata.
  // Used at confirm time to set size_bytes without trusting the client.
  // Throws if the object does not exist (client has not uploaded yet).
  headObject(key: string): Promise<{ sizeBytes: number }>
  // Read the raw object bytes. INTERNAL, AUTH-BYPASSING: unlike presignGet (which is
  // requested only after an FGA `view` check), this is a direct store read with NO
  // authorization gate — the CALLER must have already authorized access to the
  // resource this key belongs to. Used by export to bundle images, where the caller
  // resolves keys ONLY from view-confirmed pages and re-checks view on each
  // attachment's page before reading. Never expose a path that takes a caller-
  // supplied key straight through to this.
  getObject(key: string): Promise<Uint8Array>
  // List all object keys under a prefix (paginated internally). INTERNAL/admin use only
  // (reconciling GC) — like getObject it is auth-bypassing; the caller owns the boundary.
  // Used by the revision GC to find storage objects with no live DB pointer (#113 / ADR-062).
  listObjects(prefix: string): Promise<string[]>
}

// Single shared bucket; tenant prefix embedded in every key.
// Key format: {tenantId}/pages/{pageId}/{attachmentId}/{sanitized-filename}
//
// TODO(phase: tenancy-namespace): NamespaceStorageDriver routes to a dedicated
// bucket + credential for namespace-isolated tenants. Same abstraction pattern
// as SearchDriver and TenantDb (app never branches on isolation strategy).
export class LogicalStorageDriver implements StorageDriver {
  private readonly s3: S3Client
  private readonly bucket: string

  constructor() {
    this.s3 = new S3Client({
      region: process.env.S3_REGION ?? 'us-east-1',
      endpoint: process.env.S3_ENDPOINT,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY!,
        secretAccessKey: process.env.S3_SECRET_KEY!,
      },
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    })
    this.bucket = process.env.S3_BUCKET!
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }))
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }))
    }
  }

  async presignPut(key: string, opts: { contentType: string; ttlSeconds: number }): Promise<string> {
    return getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: opts.contentType }),
      { expiresIn: opts.ttlSeconds },
    )
  }

  async putObject(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType }))
  }

  async presignGet(key: string, opts: { ttlSeconds: number }): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: opts.ttlSeconds },
    )
  }

  async deleteObject(key: string): Promise<void> {
    // DeleteObject is a no-op (not an error) for non-existent keys.
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  async headObject(key: string): Promise<{ sizeBytes: number }> {
    const result = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
    return { sizeBytes: result.ContentLength ?? 0 }
  }

  // Auth-bypassing raw read — see the interface note. Callers own authorization.
  async getObject(key: string): Promise<Uint8Array> {
    const result = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    return result.Body!.transformToByteArray()
  }

  // List all keys under a prefix, following continuation tokens so large prefixes are
  // returned in full (the GC must see EVERY object to diff against the live key set).
  async listObjects(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let token: string | undefined
    do {
      const r = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }))
      for (const o of r.Contents ?? []) if (o.Key) keys.push(o.Key)
      token = r.IsTruncated ? r.NextContinuationToken : undefined
    } while (token)
    return keys
  }
}

// Build the S3 object key for an attachment.
// Tenant prefix enforces physical separation within the shared bucket.
export function makeS3Key(
  tenantId: string,
  pageId: string,
  attachmentId: string,
  filename: string,
): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200)
  return `${tenantId}/pages/${pageId}/${attachmentId}/${safe}`
}
