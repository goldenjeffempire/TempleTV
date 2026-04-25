/**
 * AWS S3 storage layer.
 *
 * Centralised, typed wrapper around the AWS SDK v3 S3 client. Every other
 * module in the API talks to S3 exclusively through these helpers — there is
 * no second client instantiated anywhere else, so credentials and region
 * configuration live in exactly one place.
 *
 * Configuration (environment variables):
 *   AWS_REGION             — e.g. "us-east-1"             (required)
 *   AWS_S3_BUCKET          — bucket name                   (required)
 *   AWS_ACCESS_KEY_ID      — IAM access key                (required)
 *   AWS_SECRET_ACCESS_KEY  — IAM secret key                (required)
 *   AWS_S3_ENDPOINT        — optional, S3-compatible URL   (LocalStack/MinIO)
 *   AWS_S3_FORCE_PATH_STYLE — "true" to use path-style    (LocalStack/MinIO)
 *
 * When any of the required vars is missing, `isS3Configured()` returns false
 * and callers either fall back to local-filesystem code paths or emit a
 * "degraded" status in the health endpoints.
 */

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type _Object,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "stream";
import { logger } from "./logger";

// ── Configuration ────────────────────────────────────────────────────────────

export const AWS_REGION = process.env.AWS_REGION?.trim() ?? "";
export const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET?.trim() ?? "";
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID?.trim() ?? "";
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY?.trim() ?? "";
const AWS_S3_ENDPOINT = process.env.AWS_S3_ENDPOINT?.trim() || undefined;
const AWS_S3_FORCE_PATH_STYLE =
  (process.env.AWS_S3_FORCE_PATH_STYLE?.trim() ?? "").toLowerCase() === "true";

export function isS3Configured(): boolean {
  return Boolean(
    AWS_REGION &&
      AWS_S3_BUCKET &&
      AWS_ACCESS_KEY_ID &&
      AWS_SECRET_ACCESS_KEY,
  );
}

// ── Singleton client ─────────────────────────────────────────────────────────

let _client: S3Client | null = null;

export function s3Client(): S3Client {
  if (_client) return _client;
  if (!isS3Configured()) {
    throw new Error(
      "AWS S3 is not configured. Set AWS_REGION, AWS_S3_BUCKET, " +
        "AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY before using S3.",
    );
  }
  _client = new S3Client({
    region: AWS_REGION,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
    endpoint: AWS_S3_ENDPOINT,
    forcePathStyle: AWS_S3_FORCE_PATH_STYLE || Boolean(AWS_S3_ENDPOINT),
  });
  return _client;
}

// ── Path helpers ─────────────────────────────────────────────────────────────

/**
 * Normalises a path that may include leading slashes and strips a leading
 * `bucket/` prefix if present. The rest of this module always operates on
 * bucket-relative S3 keys.
 */
export function toObjectKey(input: string): string {
  let key = input.startsWith("/") ? input.slice(1) : input;
  const prefix = `${AWS_S3_BUCKET}/`;
  if (key.startsWith(prefix)) key = key.slice(prefix.length);
  return key;
}

// ── Object operations ────────────────────────────────────────────────────────

export interface PutObjectOptions {
  contentType?: string;
  metadata?: Record<string, string>;
  cacheControl?: string;
}

export async function putObject(
  key: string,
  body: Buffer | Uint8Array | string | Readable,
  opts: PutObjectOptions = {},
): Promise<void> {
  if (body instanceof Readable) {
    // Streamed body uses the multipart Upload helper for resumable uploads.
    await new Upload({
      client: s3Client(),
      params: {
        Bucket: AWS_S3_BUCKET,
        Key: toObjectKey(key),
        Body: body,
        ContentType: opts.contentType,
        Metadata: opts.metadata,
        CacheControl: opts.cacheControl,
      },
    }).done();
    return;
  }
  await s3Client().send(
    new PutObjectCommand({
      Bucket: AWS_S3_BUCKET,
      Key: toObjectKey(key),
      Body: body,
      ContentType: opts.contentType,
      Metadata: opts.metadata,
      CacheControl: opts.cacheControl,
    }),
  );
}

export interface ObjectMetadata {
  contentType: string | null;
  contentLength: number | null;
  etag: string | null;
  lastModified: Date | null;
  cacheControl: string | null;
  metadata: Record<string, string>;
}

function emptyMetadata(): ObjectMetadata {
  return {
    contentType: null,
    contentLength: null,
    etag: null,
    lastModified: null,
    cacheControl: null,
    metadata: {},
  };
}

function isNotFoundError(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === "NotFound" ||
    e?.name === "NoSuchKey" ||
    e?.$metadata?.httpStatusCode === 404
  );
}

