import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { storage } from "../../infrastructure/storage.js";
import { requireAuth } from "../../middleware/auth.js";
import { uploadSessions } from "./upload-sessions.js";

/**
 * S3 multipart upload gateway used by the admin VideoUploadModal.
 *
 * Wire (matches `artifacts/admin/src/components/VideoUploadModal.tsx`
 * and `artifacts/admin/src/lib/uploadEngine.ts`):
 *
 *   1. POST /admin/videos/upload/s3-multipart-init
 *      → server creates the S3 multipart upload, registers the session,
 *        returns { sessionId, uploadId, objectKey, partSize, totalParts,
 *                  contentType }.
 *   2. POST /admin/videos/upload/s3-multipart-sign
 *      → server presigns N PartUpload URLs (≤500 per call). Browser PUTs
 *        each part directly to S3 in parallel.
 *   3. POST /admin/videos/upload/s3-multipart-complete
 *      → server CompleteMultipartUpload + HEAD-verify + insert videos
 *        row. Idempotent: a second call with the same sessionId returns
 *        the row from the first call.
 *   4. POST /admin/videos/upload/s3-multipart-abort
 *      → server AbortMultipartUpload + drops the session.
 *
 * Plus:
 *   - POST /admin/videos/upload/s3-init   single-PUT presigned URL for
 *                                          small files / smoke tests.
 *   - POST /admin/videos/upload/s3-cors-test
 *                                          1-byte presigned PUT used by
 *                                          the S3CorsTestButton.
 *
 * All endpoints require `editor` role. The admin Operations tab's
 * `GET /admin/uploads/active` and `DELETE /admin/videos/upload/:id` read
 * and mutate the same `uploadSessions` registry.
 */

// S3 hard limits — caller is expected to enforce these but we double-check.
const S3_MIN_PART_BYTES = 5 * 1024 * 1024;       // 5 MiB
const S3_MAX_PARTS = 10_000;
const SIGN_BATCH_LIMIT = 1000;
const PART_URL_TTL_SECS = 3600;                  // 1 hour

const videos = schema.videosTable;

const InitBodySchema = z.object({
  title: z.string().min(1).max(500),
  sizeBytes: z.number().int().positive().max(50 * 1024 * 1024 * 1024),
  ext: z.string().max(16),
  mimeType: z.string().max(255).optional(),
  partSize: z.number().int().positive(),
});

const InitResponseSchema = z.object({
  sessionId: z.string(),
  uploadId: z.string(),
  objectKey: z.string(),
  partSize: z.number().int().positive(),
  totalParts: z.number().int().positive(),
  contentType: z.string(),
});

const SignBodySchema = z.object({
  uploadId: z.string(),
  objectKey: z.string(),
  partNumbers: z.array(z.number().int().positive()).min(1).max(SIGN_BATCH_LIMIT),
});

const SignResponseSchema = z.object({
  urls: z.array(z.object({ partNumber: z.number().int().positive(), url: z.string() })),
});

const CompleteBodySchema = z.object({
  sessionId: z.string(),
  uploadId: z.string(),
  objectKey: z.string(),
  parts: z
    .array(z.object({ partNumber: z.number().int().positive(), etag: z.string() }))
    .min(1),
  title: z.string().min(1).max(500),
  category: z.string().max(64).optional().nullable(),
  preacher: z.string().max(255).optional().nullable(),
  featured: z.boolean().optional(),
  durationSecs: z.number().nonnegative().optional(),
  sizeBytes: z.number().int().positive(),
  mimeType: z.string().max(255).optional(),
  originalFilename: z.string().max(500).optional(),
  clientDurationMs: z.number().nonnegative().optional(),
});

const VideoRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  videoSource: z.string(),
  localVideoUrl: z.string().nullable(),
  duration: z.number().nullable(),
  category: z.string().nullable(),
  preacher: z.string().nullable(),
  featured: z.boolean(),
});

const AbortBodySchema = z.object({
  uploadId: z.string(),
  objectKey: z.string(),
});

const SingleInitResponseSchema = z.object({
  presignedUrl: z.string(),
  objectKey: z.string(),
  bucket: z.string(),
  region: z.string(),
});

function safeExt(ext: string): string {
  const cleaned = ext.replace(/^\./, "").toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(cleaned) ? cleaned : "bin";
}

