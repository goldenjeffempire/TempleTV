import { Readable } from "stream";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * Issue a ranged GET against the configured S3 bucket.
 *
 * `s3Storage.ts` exposes the high-level helpers (getObjectStream / headObject)
 * but doesn't accept a Range parameter — adding one there would change the
 * public API surface. Instead we reuse the same SDK config via the env vars
 * and ship a small dedicated helper that the fallback middleware can call.
 *
 * Returns `null` when the object doesn't exist or the bucket isn't configured,
 * so callers can `next()` cleanly and let the 404 handler respond.
 */

let cachedClient: S3Client | null = null;

function client(): S3Client | null {
  const region = process.env.AWS_REGION;
  const bucket = process.env.AWS_S3_BUCKET;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!region || !bucket || !accessKeyId || !secretAccessKey) return null;

  if (!cachedClient) {
    const endpoint = process.env.AWS_S3_ENDPOINT || undefined;
    const forcePathStyle =
      String(process.env.AWS_S3_FORCE_PATH_STYLE ?? "").toLowerCase() === "true" ||
      Boolean(endpoint);

    cachedClient = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
      ...(endpoint ? { endpoint, forcePathStyle } : {}),
    });
  }
  return cachedClient;
}

export async function sendRangedGet(
  key: string,
  rangeHeaderValue: string,
): Promise<{ body: Readable; contentLength: number | null; contentRange: string | null } | null> {
  const c = client();
  const bucket = process.env.AWS_S3_BUCKET;
  if (!c || !bucket) return null;

  try {
    const out = await c.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key.replace(/^\/+/, ""),
        Range: rangeHeaderValue,
      }),
    );
    if (!out.Body) return null;
    return {
      body: out.Body as Readable,
      contentLength:
        typeof out.ContentLength === "number" ? out.ContentLength : null,
      contentRange: out.ContentRange ?? null,
    };
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (
      e?.name === "NoSuchKey" ||
      e?.name === "NotFound" ||
      e?.$metadata?.httpStatusCode === 404
    ) {
      return null;
    }
    throw err;
  }
}
