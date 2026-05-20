import { sql } from "drizzle-orm";
import { schema } from "./db.js";

const videos = schema.videosTable;

/**
 * Walk the Drizzle/pg error chain to detect PostgreSQL SQLSTATE 42703 ("undefined_column").
 *
 * Drizzle wraps the raw `pg` error in `_DrizzleQueryError`, so the SQLSTATE code lives on
 * `err.cause.code`, NOT on `err.code` directly. We also check the error message text
 * ('column "x" does not exist') as a belt-and-suspenders fallback.
 *
 * @param err   - The error to inspect (any shape; non-Error values return false).
 * @param column - Optional column name to narrow the match (e.g. "faststart_applied").
 *                When omitted any "does not exist" message is matched.
 */
export function isUndefinedColumnError(err: unknown, column?: string): boolean {
  if (!(err instanceof Error)) return false;
  let node: unknown = err;
  while (node instanceof Error) {
    const code = (node as { code?: string }).code;
    if (code === "42703") return true;
    if (node.message.includes("does not exist")) {
      if (!column || node.message.includes(column)) return true;
    }
    node = node.cause;
  }
  return false;
}

/**
 * Explicit column projection for `managed_videos` that is safe on production DBs
 * whose schema pre-dates the `metadata_locked` and `faststart_applied` columns.
 *
 * How it works: uses hardcoded SQL `false` for the two missing boolean columns so
 * PostgreSQL never sees their names in the query and never throws 42703. Every other
 * column is referenced directly — only the two late-added booleans get the fallback.
 *
 * Usage pattern (try full SELECT *, fall back here on column error):
 *
 *   let rows: (typeof videos.$inferSelect)[];
 *   try {
 *     rows = await db.select().from(videos).where(cond).limit(n);
 *   } catch (err) {
 *     if (!isUndefinedColumnError(err)) throw err;
 *     rows = await db.select(SAFE_VIDEO_COLS).from(videos).where(cond).limit(n)
 *       as unknown as (typeof videos.$inferSelect)[];
 *   }
 *
 * The `as unknown as` cast is safe: the SQL `false` literal returns a JS boolean at
 * runtime, which is exactly what callers (toDto etc.) expect from metadataLocked /
 * faststartApplied. Once the migration runs on production (Render deploy executes
 * `push-force`), the primary SELECT * path is used and this projection is never hit.
 */
export const SAFE_VIDEO_COLS = {
  id:                    videos.id,
  youtubeId:             videos.youtubeId,
  title:                 videos.title,
  description:           videos.description,
  thumbnailUrl:          videos.thumbnailUrl,
  duration:              videos.duration,
  category:              videos.category,
  preacher:              videos.preacher,
  publishedAt:           videos.publishedAt,
  importedAt:            videos.importedAt,
  viewCount:             videos.viewCount,
  featured:              videos.featured,
  videoSource:           videos.videoSource,
  localVideoUrl:         videos.localVideoUrl,
  hlsMasterUrl:          videos.hlsMasterUrl,
  transcodingStatus:     videos.transcodingStatus,
  originalFilename:      videos.originalFilename,
  mimeType:              videos.mimeType,
  sizeBytes:             videos.sizeBytes,
  checksumSha256:        videos.checksumSha256,
  objectPath:            videos.objectPath,
  uploadedBy:            videos.uploadedBy,
  s3MirroredAt:          videos.s3MirroredAt,
  sourceCleanupStatus:   videos.sourceCleanupStatus,
  sourceCleanupAfter:    videos.sourceCleanupAfter,
  sourceDeletedAt:       videos.sourceDeletedAt,
  sourceCleanupAttempts: videos.sourceCleanupAttempts,
  // Late-added boolean columns — hardcoded false so no column reference appears
  // in the SQL until the migration adds them (next Render deploy via push-force).
  metadataLocked:   sql<boolean>`false`,
  faststartApplied: sql<boolean>`false`,
  broadcastOnly:    sql<boolean>`false`,
} as const;
