import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * S3-compatible storage abstraction.
 *
 * Works with: AWS S3, Cloudflare R2, MinIO, Backblaze B2, DigitalOcean Spaces.
 * Set S3_ENDPOINT to switch providers; leave blank for AWS S3.
 *
 * If S3_BUCKET is not configured the storage layer falls into a
 * disabled-but-callable mode that logs a clear error rather than
 * crashing the process. Production deploys MUST provide S3 credentials.
 */
export interface MultipartPart {
  partNumber: number;
  etag: string;
}

export interface ObjectStorage {
  readonly enabled: boolean;
  readonly bucket: string | null;
  readonly region: string | null;
  putObject(args: { key: string; body: Buffer | Uint8Array; contentType?: string }): Promise<{ key: string; url: string }>;
  signedDownloadUrl(key: string, ttlSeconds?: number): Promise<string>;
  signedUploadUrl(args: { key: string; contentType?: string; ttlSeconds?: number }): Promise<{ url: string; key: string }>;
  deleteObject(key: string): Promise<void>;
  headObject(key: string): Promise<{ exists: boolean; contentLength?: number; contentType?: string }>;
  publicUrl(key: string): string | null;
  // Multipart upload primitives — used by the admin chunked uploader for
  // large videos (>5 MiB). Browser PUTs each part directly to a presigned
  // URL, then the server completes assembly in one S3 round-trip.
  createMultipartUpload(args: { key: string; contentType?: string }): Promise<{ uploadId: string }>;
  signUploadPart(args: { key: string; uploadId: string; partNumber: number; ttlSeconds?: number }): Promise<string>;
  completeMultipartUpload(args: { key: string; uploadId: string; parts: MultipartPart[] }): Promise<{ key: string; etag: string | null; location: string | null }>;
  abortMultipartUpload(args: { key: string; uploadId: string }): Promise<void>;
}

class DisabledStorage implements ObjectStorage {
  readonly enabled = false;
  readonly bucket = null;
  readonly region = null;
  private err(): never {
    throw new Error("Object storage not configured (set S3_BUCKET + AWS credentials)");
  }
  async putObject() {
    return this.err();
  }
  async signedDownloadUrl() {
    return this.err();
  }
  async signedUploadUrl() {
    return this.err();
  }
  async deleteObject() {
    return this.err();
  }
  async headObject() {
    return this.err();
  }
  publicUrl() {
    return null;
  }
  async createMultipartUpload() {
    return this.err();
  }
  async signUploadPart() {
    return this.err();
  }
  async completeMultipartUpload() {
    return this.err();
  }
  async abortMultipartUpload() {
    return this.err();
  }
}

class S3Storage implements ObjectStorage {
  readonly enabled = true;
  readonly bucket: string;
  readonly region: string;
  private client: S3Client;

  constructor(bucket: string) {
    this.bucket = bucket;
    this.region = env.S3_REGION;
    this.client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials:
        env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
          ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
          : undefined,
    });
  }

  publicUrl(key: string): string | null {
    if (env.S3_PUBLIC_URL_BASE) {
      return `${env.S3_PUBLIC_URL_BASE.replace(/\/+$/, "")}/${encodeURI(key)}`;
    }
    if (env.S3_ENDPOINT) {
      return `${env.S3_ENDPOINT.replace(/\/+$/, "")}/${this.bucket}/${encodeURI(key)}`;
    }
    return `https://${this.bucket}.s3.${env.S3_REGION}.amazonaws.com/${encodeURI(key)}`;
  }

  async putObject({ key, body, contentType }: { key: string; body: Buffer | Uint8Array; contentType?: string }) {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
    return { key, url: this.publicUrl(key) ?? "" };
  }

  async signedDownloadUrl(key: string, ttlSeconds = 900) {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttlSeconds,
    });
  }

  async signedUploadUrl({ key, contentType, ttlSeconds = 900 }: { key: string; contentType?: string; ttlSeconds?: number }) {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: ttlSeconds },
    );
    return { url, key };
  }

  async deleteObject(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async headObject(key: string) {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        exists: true,
        contentLength: r.ContentLength,
        contentType: r.ContentType,
      };
    } catch (err) {
      const e = err as { $metadata?: { httpStatusCode?: number } };
      if (e?.$metadata?.httpStatusCode === 404) return { exists: false };
      throw err;
    }
  }

  async createMultipartUpload({ key, contentType }: { key: string; contentType?: string }) {
    const r = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!r.UploadId) throw new Error("S3 CreateMultipartUpload returned no UploadId");
    return { uploadId: r.UploadId };
  }

  async signUploadPart({
    key,
    uploadId,
    partNumber,
    ttlSeconds = 3600,
  }: { key: string; uploadId: string; partNumber: number; ttlSeconds?: number }) {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  async completeMultipartUpload({
    key,
    uploadId,
    parts,
  }: { key: string; uploadId: string; parts: MultipartPart[] }) {
    // S3 requires parts to be sorted ascending by PartNumber and each ETag
    // to be wrapped in double quotes. Some clients strip the quotes when
    // reading the header — be lenient and re-add them if missing.
    const normalized = [...parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => ({
        PartNumber: p.partNumber,
        ETag: p.etag.startsWith("\"") ? p.etag : `"${p.etag}"`,
      }));
    const r = await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: normalized },
      }),
    );
    return {
      key,
      etag: r.ETag ?? null,
      location: r.Location ?? this.publicUrl(key),
    };
  }

  async abortMultipartUpload({ key, uploadId }: { key: string; uploadId: string }) {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }
}

let _storage: ObjectStorage | null = null;
export function storage(): ObjectStorage {
  if (_storage) return _storage;
  if (!env.S3_BUCKET) {
    logger.warn("S3_BUCKET not set — object storage disabled");
    _storage = new DisabledStorage();
  } else {
    _storage = new S3Storage(env.S3_BUCKET);
    logger.info({ bucket: env.S3_BUCKET, region: env.S3_REGION }, "object storage ready");
  }
  return _storage;
}