function buildObjectKey(ext: string): string {
  // Datestamped prefix keeps the bucket browsable and lets lifecycle
  // rules expire orphan parts by date.
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `uploads/${yyyy}/${mm}/${dd}/${randomUUID()}.${safeExt(ext)}`;
}

function ensureStorageEnabled(): void {
  if (!storage().enabled) {
    throw Object.assign(new Error("Object storage not configured (set S3_BUCKET + AWS credentials)"), {
      statusCode: 503,
    });
  }
}

export async function mediaUploadsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/videos/upload/s3-multipart-init",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["uploads"],
        summary: "Begin an S3 multipart upload session",
        body: InitBodySchema,
        response: { 200: InitResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      ensureStorageEnabled();
      const body = req.body as z.infer<typeof InitBodySchema>;
      // Clamp the part size to S3's minimum (5 MiB) so we don't get a
      // surprise EntityTooSmall on Complete. The client already clamps
      // but a stale build could slip through.
      const partSize = Math.max(S3_MIN_PART_BYTES, body.partSize);
      const totalParts = Math.min(
        S3_MAX_PARTS,
        Math.max(1, Math.ceil(body.sizeBytes / partSize)),
      );
      const contentType = body.mimeType || "application/octet-stream";
      const objectKey = buildObjectKey(body.ext);

      const { uploadId } = await storage().createMultipartUpload({
        key: objectKey,
        contentType,
      });

      const session = uploadSessions.start({
        uploadId,
        objectKey,
        title: body.title,
        contentType,
        sizeBytes: body.sizeBytes,
        partSize,
        totalParts,
      });

      req.log.info(
        { sessionId: session.sessionId, uploadId, objectKey, totalParts, sizeBytes: body.sizeBytes },
        "[s3-multipart-init]",
      );

      return {
        sessionId: session.sessionId,
        uploadId,
        objectKey,
        partSize,
        totalParts,
        contentType,
      };
    },
  );

  r.post(
    "/videos/upload/s3-multipart-sign",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["uploads"],
        summary: "Presign a batch of multipart-upload PUT URLs",
        body: SignBodySchema,
        response: { 200: SignResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      ensureStorageEnabled();
      const body = req.body as z.infer<typeof SignBodySchema>;
      const urls = await Promise.all(
        body.partNumbers.map(async (partNumber) => ({
          partNumber,
          url: await storage().signUploadPart({
            key: body.objectKey,
            uploadId: body.uploadId,
            partNumber,
            ttlSeconds: PART_URL_TTL_SECS,
          }),
        })),
      );
      return { urls };
    },
  );

  r.post(
    "/videos/upload/s3-multipart-complete",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["uploads"],
        summary: "Complete the multipart upload and register the video row",
        body: CompleteBodySchema,
        response: { 200: VideoRowSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      ensureStorageEnabled();
      const body = req.body as z.infer<typeof CompleteBodySchema>;
      const session = uploadSessions.get(body.sessionId);

      // Idempotency guard. If a previous Complete already inserted the
      // videos row, return the same row instead of double-completing
      // (the client retries this endpoint up to 3× on 5xx/timeouts —
      // see VideoUploadModal "Robust multipart-complete with timeout +
      // retry").
      if (session?.completedVideoId) {
        const rows = await db
          .select()
          .from(videos)
          .where(eq(videos.id, session.completedVideoId))
          .limit(1);
        if (rows[0]) {
          return projectVideoRow(rows[0]);
        }
      }

      const completed = await storage().completeMultipartUpload({
        key: body.objectKey,
        uploadId: body.uploadId,
        parts: body.parts,
      });

      // Verify the final object exists and the size matches what the
      // client claimed; mismatches usually indicate a part was dropped
      // silently by a flaky proxy mid-upload.
      const head = await storage().headObject(body.objectKey);
      if (!head.exists) {
        throw Object.assign(new Error("S3 reports the assembled object does not exist"), {
          statusCode: 502,
        });
      }
      if (head.contentLength != null && head.contentLength !== body.sizeBytes) {
        req.log.warn(
          {
            objectKey: body.objectKey,
            expectedBytes: body.sizeBytes,
            actualBytes: head.contentLength,
          },
          "[s3-multipart-complete] size mismatch",
        );
      }

      const localVideoUrl = completed.location || storage().publicUrl(body.objectKey);
      const videoId = randomUUID();
      const inserted = await db
        .insert(videos)
        .values({
          id: videoId,
          // YouTube-id is required-not-null in the legacy schema; fabricate
          // a synthetic one for native uploads so the insert succeeds and
          // joins on `youtubeId` continue to work.
          youtubeId: `local-${videoId}`,
          title: body.title,
          description: null,
          thumbnailUrl: "",
          duration: body.durationSecs ? Math.round(body.durationSecs) : 0,
          category: body.category ?? null,
          preacher: body.preacher ?? null,
          publishedAt: null,
          videoSource: "local",
          localVideoUrl: localVideoUrl ?? null,
          featured: body.featured ?? false,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("videos insert returned no rows");

      uploadSessions.markCompleted(body.sessionId, row.id);
      // Drop the session shortly after so it doesn't pile up in the
      // admin Operations tab. The idempotency window is small (the
      // client retries within 90 s × 3 attempts = ~5 minutes max).
      setTimeout(() => uploadSessions.remove(body.sessionId), 10 * 60 * 1000).unref();

      req.log.info(
        {
          sessionId: body.sessionId,
          videoId: row.id,
          objectKey: body.objectKey,
          sizeBytes: body.sizeBytes,
          clientDurationMs: body.clientDurationMs,
        },
        "[s3-multipart-complete] ok",
      );

      return projectVideoRow(row);
    },
  );

  r.post(
    "/videos/upload/s3-multipart-abort",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["uploads"],
        summary: "Abort an in-flight multipart upload",
        body: AbortBodySchema,
        response: { 200: z.object({ ok: z.literal(true) }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      ensureStorageEnabled();
      const body = req.body as z.infer<typeof AbortBodySchema>;
      try {
        await storage().abortMultipartUpload({
          key: body.objectKey,
          uploadId: body.uploadId,
        });
      } catch (err) {
        // Lifecycle reaps orphans even if the abort fails; log and ack
        // so the client doesn't hang on cleanup.
        req.log.warn({ err, objectKey: body.objectKey }, "[s3-multipart-abort] failed");
      }
      return { ok: true as const };
    },
  );

  // Single-PUT presigned URL — used for small files and the test button.
  r.post(
    "/videos/upload/s3-init",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["uploads"],
        summary: "Get a single presigned PUT URL for small files",
        body: z.object({
          ext: z.string().max(16).default("bin"),
          mimeType: z.string().max(255).optional(),
        }),
        response: { 200: SingleInitResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      ensureStorageEnabled();
      const body = req.body as { ext?: string; mimeType?: string };
      const objectKey = buildObjectKey(body.ext ?? "bin");
      const { url } = await storage().signedUploadUrl({
        key: objectKey,
        contentType: body.mimeType ?? "application/octet-stream",
        ttlSeconds: 900,
      });
      return {
        presignedUrl: url,
        objectKey,
        bucket: storage().bucket ?? "",
        region: storage().region ?? "",
      };
    },
  );

  // 1-byte CORS probe used by the S3CorsTestButton in the admin
  // Operations tab to verify the bucket's CORS policy without burning
  // a real upload.
  r.post(
    "/videos/upload/s3-cors-test",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["uploads"],
        summary: "Mint a presigned PUT URL for the 21-byte CORS probe",
        body: z.object({}).passthrough(),
        response: { 200: SingleInitResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      ensureStorageEnabled();
      const objectKey = `cors-probes/${randomUUID()}.bin`;
      const { url } = await storage().signedUploadUrl({
        key: objectKey,
        contentType: "application/octet-stream",
        ttlSeconds: 300,
      });
      return {
        presignedUrl: url,
        objectKey,
        bucket: storage().bucket ?? "",
        region: storage().region ?? "",
      };
    },
  );
}

function projectVideoRow(row: typeof videos.$inferSelect): z.infer<typeof VideoRowSchema> {
  return {
    id: row.id,
    title: row.title,
    videoSource: row.videoSource,
    localVideoUrl: row.localVideoUrl,
    duration: row.duration,
    category: row.category,
    preacher: row.preacher,
    featured: row.featured,
  };
}
