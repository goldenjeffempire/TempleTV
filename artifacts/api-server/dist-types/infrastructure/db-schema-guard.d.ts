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
export declare function extractPgError(err: unknown): PgErrorDetail;
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
export declare function isTransientPgError(err: unknown): boolean;
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
export declare function isUndefinedColumnError(err: unknown, column?: string): boolean;
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
export declare const SAFE_VIDEO_COLS: {
    readonly id: import("drizzle-orm/pg-core").PgColumn<{
        name: "id";
        tableName: "managed_videos";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: true;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly youtubeId: import("drizzle-orm/pg-core").PgColumn<{
        name: "youtube_id";
        tableName: "managed_videos";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly title: import("drizzle-orm/pg-core").PgColumn<{
        name: "title";
        tableName: "managed_videos";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly description: import("drizzle-orm/pg-core").PgColumn<{
        name: "description";
        tableName: "managed_videos";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly thumbnailUrl: import("drizzle-orm/pg-core").PgColumn<{
        name: "thumbnail_url";
        tableName: "managed_videos";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly duration: import("drizzle-orm/pg-core").PgColumn<{
        name: "duration";
        tableName: "managed_videos";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly category: import("drizzle-orm/pg-core").PgColumn<{
        name: "category";
        tableName: "managed_videos";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly preacher: import("drizzle-orm/pg-core").PgColumn<{
        name: "preacher";
        tableName: "managed_videos";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly publishedAt: import("drizzle-orm/pg-core").PgColumn<{
        name: "published_at";
        tableName: "managed_videos";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly importedAt: import("drizzle-orm/pg-core").PgColumn<{
        name: "imported_at";
        tableName: "managed_videos";
        dataType: "date";
        columnType: "PgTimestamp";
        data: Date;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly viewCount: import("drizzle-orm/pg-core").PgColumn<{
        name: "view_count";
        tableName: "managed_videos";
        dataType: "number";
        columnType: "PgInteger";
        data: number;
        driverParam: string | number;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly featured: import("drizzle-orm/pg-core").PgColumn<{
        name: "featured";
        tableName: "managed_videos";
        dataType: "boolean";
        columnType: "PgBoolean";
        data: boolean;
        driverParam: boolean;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly videoSource: import("drizzle-orm/pg-core").PgColumn<{
        name: "video_source";
        tableName: "managed_videos";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly localVideoUrl: import("drizzle-orm/pg-core").PgColumn<{
        name: "local_video_url";
        tableName: "managed_videos";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly hlsMasterUrl: import("drizzle-orm/pg-core").PgColumn<{
        name: "hls_master_url";
        tableName: "managed_videos";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly transcodingStatus: import("drizzle-orm/pg-core").PgColumn<{
        name: "transcoding_status";
        tableName: "managed_videos";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly originalFilename: import("drizzle-orm/pg-core").PgColumn<{
        name: "original_filename";
        tableName: "managed_videos";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly mimeType: import("drizzle-orm/pg-core").PgColumn<{
        name: "mime_type";
        tableName: "managed_videos";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly sizeBytes: import("drizzle-orm/pg-core").PgColumn<{
        name: "size_bytes";
        tableName: "managed_videos";
        dataType: "number";
        columnType: "PgBigInt53";
        data: number;
        driverParam: string | number;
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly checksumSha256: import("drizzle-orm/pg-core").PgColumn<{
        name: "checksum_sha256";
        tableName: "managed_videos";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly objectPath: import("drizzle-orm/pg-core").PgColumn<{
        name: "object_path";
        tableName: "managed_videos";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly uploadedBy: import("drizzle-orm/pg-core").PgColumn<{
        name: "uploaded_by";
        tableName: "managed_videos";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly s3MirroredAt: import("drizzle-orm/pg-core").PgColumn<{
        name: "s3_mirrored_at";
        tableName: "managed_videos";
        dataType: "date";
        columnType: "PgTimestamp";
        data: Date;
        driverParam: string;
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly sourceCleanupStatus: import("drizzle-orm/pg-core").PgColumn<{
        name: "source_cleanup_status";
        tableName: "managed_videos";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly sourceCleanupAfter: import("drizzle-orm/pg-core").PgColumn<{
        name: "source_cleanup_after";
        tableName: "managed_videos";
        dataType: "date";
        columnType: "PgTimestamp";
        data: Date;
        driverParam: string;
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly sourceDeletedAt: import("drizzle-orm/pg-core").PgColumn<{
        name: "source_deleted_at";
        tableName: "managed_videos";
        dataType: "date";
        columnType: "PgTimestamp";
        data: Date;
        driverParam: string;
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly sourceCleanupAttempts: import("drizzle-orm/pg-core").PgColumn<{
        name: "source_cleanup_attempts";
        tableName: "managed_videos";
        dataType: "number";
        columnType: "PgInteger";
        data: number;
        driverParam: string | number;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
    }, {}, {}>;
    readonly metadataLocked: import("drizzle-orm").SQL<boolean>;
    readonly faststartApplied: import("drizzle-orm").SQL<boolean>;
    readonly broadcastOnly: import("drizzle-orm").SQL<boolean>;
    readonly transcodingErrorMessage: import("drizzle-orm").SQL<string | null>;
    readonly transcodingErrorCode: import("drizzle-orm").SQL<string | null>;
    readonly youtubeLiveStatus: import("drizzle-orm").SQL<string | null>;
    readonly youtubeLiveStatusUpdatedAt: import("drizzle-orm").SQL<Date | null>;
    readonly transcodingErrorKind: import("drizzle-orm").SQL<string | null>;
    readonly faststartAttempts: import("drizzle-orm").SQL<number>;
};
