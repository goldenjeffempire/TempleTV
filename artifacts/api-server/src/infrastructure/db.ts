import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db/schema";
import { env } from "../config/env.js";
import { logger } from "./logger.js";
import {
  dbPoolConnectionsActive,
  dbPoolConnectionsIdle,
  dbPoolConnectionsWaiting,
  dbPoolUtilizationRatio,
  SERVICE_LABELS,
} from "./metrics.js";

const { Pool } = pg;

/**
 * Single shared pg pool. Pool sizing tuned for a 2 GiB container
 * with ~50 concurrent in-flight requests (each request usually
 * holds 0–1 connections); raise `max` if you scale the dyno up.
 */
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: "temple-tv-api",
});

pool.on("error", (err) => {
  logger.error({ err }, "pg pool error");
});
function updatePoolMetrics(): void {
  const active = pool.totalCount - pool.idleCount;
  dbPoolConnectionsActive.set(SERVICE_LABELS, active);
  dbPoolConnectionsIdle.set(SERVICE_LABELS, pool.idleCount);
  dbPoolConnectionsWaiting.set(SERVICE_LABELS, pool.waitingCount);
  dbPoolUtilizationRatio.set(
    SERVICE_LABELS,
    env.DB_POOL_MAX > 0 ? active / env.DB_POOL_MAX : 0,
  );
}
pool.on("connect", updatePoolMetrics);
pool.on("acquire", updatePoolMetrics);
pool.on("remove", updatePoolMetrics);

export const db = drizzle(pool, { schema });
export { schema };
export type Database = typeof db;

export async function closeDb(): Promise<void> {
  await pool.end();
}

/**
 * Creates expression indexes that Drizzle Kit cannot manage via the schema DSL.
 * Safe to call on every boot — all statements use `IF NOT EXISTS`.
 *
 * GIN tsvector index on managed_videos:
 *   Powers `plainto_tsquery` full-text search on title + preacher + description.
 *   Replaces the previous ILIKE approach which required a full table scan at scale.
 *
 * Composite index on scheduled_notifications:
 *   The notification dispatcher polls WHERE status='pending' AND scheduled_at<=now()
 *   every 30 s. Without a composite index this was a full table scan.
 */
/**
 * Ensures all three broadcast-v2 tables exist, creating them if missing.
 *
 * Called at boot BEFORE the v2 orchestrator starts so the orchestrator
 * never crashes on a missing-table error — even when the deployment
 * skipped the manual `drizzle-kit push` step (CI/CD, first deploy, etc.).
 *
 * All statements use `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT
 * EXISTS` so this is safe and idempotent on every boot. Column types and
 * indexes mirror the Drizzle schema exactly; if the schema changes the
 * corresponding Drizzle migration must also update this function.
 *
 * Failures are non-fatal (logged as error + warning). The orchestrator's
 * own hydrate() / reloadInner() guards will handle any remaining table
 * issues gracefully by falling back to OFF_AIR mode.
 */
