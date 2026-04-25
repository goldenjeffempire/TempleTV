/**
 * High-level object-storage service backed by AWS S3.
 *
 * This module is the application-facing facade for media organisation:
 *   - public assets live under one or more "search paths" (prefixes inside
 *     the bucket, comma-separated in PUBLIC_OBJECT_SEARCH_PATHS)
 *   - private/uploaded assets live under a single PRIVATE_OBJECT_DIR prefix
 *
 * URLs returned to clients use the platform-stable `/objects/<entityId>`
 * shape, which is then mapped back to a real S3 key by the route handler.
 *
 * All low-level S3 calls (PutObject, GetObject, presigned URLs, etc.) are
 * delegated to `s3Storage.ts` so that this layer stays focused on
 * organisation, ACLs, and request/response wiring.
 */

import { Readable } from "stream";
import { randomUUID } from "crypto";
import {
  ObjectAclPolicy,
  ObjectPermission,
  canAccessObject,
  getObjectAclPolicy,
  setObjectAclPolicy,
} from "./objectAcl";
import {
  AWS_S3_BUCKET,
  getObjectStream,
  getSignedPutUrl,
  isS3Configured,
  objectExists,
  publicS3Url,
  s3UrlToKey,
} from "./s3Storage";

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class ObjectStorageService {
  constructor() {}

  /**
   * Comma-separated list of public prefixes to search for an asset.
   * A "search path" may include a leading bucket prefix for backward
   * compatibility (e.g. `mybucket/public/`); the bucket portion is stripped
   * before the key is used against S3.
   */
  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0),
      ),
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Set it to a comma-separated " +
          "list of prefixes inside your S3 bucket (e.g. 'public/').",
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Set it to a prefix inside your " +
          "S3 bucket (e.g. 'private/').",
      );
    }
    return dir;
  }

  /**
   * Searches every configured public prefix for `filePath` and returns the
   * first matching S3 key, or null if no prefix contains it.
   */
  async searchPublicObject(filePath: string): Promise<string | null> {
    if (!isS3Configured()) return null;
    const cleanFile = filePath.replace(/^\/+/, "");
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = stripBucketPrefix(`${searchPath}/${cleanFile}`).replace(
        /\/{2,}/g,
        "/",
      );
      if (await objectExists(fullPath)) {
        return fullPath;
      }
    }
    return null;
  }

  /**
   * Stream an S3 object back to the caller as a Web `Response`. Honours the
   * stored ACL policy when deciding whether to mark the response public or
   * private in the Cache-Control header.
   */
  async downloadObject(
    objectKey: string,
    cacheTtlSec: number = 3600,
  ): Promise<Response> {
    const result = await getObjectStream(objectKey);
    if (!result) throw new ObjectNotFoundError();

    const aclPolicy = await getObjectAclPolicy(objectKey);
    const isPublic = aclPolicy?.visibility === "public";

    const webStream = Readable.toWeb(result.body) as ReadableStream;

    const headers: Record<string, string> = {
      "Content-Type": result.meta.contentType || "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (typeof result.meta.contentLength === "number") {
      headers["Content-Length"] = String(result.meta.contentLength);
    }

    return new Response(webStream, { headers });
  }

  /**
   * Mint a short-lived presigned PUT URL into the private uploads area.
   * Returned to the browser/client which then PUTs the file directly to S3,
   * bypassing the API server entirely.
   */
  async getObjectEntityUploadURL(): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    const objectId = randomUUID();
    const key = stripBucketPrefix(
      `${privateObjectDir.replace(/\/$/, "")}/uploads/${objectId}`,
    );
    return getSignedPutUrl(key, 900);
  }

  /**
   * Resolve a stable `/objects/<entityId>` path to its real S3 key, throwing
   * `ObjectNotFoundError` if the underlying object is missing.
   */
  async getObjectEntityFile(objectPath: string): Promise<string> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
    const objectKey = stripBucketPrefix(`${entityDir}${entityId}`);
    if (!(await objectExists(objectKey))) {
      throw new ObjectNotFoundError();
    }
    return objectKey;
  }

  /**
   * Convert an upload-time absolute URL (e.g. an S3 presigned URL the client
   * just PUT to) into the stable `/objects/<entityId>` representation, so
   * downstream code never has to deal with mutable signed URLs.
   */
  normalizeObjectEntityPath(rawPath: string): string {
    const key = s3UrlToKey(rawPath);
    if (!key) {
      // Already a relative path or an unrecognised URL — pass through.
      return rawPath;
    }

    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) objectEntityDir = `${objectEntityDir}/`;
    const stripped = stripBucketPrefix(objectEntityDir);

    if (!key.startsWith(stripped)) {
      return `/${key}`;
    }

    const entityId = key.slice(stripped.length);
    return `/objects/${entityId}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy,
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }

    const objectKey = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectKey, aclPolicy);
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectKey,
    requestedPermission,
  }: {
    userId?: string;
    objectKey: string;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectKey,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }

  /**
   * Convenience: build the canonical https URL for a key in the configured
   * bucket. Used by transcoder output and other producers that emit a
   * stable URL into the database.
   */
  publicUrlForKey(key: string): string {
    return publicS3Url(key);
  }
}

/**
 * If a configured prefix accidentally includes the bucket name as its first
 * segment (legacy GCS-style paths kept this convention), strip it so the rest
 * of the code can treat every path as a bucket-relative S3 key.
 */
function stripBucketPrefix(input: string): string {
  let key = input.startsWith("/") ? input.slice(1) : input;
  const prefix = `${AWS_S3_BUCKET}/`;
  if (AWS_S3_BUCKET && key.startsWith(prefix)) {
    key = key.slice(prefix.length);
  }
  return key;
}
