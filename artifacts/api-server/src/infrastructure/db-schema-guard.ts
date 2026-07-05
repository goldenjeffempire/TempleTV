import { sql } from "drizzle-orm";
import { schema } from "./db.js";

// ── PostgreSQL / Drizzle error extraction ─────────────────────────────────────

/**
 * Structured representation of a PostgreSQL error as surfaced by node-postgres
 * and optionally wrapped by Drizzle's `_DrizzleQueryError`.
 *
 * All fields are optional — a given error may carry only a subset of them
 * depending on whether the DB server included them in its ErrorResponse wire
 * message (protocol field availability varies by statement type).
 */
export interface PgErrorDetail {
  /** SQLSTATE code, e.g. "23505" (unique_violation), "42703" (undefined_column) */
  sqlstate?: string;
  /** PostgreSQL error severity, e.g. "ERROR", "FATAL" */
  severity?: string;
  /** Constraint name for constraint-violation errors */
  constraint?: string;
  /** Column name for NOT NULL / type errors */
  column?: string;
  /** Table name associated with the error */
  table?: string;
  /** PostgreSQL `DETAIL` field — human-readable extra context */
  detail?: string;
  /** PostgreSQL `HINT` field */
  hint?: string;
  /** Full error message from the innermost node in the error chain */
  message?: string;
}

/**
 * Walk the Error cause chain (Drizzle wraps pg errors in `_DrizzleQueryError`)
 * and extract PostgreSQL-specific fields from the first node that carries a
 * SQLSTATE `code` property.
 *
 * Usage in structured log calls:
 *
 *   logger.warn(
 *     { youtubeId, pgErr: extractPgError(err), err },
 *     "youtube-sync: row failed",
 *   );
 *
 * The `err` field is kept alongside so pino serialises the full stack trace.
 * `pgErr` provides the fast-lookup fields (sqlstate, constraint, detail)
 * without having to grep through truncated message strings.
 */
export function extractPgError(err: unknown): PgErrorDetail {
  if (!(err instanceof Error)) return { message: String(err) };

  let node: unknown = err;
  while (node instanceof Error) {
    const n = node as unknown as Record<string, unknown>;
    // node-postgres attaches SQLSTATE as `code`; Drizzle's wrapper does not.
    if (typeof n.code === "string" && /^[0-9A-Z]{5}$/.test(n.code)) {
      return {
        sqlstate:   n.code as string,
        severity:   typeof n.severity  === "string" ? n.severity  : undefined,
        constraint: typeof n.constraint === "string" ? n.constraint : undefined,
        column:     typeof n.column    === "string" ? n.column    : undefined,
        table:      typeof n.table     === "string" ? n.table     : undefined,
        detail:     typeof n.detail    === "string" ? n.detail    : undefined,
        hint:       typeof n.hint      === "string" ? n.hint      : undefined,
        message:    node.message,
      };
    }
    node = (node as { cause?: unknown }).cause;
  }

  // No SQLSTATE found — return just the top-level message.
  return { message: (err as Error).message };
}

/**
 * Return true when the PostgreSQL SQLSTATE indicates the operation should be
 * retried (transient infrastructure error), false when it is a permanent
 * application-level failure (constraint violation, type mismatch, etc.).
 *
 * Uses SQLSTATE codes rather than message-string matching so the classification
 * is not confused by coincidental keyword matches (e.g. a column named
 * "connection_id" producing a false "connection" hit).
 *
 * SQLSTATE classes:
 *   08xxx — Connection exceptions
 *   40001 — Serialization failure (REPEATABLE READ / SERIALIZABLE)
 *   40P01 — Deadlock detected
 *   57014 — Query canceled (lock timeout, statement timeout)
 *   53xxx — Insufficient resources (too_many_connections = 53300)
 *
 * Everything else (23xxx constraint violations, 42xxx syntax/object-not-found,
 * 22xxx data exceptions, etc.) is permanent — retrying will not help.
 */
export function isTransientPgError(err: unknown): boolean {
  const { sqlstate } = extractPgError(err);
  if (!sqlstate) {
    // No SQLSTATE — fall back to message-text heuristics for non-pg errors
    // (e.g. Node.js ECONNRESET, DNS failures before a connection is made).
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return (
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("connection terminated") ||
      msg.includes("connection refused") ||
      msg.includes("etimedout") ||
      msg.includes("too many clients")
    );
  }
  return (
    sqlstate.startsWith("08") ||   // connection exceptions
    sqlstate === "40001"         || // serialization failure
    sqlstate === "40P01"         || // deadlock detected
    sqlstate === "57014"         || // query canceled (lock/stmt timeout)
    sqlstate.startsWith("53")       // insufficient resources incl. 53300
  );
}

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
  // Late-added boolean columns — hardcoded safe fallbacks so no column
  // reference appears in the SQL until the migration adds them.
  //
  // metadataLocked / broadcastOnly default to false: safe conservative values
  // (metadata is editable; video is not hidden from the public catalog).
  metadataLocked:   sql<boolean>`false`,
  broadcastOnly:    sql<boolean>`false`,
  // Late-added text columns — hardcoded NULL so no column reference appears
  // in the SQL until the migration adds them.
  transcodingErrorMessage:      sql<string | null>`NULL`,
  transcodingErrorCode:         sql<string | null>`NULL`,
  youtubeLiveStatus:            sql<string | null>`NULL`,
  // Timestamp companion to youtubeLiveStatus — must be in SAFE_VIDEO_COLS
  // together with youtubeLiveStatus or any query using SAFE_VIDEO_COLS that
  // also reads youtubeLiveStatusUpdatedAt will throw 42703.
  youtubeLiveStatusUpdatedAt:   sql<Date | null>`NULL`,
  // Late-added text column: machine-readable error sub-kind for terminal
  // transcoding failures ('moov_absent', 'structure_invalid', etc.).
  // Stubbed NULL here so pre-migration DBs that lack the column never see
  // its name in a query and never throw 42703.
  transcodingErrorKind:         sql<string | null>`NULL`,
} as const;