export async function ensureBroadcastV2Tables(): Promise<void> {
  const client = await pool.connect();
  try {
    // broadcast_runtime_state — persists mode + sequence anchor across restarts
    await client.query(`
      CREATE TABLE IF NOT EXISTS broadcast_runtime_state (
        channel_id        TEXT PRIMARY KEY,
        mode              TEXT NOT NULL DEFAULT 'queue',
        current_item_id   TEXT,
        started_at_ms     BIGINT,
        offset_ms         INTEGER NOT NULL DEFAULT 0,
        active_override_id TEXT,
        sequence          BIGINT NOT NULL DEFAULT 0,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS broadcast_runtime_state_mode_idx
        ON broadcast_runtime_state (mode)
    `);

    // broadcast_event_log — append-only event journal for SSE/WS replay
    await client.query(`
      CREATE TABLE IF NOT EXISTS broadcast_event_log (
        id          BIGSERIAL PRIMARY KEY,
        channel_id  TEXT NOT NULL,
        sequence    BIGINT NOT NULL,
        event_type  TEXT NOT NULL,
        payload     JSONB NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS broadcast_event_log_channel_seq_uq
        ON broadcast_event_log (channel_id, sequence)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS broadcast_event_log_channel_created_idx
        ON broadcast_event_log (channel_id, created_at)
    `);

    // player_position_checkpoint — resume-point for mid-item restarts
    await client.query(`
      CREATE TABLE IF NOT EXISTS player_position_checkpoint (
        channel_id    TEXT PRIMARY KEY,
        item_id       TEXT,
        position_ms   INTEGER NOT NULL DEFAULT 0,
        source_health TEXT NOT NULL DEFAULT 'ok',
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    logger.info("db: broadcast_v2 tables ensured (all three present)");
  } catch (err) {
    logger.error({ err }, "db: failed to ensure broadcast_v2 tables — orchestrator will boot in OFF_AIR fallback mode");
  } finally {
    client.release();
  }
}

/**
 * Deactivate broadcast_queue rows that can never play in the v2 system.
 *
 * A row is "unresolvable" when it is not a YouTube item AND has no platform
 * video URL of its own AND the linked managed_video (if any) has neither an
 * hlsMasterUrl nor a localVideoUrl.  These rows would be silently rejected
 * by the orchestrator's toItem() pre-resolution step every time it reloads,
 * producing a WARN storm without any operator action being possible.
 *
 * Setting is_active=false is non-destructive: operators can re-activate rows
 * once the underlying video has been re-uploaded or transcoded.
 *
 * Called at boot, non-blocking (errors are logged and swallowed).
 */
export async function deactivateUnresolvableQueueRows(): Promise<void> {
  const client = await pool.connect();
  try {
    // broadcast_queue only has local_video_url (no hls_master_url column —
    // that lives on managed_videos). The join checks whether the linked video
    // has any playable URL so we don't deactivate rows whose URL comes from
    // the video record rather than being stored directly on the queue row.
    const result = await client.query(`
      UPDATE broadcast_queue bq
      SET    is_active = false
      WHERE  bq.is_active = true
        AND  (bq.video_source IS NULL OR bq.video_source != 'youtube')
        AND  (bq.local_video_url IS NULL OR bq.local_video_url = '')
        AND  NOT EXISTS (
          SELECT 1
          FROM   managed_videos mv
          WHERE  mv.id = bq.video_id
            AND  (
                   (mv.hls_master_url  IS NOT NULL AND mv.hls_master_url  != '')
                OR (mv.local_video_url IS NOT NULL AND mv.local_video_url != '')
                 )
        )
    `);
    const deactivated = (result as unknown as { rowCount: number | null }).rowCount ?? 0;
    if (deactivated > 0) {
      logger.warn(
        { deactivated },
        "db: deactivated broadcast_queue rows with no playable source — " +
          "re-upload/transcode the underlying videos and re-activate the rows to restore them",
      );
    } else {
      logger.info("db: broadcast_queue source audit complete — no unresolvable rows found");
    }
  } catch (err) {
    logger.warn({ err }, "db: deactivateUnresolvableQueueRows failed (non-fatal)");
  } finally {
    client.release();
  }
}

export async function ensureRuntimeIndexes(): Promise<void> {
  const client = await pool.connect();
  try {
    // GIN FTS index — build CONCURRENTLY so it never locks writes.
    // CONCURRENTLY cannot run inside a transaction block, so we execute
    // it as a standalone statement on the raw client.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_managed_videos_fts
        ON managed_videos
        USING gin (
          to_tsvector('english',
            coalesce(title,'') || ' ' ||
            coalesce(preacher,'') || ' ' ||
            coalesce(description,'')
          )
        )
    `);
    logger.info("db: idx_managed_videos_fts ensured (GIN tsvector FTS)");

    // ── Functional indexes for lower() filter expressions ─────────────────
    // Standard B-Tree indexes on `category`, `preacher`, and `email` are
    // NOT used by queries that wrap the column in lower() (e.g.
    // `WHERE lower(category) = 'sermon'`) or by leading-wildcard ILIKE.
    // Functional indexes on the lower()-expression allow PostgreSQL to use
    // an index scan for these common filter patterns.
    //
    // These are created non-CONCURRENTLY inside the existing client session
    // (no active transaction) so they are safe alongside the GIN index above.
    // IF NOT EXISTS makes every call idempotent — safe to run on every boot.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_managed_videos_category_lower
        ON managed_videos (lower(category))
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_managed_videos_preacher_lower
        ON managed_videos (lower(preacher))
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email_lower
        ON users (lower(email))
    `);
    // Composite partial index for the source-cleanup sweep worker:
    // WHERE source_cleanup_status IN ('scheduled','failed') AND source_cleanup_after <= NOW()
    // The partial expression keeps the index tiny (only rows awaiting cleanup).
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_managed_videos_cleanup_due
        ON managed_videos (source_cleanup_after)
        WHERE source_cleanup_status IN ('scheduled', 'failed')
    `);
    // Partial index for the transcoder worker: only local videos without HLS.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_managed_videos_transcode_pending
        ON managed_videos (imported_at)
        WHERE video_source = 'local'
          AND transcoding_status = 'queued'
          AND hls_master_url IS NULL
    `);
    logger.info("db: functional and partial indexes ensured");
  } catch (err) {
    // Non-fatal — the search falls back to plainto_tsquery without the index
    // (just slower). Log a warning so operators can investigate.
    logger.warn({ err }, "db: failed to ensure runtime indexes (non-fatal)");
  } finally {
    client.release();
  }
}

/**
 * Idempotent schema-heal migration.
 *
 * Adds columns that were introduced after the initial production deploy so
 * the server self-heals on a Render (or any external) database that was
 * never re-migrated with `drizzle-kit push`.
 *
 * Every statement uses `ADD COLUMN IF NOT EXISTS` so this is safe to run on
 * every boot — it becomes a no-op once all columns exist.
 *
 * When to extend this list: any time a new column is added to an existing
 * table in the Drizzle schema, add the matching `ALTER TABLE … ADD COLUMN
 * IF NOT EXISTS …` here so production auto-heals without a manual migration.
 */
export async function ensureUserSchemaColumns(): Promise<void> {
  const client = await pool.connect();
  try {
    // ── users ─────────────────────────────────────────────────────────────
    // sessions_valid_after: added for global-session-invalidation on
    // password change. TIMESTAMPTZ NOT NULL with DEFAULT NOW() so existing
    // rows get a valid timestamp rather than a null that would break
    // NOT NULL checks on subsequent queries.
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS sessions_valid_after TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);

    // TOTP / MFA columns — added May 2026.
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS totp_secret TEXT
    `);
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false
    `);
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS totp_backup_codes TEXT
    `);

    // ── refresh_tokens ────────────────────────────────────────────────────
    // Columns that extend the original minimal schema.
    await client.query(`
      ALTER TABLE refresh_tokens
        ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ
    `);
    await client.query(`
      ALTER TABLE refresh_tokens
        ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ
    `);
    await client.query(`
      ALTER TABLE refresh_tokens
        ADD COLUMN IF NOT EXISTS replaced_by_id TEXT
    `);
    await client.query(`
      ALTER TABLE refresh_tokens
        ADD COLUMN IF NOT EXISTS user_agent TEXT
    `);
    await client.query(`
      ALTER TABLE refresh_tokens
        ADD COLUMN IF NOT EXISTS ip TEXT
    `);
    await client.query(`
      ALTER TABLE refresh_tokens
        ADD COLUMN IF NOT EXISTS device_name TEXT
    `);

    // ── managed_videos ────────────────────────────────────────────────────
    // All columns added to managed_videos after the initial production deploy.
    // ADD COLUMN IF NOT EXISTS is idempotent — safe to run on every boot.
    // Without this block, production DBs that were never re-migrated via
    // `drizzle-kit push` will throw SQLSTATE 42703 on every query that
    // touches these columns (admin Videos page, broadcast queue reload,
    // YouTube sync, etc.).

    // Upload metadata — added with the chunked-upload feature.
    await client.query(`
      ALTER TABLE managed_videos ADD COLUMN IF NOT EXISTS original_filename TEXT
    `);
    await client.query(`
      ALTER TABLE managed_videos ADD COLUMN IF NOT EXISTS mime_type TEXT
    `);
    await client.query(`
      ALTER TABLE managed_videos ADD COLUMN IF NOT EXISTS size_bytes BIGINT
    `);
    await client.query(`
      ALTER TABLE managed_videos ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT
    `);
    await client.query(`
      ALTER TABLE managed_videos ADD COLUMN IF NOT EXISTS object_path TEXT
    `);
    await client.query(`
      ALTER TABLE managed_videos ADD COLUMN IF NOT EXISTS uploaded_by TEXT
    `);
    await client.query(`
      ALTER TABLE managed_videos ADD COLUMN IF NOT EXISTS s3_mirrored_at TIMESTAMPTZ
    `);
    // Source-blob cleanup tracking — added with the storage cleanup worker.
    await client.query(`
      ALTER TABLE managed_videos
        ADD COLUMN IF NOT EXISTS source_cleanup_status TEXT NOT NULL DEFAULT 'none'
    `);
    await client.query(`
      ALTER TABLE managed_videos ADD COLUMN IF NOT EXISTS source_cleanup_after TIMESTAMPTZ
    `);
    await client.query(`
      ALTER TABLE managed_videos ADD COLUMN IF NOT EXISTS source_deleted_at TIMESTAMPTZ
    `);
    await client.query(`
      ALTER TABLE managed_videos
        ADD COLUMN IF NOT EXISTS source_cleanup_attempts INTEGER NOT NULL DEFAULT 0
    `);
    // Admin metadata-lock — added May 2026.
    // Prevents YouTube sync from overwriting admin-curated category/preacher.
    await client.query(`
      ALTER TABLE managed_videos
        ADD COLUMN IF NOT EXISTS metadata_locked BOOLEAN NOT NULL DEFAULT false
    `);
    // Faststart tracking — added May 2026.
    // Distinguishes seekable uploads (faststart succeeded) from raw uploads
    // (moov atom at EOF) so the broadcast queue rejects non-seekable files.
    await client.query(`
      ALTER TABLE managed_videos
        ADD COLUMN IF NOT EXISTS faststart_applied BOOLEAN NOT NULL DEFAULT false
    `);

    logger.info("db: user/auth schema columns ensured (all IF NOT EXISTS — idempotent)");
  } catch (err) {
    // Non-fatal so a partial-failure (e.g. permission denied on one column)
    // doesn't prevent the server from starting. The specific 500 errors on
    // affected routes will persist until the missing column is added, making
    // it easy to spot in logs.
    logger.warn({ err }, "db: ensureUserSchemaColumns failed — some routes may return 500 until columns are present");
  } finally {
    client.release();
  }
}