export async function headObject(key: string): Promise<ObjectMetadata | null> {
  try {
    const out = await s3Client().send(
      new HeadObjectCommand({ Bucket: AWS_S3_BUCKET, Key: toObjectKey(key) }),
    );
    return {
      contentType: out.ContentType ?? null,
      contentLength:
        typeof out.ContentLength === "number" ? out.ContentLength : null,
      etag: out.ETag ?? null,
      lastModified: out.LastModified ?? null,
      cacheControl: out.CacheControl ?? null,
      metadata: (out.Metadata as Record<string, string>) ?? {},
    };
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

export async function objectExists(key: string): Promise<boolean> {
  return (await headObject(key)) !== null;
}

export async function getObjectStream(
  key: string,
): Promise<{ body: Readable; meta: ObjectMetadata } | null> {
  try {
    const out = await s3Client().send(
      new GetObjectCommand({ Bucket: AWS_S3_BUCKET, Key: toObjectKey(key) }),
    );
    if (!out.Body) return null;
    const body = out.Body as Readable;
    const meta: ObjectMetadata = {
      contentType: out.ContentType ?? null,
      contentLength:
        typeof out.ContentLength === "number" ? out.ContentLength : null,
      etag: out.ETag ?? null,
      lastModified: out.LastModified ?? null,
      cacheControl: out.CacheControl ?? null,
      metadata: (out.Metadata as Record<string, string>) ?? {},
    };
    return { body, meta };
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

export async function getObjectBuffer(key: string): Promise<Buffer | null> {
  const result = await getObjectStream(key);
  if (!result) return null;
  return await streamToBuffer(result.body);
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Replace user-defined metadata on an existing object. S3 cannot mutate
 * metadata in place — we issue a self-copy with `MetadataDirective: REPLACE`
 * which is the canonical pattern for this operation.
 */
export async function replaceObjectMetadata(
  key: string,
  metadata: Record<string, string>,
  opts: { contentType?: string } = {},
): Promise<void> {
  const objectKey = toObjectKey(key);
  const head = await headObject(objectKey);
  if (!head) throw new Error(`replaceObjectMetadata: object not found: ${key}`);
  await s3Client().send(
    new CopyObjectCommand({
      Bucket: AWS_S3_BUCKET,
      Key: objectKey,
      CopySource: `${AWS_S3_BUCKET}/${encodeURIComponent(objectKey)}`,
      Metadata: metadata,
      MetadataDirective: "REPLACE",
      ContentType: opts.contentType ?? head.contentType ?? undefined,
    }),
  );
}

export async function deleteObject(key: string): Promise<void> {
  await s3Client().send(
    new DeleteObjectCommand({
      Bucket: AWS_S3_BUCKET,
      Key: toObjectKey(key),
    }),
  );
}

export async function listObjectKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined = undefined;
  do {
    const out: { Contents?: _Object[]; NextContinuationToken?: string } =
      await s3Client().send(
        new ListObjectsV2Command({
          Bucket: AWS_S3_BUCKET,
          Prefix: toObjectKey(prefix),
          ContinuationToken: continuationToken,
        }),
      );
    for (const item of out.Contents ?? []) {
      if (item.Key) keys.push(item.Key);
    }
    continuationToken = out.NextContinuationToken;
  } while (continuationToken);
  return keys;
}

/**
 * Bulk-delete every object that begins with `prefix`. Best-effort: errors are
 * logged and swallowed so a failing cleanup never blocks the caller's main
 * flow. Uses S3's batch DeleteObjects (1000 keys per call).
 */
export async function deleteObjectsByPrefix(prefix: string): Promise<void> {
  try {
    const keys = await listObjectKeys(prefix);
    if (keys.length === 0) return;
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await s3Client().send(
        new DeleteObjectsCommand({
          Bucket: AWS_S3_BUCKET,
          Delete: {
            Objects: batch.map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );
    }
  } catch (err) {
    logger.warn({ err, prefix }, "deleteObjectsByPrefix failed");
  }
}

// ── Presigned URLs ───────────────────────────────────────────────────────────

export async function getSignedPutUrl(
  key: string,
  ttlSec: number,
  opts: { contentType?: string } = {},
): Promise<string> {
  return getSignedUrl(
    s3Client(),
    new PutObjectCommand({
      Bucket: AWS_S3_BUCKET,
      Key: toObjectKey(key),
      ContentType: opts.contentType,
    }),
    { expiresIn: ttlSec },
  );
}

export async function getSignedGetUrl(
  key: string,
  ttlSec: number,
): Promise<string> {
  return getSignedUrl(
    s3Client(),
    new GetObjectCommand({ Bucket: AWS_S3_BUCKET, Key: toObjectKey(key) }),
    { expiresIn: ttlSec },
  );
}

// ── Multipart upload (parallel direct-to-S3 from the browser) ────────────────
//
// S3's multipart upload protocol is the only way to make a single browser
// upload saturate a 5G / fibre link: it lets the client open many parallel
// HTTPS PUTs to S3, each carrying one "part" of the file, and then commit
// all of them as a single object. Our admin upload modal uses these helpers
// (via the `/admin/videos/upload/s3-multipart-*` endpoints) so a 1 GB sermon
// upload can run 24 simultaneous 32 MB part PUTs instead of one serial PUT.
//
// Constraints worth knowing:
//   - Minimum part size: 5 MiB (except the very last part, which can be
//     anything from 0 B up). We enforce this in the admin route so callers
//     get a clean 400 instead of an opaque S3 EntityTooSmall on Complete.
//   - Maximum part size: 5 GiB.
//   - Maximum parts per upload: 10,000.
//   - Combined object size: 5 TiB.
//
// Part numbers are 1-based and need not be contiguous, but the Complete call
// must list them in ascending order. The browser engine handles the ordering.
//
// The presigned URL returned by `signUploadPartUrl` is a plain HTTPS PUT —
// the browser sets the body and Content-Length and S3 verifies the signature.
// No headers are signed beyond the canonical ones, so the browser doesn't
// need to set any extra headers for the PUT itself.

/** Minimum allowed part size for a non-last part (S3 hard requirement). */
export const S3_MULTIPART_MIN_PART_BYTES = 5 * 1024 * 1024;
/** Maximum number of parts in a single S3 multipart upload (S3 hard cap). */
export const S3_MULTIPART_MAX_PARTS = 10_000;

export async function createMultipartUpload(
  key: string,
  opts: { contentType?: string } = {},
): Promise<string> {
  const out = await s3Client().send(
    new CreateMultipartUploadCommand({
      Bucket: AWS_S3_BUCKET,
      Key: toObjectKey(key),
      ContentType: opts.contentType,
    }),
  );
  if (!out.UploadId) {
    throw new Error("createMultipartUpload: S3 did not return an UploadId");
  }
  return out.UploadId;
}

export async function signUploadPartUrl(
  key: string,
  uploadId: string,
  partNumber: number,
  ttlSec: number,
): Promise<string> {
  return getSignedUrl(
    s3Client(),
    new UploadPartCommand({
      Bucket: AWS_S3_BUCKET,
      Key: toObjectKey(key),
      UploadId: uploadId,
      PartNumber: partNumber,
    }),
    { expiresIn: ttlSec },
  );
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: CompletedPart[],
): Promise<void> {
  // S3 requires parts in ascending PartNumber order at Complete time.
  const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  await s3Client().send(
    new CompleteMultipartUploadCommand({
      Bucket: AWS_S3_BUCKET,
      Key: toObjectKey(key),
      UploadId: uploadId,
      MultipartUpload: {
        Parts: ordered.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    }),
  );
}

export async function abortMultipartUpload(
  key: string,
  uploadId: string,
): Promise<void> {
  try {
    await s3Client().send(
      new AbortMultipartUploadCommand({
        Bucket: AWS_S3_BUCKET,
        Key: toObjectKey(key),
        UploadId: uploadId,
      }),
    );
  } catch (err) {
    // Abort failures are not actionable — the partial upload will be cleaned
    // up by the bucket's lifecycle rule (which every production bucket
    // should have configured). Log and swallow.
    logger.warn({ err, key, uploadId }, "abortMultipartUpload failed");
  }
}

// ── URL helpers ──────────────────────────────────────────────────────────────

/**
 * Build the canonical https URL for an object in the configured bucket. Used
 * primarily for normalisation (e.g. converting an upload-time URL back into
 * a stable bucket key).
 */
export function publicS3Url(key: string): string {
  const objectKey = toObjectKey(key);
  if (AWS_S3_ENDPOINT) {
    // Custom endpoint (LocalStack/MinIO) — always path-style.
    return `${AWS_S3_ENDPOINT.replace(/\/$/, "")}/${AWS_S3_BUCKET}/${objectKey}`;
  }
  if (AWS_S3_FORCE_PATH_STYLE) {
    return `https://s3.${AWS_REGION}.amazonaws.com/${AWS_S3_BUCKET}/${objectKey}`;
  }
  return `https://${AWS_S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${objectKey}`;
}

/**
 * If `rawPath` is an absolute S3 URL pointing at the configured bucket,
 * return the bucket-relative key. Otherwise return the input unchanged.
 */
export function s3UrlToKey(rawPath: string): string | null {
  if (!/^https?:\/\//i.test(rawPath)) return null;
  let url: URL;
  try {
    url = new URL(rawPath);
  } catch {
    return null;
  }
  // Virtual-hosted style: <bucket>.s3.<region>.amazonaws.com/<key>
  if (url.hostname.startsWith(`${AWS_S3_BUCKET}.`)) {
    return url.pathname.replace(/^\//, "");
  }
  // Path style: s3.<region>.amazonaws.com/<bucket>/<key>
  const prefix = `/${AWS_S3_BUCKET}/`;
  if (url.pathname.startsWith(prefix)) {
    return url.pathname.slice(prefix.length);
  }
  return null;
}