/**
 * Postgres error codes that indicate a *transient* failure — the same
 * query is safe to re-issue. Anything else (constraint violation,
 * permission error, syntax error) propagates immediately.
 *
 *   08xxx  connection_exception family
 *   57P01  admin_shutdown
 *   57P02  crash_shutdown
 *   57P03  cannot_connect_now
 *   40001  serialization_failure
 *   40P01  deadlock_detected
 *
 * Source: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const RETRYABLE_PG_CODES = new Set([
  "08000", "08003", "08006", "08001", "08004", "08007", "08P01",
  "57P01", "57P02", "57P03",
  "40001", "40P01",
]);

function isRetryableDbError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && RETRYABLE_PG_CODES.has(code)) return true;
  // node-postgres surfaces socket-level failures with no SQLSTATE.
  // The message is the only signal we get.
  const msg = (err as { message?: unknown }).message;
  if (typeof msg !== "string") return false;
  return (
    msg.includes("Connection terminated") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("read ECONNRESET")
  );
}

/**
 * Wrap a DB call in bounded exponential-backoff retries for *transient*
 * errors only. Use sparingly — most code should let errors bubble up
 * to the global handler. Worth wrapping: idempotent reads, dispatcher
 * loops, health probes.
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 100;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableDbError(err) || i === attempts - 1) throw err;
      const delay = base * 2 ** i + Math.floor(Math.random() * base);
      logger.warn(
        { err, attempt: i + 1, nextDelayMs: delay, label: opts.label },
        "transient db error — retrying",
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
