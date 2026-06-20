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
 * Returns true when the DATABASE_URL points at a connection pooler
 * (Neon "-pooler." hostname, Supabase pooler, PgBouncer via query param).
 *
 * Poolers forward startup parameters directly to individual backend
 * connections, and PgBouncer in session/transaction mode rejects unknown
 * parameters such as `statement_timeout` with a fatal error, crashing the
 * process before any query is executed. We therefore skip the `options`
 * startup-parameter path for pooler URLs and rely instead on the
 * connectionTimeoutMillis / query-level guards for safety.
 */
function isPoolerUrl(url: string): boolean {
  try {
    const { hostname, searchParams } = new URL(url);
    if (searchParams.get("pgbouncer") === "true") return true;
    // Neon: "ep-xxx-pooler.region.aws.neon.tech"
    // Supabase: "aws-0-region.pooler.supabase.com"
    if (hostname.includes("-pooler.") || hostname.includes(".pooler.")) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Single shared pg pool. Pool sizing tuned for a 2 GiB container
 * with ~50 concurrent in-flight requests (each request usually
 * holds 0–1 connections); raise `max` if you scale the dyno up.
 *
 * statement_timeout is injected as a PostgreSQL startup parameter so it is
 * applied during connection negotiation — before any query is ever sent.
 * This avoids the pg@9 deprecation warning that fires when client.query()
 * is called inside the pool's "connect" event handler.
 *
 * POOLER EXCEPTION: PgBouncer (Neon, Supabase, etc.) rejects unknown startup
 * parameters with a fatal error. When the DATABASE_URL is identified as a
 * pooler URL the `options` key is omitted entirely.
 */
/**
 * Rewrites sslmode=prefer/require/verify-ca → verify-full so the pg library
 * does not emit a SECURITY WARNING on every pool connection. The pg@8 warning
 * text reads: "The SSL modes 'prefer', 'require', and 'verify-ca' are treated
 * as aliases for 'verify-full'." — normalising up-front silences it.
 * Identical to the same function in lib/db/src/index.ts.
 */
function normalizeDatabaseUrl(raw: string): string {
  // Strip leading/trailing whitespace and newlines. Render environment-group
  // secrets are sometimes stored with a trailing \n when copy-pasted in the
  // dashboard, which produces an invalid URL and a confusing parse error.
  raw = raw.trim();
  if (!/^postgres(ql)?:\/\//i.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const mode = url.searchParams.get("sslmode");
    if (mode === "prefer" || mode === "require" || mode === "verify-ca") {
      url.searchParams.set("sslmode", "verify-full");
      return url.toString();
    }
    return raw;
  } catch {
    return raw;
  }
}

const usingPooler = isPoolerUrl(env.DATABASE_URL);
const stmtTimeoutOption =
  !usingPooler && env.DB_STATEMENT_TIMEOUT_MS > 0
    ? `-c statement_timeout=${env.DB_STATEMENT_TIMEOUT_MS}`
    : "";

if (usingPooler) {
  logger.info(
    { url: env.DATABASE_URL.replace(/:[^:@]+@/, ":***@") },
    "db: pooler URL detected — statement_timeout startup parameter omitted (PgBouncer compatibility)",
  );
}

logger.info(
  {
    max: env.DB_POOL_MAX,
    idleTimeoutMs: env.DB_POOL_IDLE_TIMEOUT_MS,
    connectTimeoutMs: env.DB_POOL_CONNECT_TIMEOUT_MS,
    statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
    usingPooler,
  },
  "db: pool configuration",
);

const pool = new Pool({
  connectionString: normalizeDatabaseUrl(env.DATABASE_URL),
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: env.DB_POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.DB_POOL_CONNECT_TIMEOUT_MS,
  application_name: "temple-tv-api",
  ...(stmtTimeoutOption ? { options: stmtTimeoutOption } : {}),
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
// Export the underlying pool so call-sites that require a pinned connection
// (advisory locks, LISTEN/NOTIFY, COPY) can `pool.connect()` and own the
// client lifecycle. Most consumers should still go through `db`.
export const pgPool = pool;
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
    // bad_url_cache — added June 2026.
    // Persists the in-memory bad-URL hit-count map across restarts so the
    // orchestrator remembers which source URLs repeatedly failed probes after a
    // reboot. runtime.repo.ts calls UPDATE … SET bad_url_cache = $1 and SELECT
    // bad_url_cache on every state save/load cycle. Without this column both
    // calls throw SQLSTATE 42703, preventing any broadcast state from being
    // persisted and reloaded, effectively resetting the bad-URL skip budget on
    // every process restart.
    await client.query(`
      ALTER TABLE broadcast_runtime_state
        ADD COLUMN IF NOT EXISTS bad_url_cache JSONB
    `);
    // failover_active / failover_reason — added to persist operator-engaged
    // failover state so the engine resumes in failover mode after a crash.
    await client.query(`
      ALTER TABLE broadcast_runtime_state
        ADD COLUMN IF NOT EXISTS failover_active BOOLEAN NOT NULL DEFAULT FALSE
    `);
    await client.query(`
      ALTER TABLE broadcast_runtime_state
        ADD COLUMN IF NOT EXISTS failover_reason TEXT
    `);
    // scanner_failure_counts — added June 2026.
    // Persists the media-integrity-scanner's per-item consecutive failure counts
    // across process restarts. Without this column, every restart resets all
    // failure counts to 0, allowing a persistently-unreachable source URL to
    // avoid suspension indefinitely (it never accumulates the
    // SCANNER_BAD_URL_THRESHOLD consecutive failures needed to trigger
    // proactive bad-URL marking). Shape: { [itemId]: { count, lastFailedAtMs } }
    await client.query(`
      ALTER TABLE broadcast_runtime_state
        ADD COLUMN IF NOT EXISTS scanner_failure_counts JSONB
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
    await client.query(`
      CREATE INDEX IF NOT EXISTS broadcast_event_log_event_type_idx
        ON broadcast_event_log (event_type)
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
 * Ensures the memory_hourly_snapshots table exists, creating it if missing.
 *
 * The memory watchdog persists an hourly RSS/heap snapshot to this table so
 * operators can review memory trends over the last 7 days from the admin
 * diagnostics panel.  The table is defined in the Drizzle schema
 * (lib/db/src/schema/memory-hourly-snapshots.ts) but drizzle-kit push
 * silently skipped creating it on existing production DBs.
 *
 * Without the table every hourly snapshot write throws SQLSTATE 42P01
 * ("relation does not exist"), which is caught and logged as a WARN but means
 * memory history is never persisted.
 *
 * CREATE TABLE IF NOT EXISTS is fully idempotent — safe on every boot.
 * Called at startup before startMemoryWatchdog() so the first snapshot fires
 * into an existing table.
 */
export async function ensureMemoryHourlySnapshotsTable(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS memory_hourly_snapshots (
        id                          SERIAL PRIMARY KEY,
        snapshot_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        rss_mb                      REAL NOT NULL,
        heap_used_mb                REAL NOT NULL,
        heap_total_mb               REAL NOT NULL,
        external_mb                 REAL NOT NULL,
        heap_used_growth_mb_per_min REAL,
        external_growth_mb_per_min  REAL,
        named_stores                JSONB NOT NULL
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS memory_hourly_snapshots_snapshot_at_idx
        ON memory_hourly_snapshots (snapshot_at)
    `);
    logger.info("db: memory_hourly_snapshots table ensured");
  } catch (err) {
    // Non-fatal — memory history will not be persisted but the server runs.
    logger.warn({ err }, "db: ensureMemoryHourlySnapshotsTable failed (non-fatal)");
  } finally {
    client.release();
  }
}

/**
 * Ensure the midnight_prayers_config table exists and contains the singleton
 * default row (id = 1).
 *
 * Why this function exists:
 *   The table is defined in the Drizzle schema (lib/db/src/schema/midnight-prayers.ts)
 *   so `drizzle-kit push` creates it on a fresh deploy.  However, production
 *   databases provisioned before the midnight-prayers feature was merged won't
 *   have the table, and Drizzle-kit push is not guaranteed to run on every
 *   deployment upgrade (manual or CI step that can be skipped).
 *
 *   midnightPrayersService.init() runs at app boot and immediately calls
 *   loadConfig() which queries the table.  Without this guard that query
 *   throws SQLSTATE 42P01 ("relation does not exist"), crashing the init()
 *   and leaving the service in an uninitialised state that causes every
 *   midnight-prayers route to return an error or stale response.
 *
 * Safety:
 *   CREATE TABLE IF NOT EXISTS and INSERT … ON CONFLICT DO NOTHING are both
 *   fully idempotent — safe to run on every boot regardless of current state.
 *
 * Called:
 *   Awaited in main.ts BEFORE buildApp() so the table is guaranteed to exist
 *   when midnightPrayersService.init() runs inside buildApp().
 *   Also called defensively inside MidnightPrayersService.loadConfig() on
 *   42P01 so a race or missed startup call cannot permanently break the service.
 */
export async function ensureMidnightPrayersTable(): Promise<void> {
  const client = await pool.connect();
  try {
    // Create the singleton config table if it doesn't exist.
    await client.query(`
      CREATE TABLE IF NOT EXISTS midnight_prayers_config (
        id          INTEGER     PRIMARY KEY DEFAULT 1,
        enabled     BOOLEAN     NOT NULL DEFAULT true,
        start_hour  INTEGER     NOT NULL DEFAULT 0,
        end_hour    INTEGER     NOT NULL DEFAULT 3,
        timezone    TEXT        NOT NULL DEFAULT 'Africa/Lagos',
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Add a CHECK constraint so id is always 1 (singleton pattern).
    // IF NOT EXISTS on constraints requires PostgreSQL 9.4+ (we target 14+).
    // We use a DO block because ALTER TABLE ADD CONSTRAINT has no IF NOT EXISTS.
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'midnight_prayers_config_singleton'
            AND conrelid = 'midnight_prayers_config'::regclass
        ) THEN
          ALTER TABLE midnight_prayers_config
            ADD CONSTRAINT midnight_prayers_config_singleton CHECK (id = 1);
        END IF;
      END $$
    `);

    // Seed the singleton default row so loadConfig() always finds a row and
    // never needs to INSERT during a read path (avoids write-during-read surprises).
    await client.query(`
      INSERT INTO midnight_prayers_config (id, enabled, start_hour, end_hour, timezone, updated_at)
      VALUES (1, true, 0, 3, 'Africa/Lagos', NOW())
      ON CONFLICT (id) DO NOTHING
    `);

    logger.info("db: midnight_prayers_config table ensured (table + singleton row)");
  } catch (err) {
    // Propagate so the caller can decide whether to abort startup or continue.
    logger.error({ err }, "db: ensureMidnightPrayersTable failed");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reset managed_videos rows stuck in transcodingStatus='processing'.
 *
 * 'processing' is the transient state set by runFaststart while it atomically
 * replaces the stored blob.  runFaststart restores the prior status on a clean
 * failure, but a mid-faststart server crash leaves the row permanently blocked:
 * loadActive() excludes 'processing' items, so the broadcast queue slot is
 * silently held but never aired.
 *
 * At startup we can safely reset any 'processing' row back to 'queued' (if it
 * has a playable localVideoUrl) or 'none' (if not).  The object-storage blob is
 * always consistent — runFaststart uses a multipart atomic swap so the key
 * holds either the old un-optimised file or the fully written new file.
 * faststartApplied is intentionally left unchanged; the value was false before
 * the crash and the file may or may not be optimised.
 *
 * Called once at boot, non-blocking.
 */
export async function resetStuckProcessingVideos(): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      UPDATE managed_videos
      SET    transcoding_status = CASE
               WHEN local_video_url IS NOT NULL AND local_video_url != '' THEN 'queued'
               ELSE 'none'
             END
      WHERE  transcoding_status = 'processing'
    `);
    const reset = (result as unknown as { rowCount: number | null }).rowCount ?? 0;
    if (reset > 0) {
      logger.warn(
        { reset },
        "db: reset stuck 'processing' videos to queued/none — " +
          "these were interrupted mid-faststart by a server crash; " +
          "they will join the broadcast queue once HLS transcoding completes (HLS-gate policy)",
      );
    } else {
      logger.info("db: no stuck processing videos found at startup");
    }
  } catch (err) {
    logger.warn({ err }, "db: resetStuckProcessingVideos failed (non-fatal)");
  } finally {
    client.release();
  }
}

/**
 * Reset managed_videos rows stuck in transcodingStatus='encoding'.
 *
 * 'encoding' is the transient state written by the transcoder dispatcher
 * when it starts a transcode job (job.status → processing, video → encoding).
 * On success the video advances to 'hls_ready'; on clean failure the
 * dispatcher resets it. But if the Node process is SIGKILL-ed mid-encode:
 *
 *   - The transcoding_job row is reset to 'queued' by resetOrphanedJobs()
 *     (runs in the TranscoderDispatcher constructor at startup).
 *   - The managed_videos row stays at 'encoding' because the reset path in
 *     the dispatcher never ran.
 *
 * In that scenario the job will be re-claimed and will set the video to
 * 'encoding' again — which is fine.  But if the job row itself was lost
 * (e.g. manual deletion, a bug in the cleanup service, or the job was
 * force-failed by the stuck-job watchdog without updating the video row),
 * the video stays 'encoding' indefinitely with no job to advance it.
 *
 * This function resets such orphaned rows to 'queued' (or 'none') so the
 * transcoder can pick them up on the next poll.  It is safe to run at every
 * startup because the check is gated on "no active processing job" —
 * a concurrent job that is legitimately mid-encode will NOT be reset.
 *
 * Called once at boot, non-blocking.
 */
export async function resetStuckEncodingVideos(): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      UPDATE managed_videos mv
      SET    transcoding_status = CASE
               WHEN mv.local_video_url IS NOT NULL AND mv.local_video_url != '' THEN 'queued'
               ELSE 'none'
             END
      WHERE  mv.transcoding_status = 'encoding'
        AND  NOT EXISTS (
          SELECT 1
          FROM   transcoding_jobs tj
          WHERE  tj.video_id  = mv.id
            AND  tj.status   IN ('processing', 'queued')
        )
    `);
    const reset = (result as unknown as { rowCount: number | null }).rowCount ?? 0;
    if (reset > 0) {
      logger.warn(
        { reset },
        "db: reset stuck 'encoding' videos to queued/none — " +
          "these had no active transcoding job (server crash or lost job row); " +
          "they will be re-enqueued for transcoding on the next dispatcher tick",
      );
    } else {
      logger.info("db: no stuck encoding videos found at startup");
    }
  } catch (err) {
    logger.warn({ err }, "db: resetStuckEncodingVideos failed (non-fatal)");
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
  // Audit-only: count rows with no playable source and log a warning.
  // Items are no longer deactivated at boot — the orchestrator's bad-URL
  // cache and runtime auto-skip handle unresolvable items without removing
  // them from the queue. Background workers (queue-integrity-validator,
  // faststart-recovery, storage-reconciliation) surface diagnostics and
  // trigger recovery asynchronously.
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT COUNT(*) AS cnt
      FROM   broadcast_queue bq
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
                OR (mv.object_path     IS NOT NULL AND mv.object_path     != '')
                OR  mv.video_source = 'youtube'
                 )
        )
    `);
    const rows = result as unknown as { rows: Array<{ cnt: string }> };
    const count = parseInt(rows.rows[0]?.cnt ?? "0", 10);
    if (count > 0) {
      logger.warn(
        { count },
        "db: broadcast_queue source audit — items with no playable source detected; " +
          "these will be auto-skipped at runtime; re-upload/transcode to restore them",
      );
    } else {
      logger.info("db: broadcast_queue source audit complete — no unresolvable rows found");
    }
  } catch (err) {
    logger.warn({ err }, "db: deactivateUnresolvableQueueRows audit failed (non-fatal)");
  } finally {
    client.release();
  }
}

export async function ensureRuntimeIndexes(): Promise<void> {
  // Each index is attempted independently so one failure never silently skips
  // the rest.  A single shared pool client is used for efficiency (connection
  // reuse); each statement is autocommit (no enclosing BEGIN/COMMIT).
  const client = await pool.connect();

  // Helper: run one DDL statement, log success/failure per-index, never throw.
  // INFO on success so operators can confirm which indexes were created vs
  // already existed. ERROR on failure so it surfaces in alerting dashboards
  // without terminating the overall startup sequence (non-fatal).
  const run = async (name: string, sql: string): Promise<void> => {
    try {
      await client.query(sql);
      logger.info({ index: name }, `db: index ensured — ${name}`);
    } catch (err) {
      logger.error({ err, index: name }, `db: failed to ensure index ${name} (non-fatal)`);
    }
  };

  try {
    // ── GIN full-text search index ─────────────────────────────────────────
    // Powers plainto_tsquery on title + preacher + description.
    // NOTE: CREATE INDEX (not CONCURRENTLY) — safe here because the client
    // connection is in autocommit mode and is dedicated to DDL work.
    await run("idx_managed_videos_fts", `
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

    // ── Functional indexes for lower() filter expressions ─────────────────
    // Standard B-Tree indexes on `category`, `preacher`, and `email` are
    // NOT used by queries that wrap the column in lower() (e.g.
    // `WHERE lower(category) = 'sermon'`) or by leading-wildcard ILIKE.
    // Functional indexes on the lower()-expression allow PostgreSQL to use
    // an index scan for these common filter patterns.
    await run("idx_managed_videos_category_lower", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_category_lower
        ON managed_videos (lower(category))
    `);
    await run("idx_managed_videos_preacher_lower", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_preacher_lower
        ON managed_videos (lower(preacher))
    `);
    await run("idx_users_email_lower", `
      CREATE INDEX IF NOT EXISTS idx_users_email_lower
        ON users (lower(email))
    `);

    // ── Partial indexes ────────────────────────────────────────────────────
    // Source-cleanup sweep: WHERE source_cleanup_status IN ('scheduled','failed')
    await run("idx_managed_videos_cleanup_due", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_cleanup_due
        ON managed_videos (source_cleanup_after)
        WHERE source_cleanup_status IN ('scheduled', 'failed')
    `);
    // Transcoder worker: local videos without HLS awaiting encoding.
    await run("idx_managed_videos_transcode_pending", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_transcode_pending
        ON managed_videos (imported_at)
        WHERE video_source = 'local'
          AND transcoding_status = 'queued'
          AND hls_master_url IS NULL
    `);
    // YouTube catalogue hot path: /api/videos and TV catalogue page.
    await run("idx_managed_videos_youtube_catalog", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_youtube_catalog
        ON managed_videos (published_at DESC)
        WHERE video_source = 'youtube'
          AND COALESCE(broadcast_only, false) = false
    `);
    // Broadcast-queue V2 orchestrator reload hot path.
    await run("idx_broadcast_queue_active_sort", `
      CREATE INDEX IF NOT EXISTS idx_broadcast_queue_active_sort
        ON broadcast_queue (sort_order, added_at)
        WHERE is_active = true
    `);
    // Scheduled notification dispatcher poll.
    await run("idx_scheduled_notifications_dispatch", `
      CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_dispatch
        ON scheduled_notifications (scheduled_at)
        WHERE status = 'pending'
    `);
    // Admin analytics concurrent-viewers CTE.
    await run("idx_viewer_sessions_started_at", `
      CREATE INDEX IF NOT EXISTS idx_viewer_sessions_started_at
        ON viewer_sessions (started_at)
    `);

    // ── Unique partial indexes ─────────────────────────────────────────────
    // Prevents duplicate managed_videos for the same uploaded file.
    await run("uq_managed_videos_object_path", `
      CREATE UNIQUE INDEX IF NOT EXISTS uq_managed_videos_object_path
        ON managed_videos (object_path)
        WHERE object_path IS NOT NULL
    `);
    // Prevents same video appearing more than once in the active broadcast queue.
    await run("uq_broadcast_queue_video_id_active", `
      CREATE UNIQUE INDEX IF NOT EXISTS uq_broadcast_queue_video_id_active
        ON broadcast_queue (video_id)
        WHERE is_active = true AND video_id IS NOT NULL
    `);

    // ── B-Tree indexes (Drizzle schema additions) ──────────────────────────
    // These are defined in the Drizzle schema but drizzle-kit push silently
    // skipped them on existing prod DBs.  All use IF NOT EXISTS — idempotent.
    await run("idx_managed_videos_hls_master_url", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_hls_master_url
        ON managed_videos (hls_master_url)
    `);
    await run("idx_managed_videos_local_video_url", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_local_video_url
        ON managed_videos (local_video_url)
    `);
    await run("idx_managed_videos_published_at", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_published_at
        ON managed_videos (published_at)
    `);
    await run("idx_managed_videos_source_transcoding", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_source_transcoding
        ON managed_videos (video_source, transcoding_status)
    `);
    await run("idx_managed_videos_faststart_applied", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_faststart_applied
        ON managed_videos (faststart_applied)
    `);
    await run("idx_managed_videos_broadcast_admission", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_broadcast_admission
        ON managed_videos (video_source, transcoding_status, faststart_applied)
    `);
    await run("idx_managed_videos_uploaded_by", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_uploaded_by
        ON managed_videos (uploaded_by)
    `);
    await run("refresh_tokens_user_id_revoked_at_idx", `
      CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_revoked_at_idx
        ON refresh_tokens (user_id, revoked_at)
    `);
    await run("idx_password_reset_tokens_user_id", `
      CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id
        ON password_reset_tokens (user_id)
    `);
    await run("idx_scheduled_notifications_video_id", `
      CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_video_id
        ON scheduled_notifications (video_id)
    `);

    // ── New indexes added after initial production deploy ──────────────────
    // youtube_live_status: queried every 2 minutes by the live-status service
    // (WHERE youtube_live_status = 'live'). Without an index this is a full
    // table scan over all managed_videos on every poll cycle.
    await run("idx_managed_videos_youtube_live_status", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_youtube_live_status
        ON managed_videos (youtube_live_status)
        WHERE youtube_live_status IS NOT NULL
    `);
    // metadata_locked: used by YouTube sync to skip overwriting curated rows
    // (WHERE metadata_locked = true). Without an index this scans all local
    // videos on every sync run (up to every 15 minutes).
    await run("idx_managed_videos_metadata_locked", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_metadata_locked
        ON managed_videos (metadata_locked)
        WHERE metadata_locked = true
    `);
    // Transcoding dispatcher hot-path: claims next queued job by picking from
    // status='queued' ordered by priority DESC, created_at ASC, next_retry_at.
    // Without a covering index the dispatcher's SELECT runs a full table scan
    // on every 10-second poll tick.
    await run("idx_transcoding_jobs_dispatch", `
      CREATE INDEX IF NOT EXISTS idx_transcoding_jobs_dispatch
        ON transcoding_jobs (priority DESC, created_at ASC, next_retry_at)
        WHERE status = 'queued'
    `);
    // Stuck-job watchdog: scans status='processing' rows to detect timed-out
    // jobs. Runs every ~2 minutes. Without this index it scans all jobs.
    await run("idx_transcoding_jobs_watchdog", `
      CREATE INDEX IF NOT EXISTS idx_transcoding_jobs_watchdog
        ON transcoding_jobs (started_at, last_progress_at)
        WHERE status = 'processing'
    `);
    // Auto-retry sweep: finds status='failed' jobs with remaining attempts and
    // non-terminal error codes. Runs every 30 minutes.
    await run("idx_transcoding_jobs_auto_retry", `
      CREATE INDEX IF NOT EXISTS idx_transcoding_jobs_auto_retry
        ON transcoding_jobs (video_id, completed_at, attempts)
        WHERE status = 'failed'
    `);
    // Broadcast event log: cleanup sweep (DELETE WHERE created_at < 14 days)
    // already has channel_created_idx but the stale-data cleanup queries only
    // on created_at without channel_id — add a plain index for the sweep path.
    await run("idx_broadcast_event_log_created_at", `
      CREATE INDEX IF NOT EXISTS idx_broadcast_event_log_created_at
        ON broadcast_event_log (created_at)
    `);
    // Viewer sessions stale-data sweep: DELETE WHERE ended_at IS NULL AND
    // last_heartbeat_at < (now - 1h). The started_at index already exists but
    // the sweep predicates use last_heartbeat_at which has no index.
    await run("idx_viewer_sessions_heartbeat", `
      CREATE INDEX IF NOT EXISTS idx_viewer_sessions_heartbeat
        ON viewer_sessions (last_heartbeat_at)
        WHERE ended_at IS NULL
    `);
    // Admin analytics concurrent-viewers CTE: the time-bucket correlated
    // sub-query joins viewer_sessions on a started_at range AND filters by
    // platform in CASE expressions. The single-column idx_viewer_sessions_started_at
    // covers range scans but Postgres still fans over all platform values.
    // A covering (started_at, platform) index turns the platform filter into
    // an index scan instead of a heap fetch for each matched row.
    await run("idx_viewer_sessions_started_platform", `
      CREATE INDEX IF NOT EXISTS idx_viewer_sessions_started_platform
        ON viewer_sessions (started_at, platform)
    `);
    // broadcast_queue.video_id — unconditional index for JOIN patterns that
    // include inactive rows (e.g. orphan detection, integrity validator
    // reverse-pass, duration-sync UPDATE FROM broadcast_queue). The partial
    // unique index uq_broadcast_queue_video_id_active already covers active-only
    // lookups; this complements it for full-table JOIN and non-active scans.
    await run("idx_broadcast_queue_video_id", `
      CREATE INDEX IF NOT EXISTS idx_broadcast_queue_video_id
        ON broadcast_queue (video_id)
        WHERE video_id IS NOT NULL
    `);
    // upload_sessions.completed_video_id — FK-like reference to managed_videos.id.
    // Queried in chunked-upload finalize, library-sync, and cleanup sweeps when
    // looking up sessions by their resulting video.  Without this index each
    // lookup is a sequential scan over the sessions table.
    await run("idx_upload_sessions_completed_video_id", `
      CREATE INDEX IF NOT EXISTS idx_upload_sessions_completed_video_id
        ON upload_sessions (completed_video_id)
        WHERE completed_video_id IS NOT NULL
    `);
    // Chat history: queries filter by channel_id + order by created_at, with a
    // partial predicate on deleted_at IS NULL. Without this index each
    // GET /chat/:channel/history performs a sequential scan over the full table.
    await run("idx_chat_messages_channel_history", `
      CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_history
        ON chat_messages (channel_id, created_at)
        WHERE deleted_at IS NULL
    `);

    // ── Maintenance hot-path indexes (added after production deploy) ──────
    // reEnableAllSuspended() queries: WHERE is_active=false AND
    // validator_deactivated_reason IS NOT NULL. The table has no index on
    // inactive rows, so every boot-time reEnableAllSuspended() call scanned
    // the full broadcast_queue table. A partial index on the deactivated
    // subset makes this O(deactivated rows) instead of O(total rows).
    await run("idx_broadcast_queue_inactive_deactivated", `
      CREATE INDEX IF NOT EXISTS idx_broadcast_queue_inactive_deactivated
        ON broadcast_queue (validator_deactivated_reason)
        WHERE is_active = false AND validator_deactivated_reason IS NOT NULL
    `);

    // resetStuckProcessingVideos() queries: WHERE transcoding_status = 'processing'.
    // The existing idx_managed_videos_source_transcoding is a composite index
    // on (video_source, transcoding_status) — queries that filter only on
    // transcoding_status cannot use it efficiently because video_source is the
    // leading column. A targeted partial index makes the startup reset O(stuck rows).
    await run("idx_managed_videos_processing_status", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_processing_status
        ON managed_videos (id)
        WHERE transcoding_status = 'processing'
    `);

    // Admin listQueue() selects ALL broadcast_queue rows (active + inactive)
    // ordered by sort_order, added_at. The existing idx_broadcast_queue_active_sort
    // is partial (WHERE is_active=true) so a full-table sort is still required for
    // the admin view that includes inactive rows. This non-partial index covers
    // that path without a sequential scan + in-memory sort.
    await run("idx_broadcast_queue_all_sort", `
      CREATE INDEX IF NOT EXISTS idx_broadcast_queue_all_sort
        ON broadcast_queue (sort_order ASC, added_at ASC)
    `);

    // ── User activity hot-path composite indexes ───────────────────────────
    // user_watch_history: most calls filter by user_id then sort/limit by
    // watched_at DESC ("recent history"). Without this composite index each
    // per-user query is a partial index scan + sort over all of a user's rows.
    await run("idx_user_watch_history_user_watched", `
      CREATE INDEX IF NOT EXISTS idx_user_watch_history_user_watched
        ON user_watch_history (user_id, watched_at DESC)
    `);
    // device_watch_history: same pattern — device_id + watched_at DESC for
    // the "continue watching" feed on TV/mobile surfaces.
    await run("idx_device_watch_history_device_watched", `
      CREATE INDEX IF NOT EXISTS idx_device_watch_history_device_watched
        ON device_watch_history (device_id, watched_at DESC)
    `);
    // user_favorites: user_id + created_at DESC for "my favourites" feed.
    // The unique index on (user_id, video_id) covers equality lookups; this
    // composite covers the feed query (WHERE user_id = ? ORDER BY created_at).
    await run("idx_user_favorites_user_created", `
      CREATE INDEX IF NOT EXISTS idx_user_favorites_user_created
        ON user_favorites (user_id, created_at DESC)
    `);
    // push_tokens: a covering (platform, token) index supports the delivery
    // worker's "WHERE platform = ? AND token NOT IN (revoked)" path that
    // selects all active tokens for a given platform in one index scan.
    await run("idx_push_tokens_platform_token", `
      CREATE INDEX IF NOT EXISTS idx_push_tokens_platform_token
        ON push_tokens (platform, token)
    `);
    // sent_notifications: notification status dashboard and retry-worker
    // queries filter by status ('pending','sending','failed') and order by
    // sent_at DESC. A (status, sent_at DESC) composite lets those queries
    // use an index range scan instead of a full table scan across the
    // ever-growing notification history.
    await run("idx_sent_notifications_status_sent_at", `
      CREATE INDEX IF NOT EXISTS idx_sent_notifications_status_sent_at
        ON sent_notifications (status, sent_at DESC)
    `);

    // ── Performance hot-path indexes (post-audit additions) ────────────────
    // Transcoder dispatcher poll: SELECT … FROM transcoding_jobs WHERE status
    // IN ('queued','processing') ORDER BY created_at ASC. A composite index
    // on (status, created_at) turns this O(table) scan into an index range
    // scan — critical when the jobs table accumulates thousands of historical
    // rows over a long-running deployment.
    await run("idx_transcoding_jobs_status_created", `
      CREATE INDEX IF NOT EXISTS idx_transcoding_jobs_status_created
        ON transcoding_jobs (status, created_at ASC)
    `);
    // Admin analytics and library sort: managed_videos ordered by view_count
    // DESC for "most watched" reports and trending video queries. The Drizzle
    // schema declares a plain idx_managed_videos_view_count; this composite
    // extends it with video_source so the planner can use an index-only scan
    // on the common `WHERE video_source = 'youtube'` + `ORDER BY view_count`
    // path used by the YouTube catalog tab and SEO ranking queries.
    // NOTE: is_active column was removed from managed_videos — partial filter
    // dropped so the index matches the current schema.
    await run("idx_managed_videos_view_count_source", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_view_count_source
        ON managed_videos (view_count DESC, video_source)
    `);

    // ── HLS storage + analytics hot-path indexes (performance audit) ───────
    // storage_blobs deleteByPrefix() + bulk-delete use starts_with(key, prefix).
    // The primary key is a plain B-Tree; PostgreSQL will NOT use it for LIKE
    // 'prefix%' or starts_with() patterns without a text_pattern_ops index.
    // This index is an alternative access path for prefix scans used by:
    //   • abortMultipartUpload (deletes _parts/{uploadId}/* rows)
    //   • video deletion (deletes transcoded/{videoId}/* rows)
    //   • orphan cleanup worker (scans transcoded/* keys)
    await run("idx_storage_blobs_key_tpo", `
      CREATE INDEX IF NOT EXISTS idx_storage_blobs_key_tpo
        ON storage_blobs USING btree (key text_pattern_ops)
    `);
    // viewer_sessions concurrent-analytics covering index.
    // getConcurrentViewers() runs a time-bucket CTE that LEFT JOINs viewer_sessions
    // on a started_at range AND evaluates (ended_at, last_heartbeat_at) in CASE
    // expressions. A composite index on these three columns lets the planner
    // use an index-only scan for both the join predicate and the per-bucket
    // CASE expressions, avoiding heap fetches for each matched session row.
    await run("idx_viewer_sessions_concurrent_analytics", `
      CREATE INDEX IF NOT EXISTS idx_viewer_sessions_concurrent_analytics
        ON viewer_sessions (started_at DESC, ended_at, last_heartbeat_at)
    `);

    // Partial-success healer: scans managed_videos WHERE transcoding_status =
    // 'encoding' to find orphaned videos that were left stuck mid-encode after
    // a server restart or dispatcher crash. Without this index the scan is O(N)
    // over all managed_videos rows.
    await run("idx_managed_videos_encoding_stuck", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_encoding_stuck
        ON managed_videos (updated_at DESC)
        WHERE video_source = 'local'
          AND transcoding_status = 'encoding'
    `);
    // Repair-all endpoint: finds hls_ready local videos that are not in the
    // active broadcast queue so they can be auto-enqueued by the repair route.
    // The subquery "NOT IN (SELECT video_id FROM broadcast_queue WHERE is_active)"
    // is a full scan on both tables without this index.
    await run("idx_managed_videos_hls_ready_local", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_hls_ready_local
        ON managed_videos (imported_at DESC)
        WHERE video_source = 'local'
          AND transcoding_status = 'hls_ready'
    `);

    // ── Check constraints (DO-block pattern for idempotency) ───────────────
    // ALTER TABLE ADD CONSTRAINT has no IF NOT EXISTS; use a DO block.
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'no_youtube_urls_in_queue'
            AND conrelid = 'broadcast_queue'::regclass
        ) THEN
          ALTER TABLE broadcast_queue
            ADD CONSTRAINT no_youtube_urls_in_queue CHECK (
              local_video_url NOT LIKE '%youtube.com/watch%'
              AND local_video_url NOT LIKE '%youtu.be/%'
            );
        END IF;
      END $$
    `).catch((err: unknown) => {
      logger.warn({ err }, "db: no_youtube_urls_in_queue constraint skipped (non-fatal)");
    });
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_broadcast_queue_sort_order_nonneg'
            AND conrelid = 'broadcast_queue'::regclass
        ) THEN
          ALTER TABLE broadcast_queue
            ADD CONSTRAINT chk_broadcast_queue_sort_order_nonneg
            CHECK (sort_order >= 0);
        END IF;
      END $$
    `).catch((err: unknown) => {
      logger.warn({ err }, "db: chk_broadcast_queue_sort_order_nonneg constraint skipped (non-fatal)");
    });
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'managed_videos_transcoding_status_check'
            AND conrelid = 'managed_videos'::regclass
        ) THEN
          ALTER TABLE managed_videos
            ADD CONSTRAINT managed_videos_transcoding_status_check
            CHECK (transcoding_status IN (
              'none','queued','encoding','processing','ready','hls_ready','failed'
            ));
        END IF;
      END $$
    `).catch((err: unknown) => {
      logger.warn({ err }, "db: managed_videos_transcoding_status_check constraint skipped (non-fatal)");
    });

    // ── FK constraint: broadcast_queue.video_id → managed_videos.id ──────
    // ON DELETE SET NULL: deleting a video nulls out any queue row that
    // references it, rather than raising a FK violation. The queue-integrity
    // validator deactivates rows with null video_id on the next cycle.
    // Not declared in the Drizzle schema DSL because drizzle-kit's CJS bundler
    // cannot resolve cross-file table references (MODULE_NOT_FOUND for .js →
    // .ts remapping). Applied idempotently here instead.
    // First null out any orphaned video_id references so the FK constraint
    // is guaranteed to succeed. Then apply the constraint (idempotent).
    // Failure here is NOT tolerated — a broken FK invariant means the queue
    // could reference deleted videos indefinitely.
    await client.query(`
      DO $$ BEGIN
        -- Null out orphaned references before adding FK so the constraint
        -- is guaranteed to apply cleanly on existing data.
        UPDATE broadcast_queue
        SET video_id = NULL
        WHERE video_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM managed_videos WHERE id = broadcast_queue.video_id
          );

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'fk_broadcast_queue_video_id'
            AND conrelid = 'broadcast_queue'::regclass
        ) THEN
          ALTER TABLE broadcast_queue
            ADD CONSTRAINT fk_broadcast_queue_video_id
            FOREIGN KEY (video_id) REFERENCES managed_videos(id)
            ON DELETE SET NULL;
        END IF;
      END $$
    `);

    // ── pg_trgm extension + GIN trigram indexes for user ILIKE search ──────
    // Admin user search uses ILIKE '%query%' on email and display_name.
    // Leading-wildcard patterns cannot use B-tree indexes — even with the
    // lower() functional index — so every search is a full sequential scan.
    // GIN trigram indexes built by pg_trgm resolve this to an index range scan.
    // Enable the extension first (idempotent); create indexes only if the
    // extension is available.  Both statements are non-fatal on failure so
    // environments without superuser access continue to operate without them.
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm").catch((err: unknown) => {
      logger.warn({ err }, "db: pg_trgm extension unavailable — trigram indexes skipped (non-fatal)");
    });
    await run("idx_users_email_trgm", `
      CREATE INDEX IF NOT EXISTS idx_users_email_trgm
        ON users
        USING gin (lower(email) gin_trgm_ops)
    `);
    await run("idx_users_display_name_trgm", `
      CREATE INDEX IF NOT EXISTS idx_users_display_name_trgm
        ON users
        USING gin (lower(display_name) gin_trgm_ops)
    `);

    // ── Sort index for mixed-source catalog ────────────────────────────────
    // Public /api/videos?sort=newest (no source filter) orders rows by
    // imported_at DESC.  The existing partial index idx_managed_videos_youtube
    // only covers youtube rows; mixed-source queries fall back to a full scan.
    // NOTE: COALESCE(published_at::timestamptz, imported_at) requires an
    // IMMUTABLE cast from text, which PostgreSQL rejects in index expressions
    // (text→timestamptz is STABLE). Use imported_at alone — it is populated for
    // all rows (youtube rows get it from the sync date, local rows from upload
    // time) and is already of type timestamptz.
    await run("idx_managed_videos_coalesce_sort", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_coalesce_sort
        ON managed_videos (imported_at DESC)
        WHERE broadcast_only IS DISTINCT FROM true
    `);

    // ── Local-upload browse sort — admin library page ───────────────────────
    // Admin /api/v1/admin/videos?source=local sorts by imported_at DESC.
    // The existing idx_managed_videos_transcode_pending only covers queued
    // rows; a general local+imported_at index enables fast pagination for the
    // admin video library filtered by video_source='local'.
    await run("idx_managed_videos_local_browse", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_local_browse
        ON managed_videos (imported_at DESC)
        WHERE video_source = 'local'
    `);

    // ── Series membership lookup ────────────────────────────────────────────
    // Series pages (GET /api/series/:id/videos) join managed_videos ON
    // series_id = :id. Without an index the query does a full table scan.
    // Guard: series_id column may not exist in older DB migrations (it was
    // added post-initial-schema). Skip the index silently when absent.
    //
    // IMPORTANT: uses a JS-level column-existence check rather than a nested
    // DO-EXECUTE dollar-quoting block. The DO $$ BEGIN ... EXECUTE $idx$...$idx$
    // pattern silently no-ops via the pg client library (nested dollar-quote
    // delimiters are not correctly parsed), so the index was never created on
    // production DBs that pre-dated the series_id column. Two-step approach:
    // 1. Query information_schema from JS — safe with pg's parameterised interface.
    // 2. Conditionally call run() with a bare CREATE INDEX — correct path.
    {
      const seriesIdCheck = await client.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'managed_videos' AND column_name = 'series_id'
        LIMIT 1
      `).catch(() => ({ rows: [] as unknown[] }));
      if ((seriesIdCheck as { rows: unknown[] }).rows.length > 0) {
        await run("idx_managed_videos_series_id", `
          CREATE INDEX IF NOT EXISTS idx_managed_videos_series_id
            ON managed_videos (series_id)
            WHERE series_id IS NOT NULL
        `);
      }
    }

    // ── Catalog category + sort composite ──────────────────────────────────
    // /api/videos?category=X&sort=newest filters by lower(category) and then
    // orders by imported_at DESC. The planner uses idx_managed_videos_category
    // _lower for the filter and then sorts in memory. A composite covering
    // index avoids the in-memory sort step for category-filtered pages.
    // NOTE: COALESCE(published_at::timestamptz, ...) removed — text→timestamptz
    // cast is STABLE not IMMUTABLE and PostgreSQL rejects it in index expressions.
    await run("idx_managed_videos_category_coalesce_sort", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_category_coalesce_sort
        ON managed_videos (lower(category), imported_at DESC)
        WHERE broadcast_only IS DISTINCT FROM true
    `);

    // ── Cache entries cleanup sweep ─────────────────────────────────────────
    // Cache eviction DELETE WHERE expires_at < now() does a full table scan
    // without an index on expires_at. A partial index on non-null expires_at
    // makes the sweep O(expired rows) instead of O(total cache rows).
    await run("idx_cache_entries_expires_at", `
      CREATE INDEX IF NOT EXISTS idx_cache_entries_expires_at
        ON cache_entries (expires_at)
        WHERE expires_at IS NOT NULL
    `);

    // ── Refresh token expiry cleanup ────────────────────────────────────────
    // Periodic token purge: DELETE WHERE expires_at < now() AND revoked_at IS NULL.
    // Without this, the sweep is a full sequential scan over the tokens table.
    await run("idx_refresh_tokens_active_expires", `
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_active_expires
        ON refresh_tokens (expires_at)
        WHERE revoked_at IS NULL
    `);

    // ── App versions — mobile version check hot path ────────────────────────
    // Mobile clients poll GET /api/app-versions?platform=X&channel=Y to check
    // for OTA updates. A composite index on (platform, channel, is_active)
    // turns this into an index-only scan instead of a full table scan.
    await run("idx_app_versions_platform_channel_active", `
      CREATE INDEX IF NOT EXISTS idx_app_versions_platform_channel_active
        ON app_versions (platform, channel, is_active)
    `);

    // ── Live ingest endpoints — health dashboard ────────────────────────────
    // Health and admin queries filter WHERE is_active = true ORDER BY priority.
    // A partial index on the active subset covers the query with an index scan.
    await run("idx_live_ingest_active_priority", `
      CREATE INDEX IF NOT EXISTS idx_live_ingest_active_priority
        ON live_ingest_endpoints (priority)
        WHERE is_active = true
    `);

    // ── Playlists — listing + membership ───────────────────────────────────
    // GET /api/playlists filters WHERE is_active = true ORDER BY created_at DESC.
    // The full-table default scan becomes an index range scan with this covering index.
    await run("idx_playlists_active_created", `
      CREATE INDEX IF NOT EXISTS idx_playlists_active_created
        ON playlists (created_at DESC)
        WHERE is_active = true
    `);

    // ── Prayer requests — unread dashboard ─────────────────────────────────
    // Unread prayer request count + listing: WHERE is_read = false ORDER BY
    // created_at DESC. A partial index on the unread subset is O(unread rows).
    await run("idx_prayer_requests_unread", `
      CREATE INDEX IF NOT EXISTS idx_prayer_requests_unread
        ON prayer_requests (created_at DESC)
        WHERE is_read = false
    `);

    // ── User feedback — unread dashboard ───────────────────────────────────
    // Admin feedback dashboard: WHERE is_read = false ORDER BY created_at DESC.
    // Same pattern as prayer_requests — partial index on the unread subset.
    await run("idx_user_feedback_unread", `
      CREATE INDEX IF NOT EXISTS idx_user_feedback_unread
        ON user_feedback (type, created_at DESC)
        WHERE is_read = false
    `);

    // ── Broadcast event log — SSE replay + pruning ─────────────────────────
    // SSE resume replays events WHERE channel_id = ? AND sequence > lastSeq.
    // Pruning deletes WHERE channel_id = ? AND sequence < (max - KEEP).
    // A composite (channel_id, sequence) index makes both O(log N).
    await run("idx_broadcast_event_log_channel_seq", `
      CREATE INDEX IF NOT EXISTS idx_broadcast_event_log_channel_seq
        ON broadcast_event_log (channel_id, sequence ASC)
    `);

    // ── S3 upload telemetry — video-event analytics ─────────────────────────
    // Telemetry dashboard queries: WHERE video_id = ? AND event = ? ORDER BY
    // created_at DESC. Without a composite index this scans the whole table.
    await run("idx_s3_telemetry_video_event_created", `
      CREATE INDEX IF NOT EXISTS idx_s3_telemetry_video_event_created
        ON s3_upload_telemetry (video_id, event, created_at DESC)
    `);

    // ── Faststart recovery sweep ────────────────────────────────────────────
    // faststartRecoveryWorker.sweep() joins broadcast_queue with managed_videos
    // to find active queue items whose linked video has faststart_applied=false,
    // video_source='local', and a non-null objectPath. This partial index makes
    // that sweep O(un-fast-started local rows) instead of a full table scan.
    // run() catches SQLSTATE 42703 if faststart_applied is missing on an old
    // prod DB that hasn't run ensureUserSchemaColumns yet — non-fatal; the next
    // restart (post-column-add) will create it.
    await run("idx_managed_videos_faststart_pending", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_faststart_pending
        ON managed_videos (object_path)
        WHERE video_source     = 'local'
          AND faststart_applied = false
          AND object_path       IS NOT NULL
    `);

    // ── Transcoding error kind — broadcast reprobe + admin broadcast view ───
    // admin-broadcast.routes.ts and broadcast-v2/io/rest.routes.ts query
    // managed_videos WHERE transcoding_error_kind IN ('moov_absent', …) for
    // reprobe eligibility. A partial index over the non-null subset makes this
    // O(rows with a kind) rather than a full table scan.
    await run("idx_managed_videos_transcoding_error_kind", `
      CREATE INDEX IF NOT EXISTS idx_managed_videos_transcoding_error_kind
        ON managed_videos (transcoding_error_kind)
        WHERE transcoding_error_kind IS NOT NULL
    `);

    logger.info("db: functional and partial indexes ensured");
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
  // Each ALTER TABLE / UPDATE is attempted independently so one failure never
  // silently skips the rest.  A failed column addition is logged as WARN (the
  // route that uses it will 500 until fixed — visible, not silent).
  const client = await pool.connect();

  // Helper: run one DDL/DML statement, log per-statement, never throw.
  const col = async (label: string, sql: string): Promise<void> => {
    try {
      await client.query(sql);
    } catch (err) {
      logger.warn({ err, col: label }, `db: failed to ensure column/default ${label} (non-fatal — route may 500 until present)`);
    }
  };

  try {
    // ── users ─────────────────────────────────────────────────────────────
    // sessions_valid_after: global-session-invalidation on password change.
    // TIMESTAMPTZ NOT NULL DEFAULT NOW() so existing rows get a valid timestamp.
    await col("users.sessions_valid_after", `
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS sessions_valid_after TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);

    // TOTP / MFA columns — added May 2026.
    await col("users.totp_secret",       "ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT");
    await col("users.totp_enabled",      "ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false");
    await col("users.totp_backup_codes", "ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_backup_codes TEXT");

    // ── refresh_tokens ────────────────────────────────────────────────────
    await col("refresh_tokens.last_used_at",   "ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ");
    await col("refresh_tokens.revoked_at",     "ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ");
    await col("refresh_tokens.replaced_by_id", "ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS replaced_by_id TEXT");
    await col("refresh_tokens.user_agent",     "ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS user_agent TEXT");
    await col("refresh_tokens.ip",             "ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS ip TEXT");
    await col("refresh_tokens.device_name",    "ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS device_name TEXT");

    // ── managed_videos ────────────────────────────────────────────────────
    // All columns added to managed_videos after the initial production deploy.
    // ADD COLUMN IF NOT EXISTS is idempotent — safe to run on every boot.
    // Without this block, production DBs that were never re-migrated via
    // `drizzle-kit push` will throw SQLSTATE 42703 on every query that
    // touches these columns (admin Videos page, broadcast queue reload,
    // YouTube sync, etc.).

    // Upload metadata — added with the chunked-upload feature.
    await col("managed_videos.original_filename", "ALTER TABLE managed_videos ADD COLUMN IF NOT EXISTS original_filename TEXT");
    await col("managed_videos.mime_type",         "ALTER TABLE managed_videos ADD COLUMN IF NOT EXISTS mime_type TEXT");
    await col("managed_videos.size_bytes",        "ALTER TABLE managed_videos ADD COLUMN IF NOT EXISTS size_bytes BIGINT");
    await col("managed_videos.checksum_sha256",   "ALTER TABLE managed_videos ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT");
    await col("managed_videos.object_path",       "ALTER TABLE managed_videos ADD COLUMN IF NOT EXISTS object_path TEXT");
    await col("managed_videos.uploaded_by",       "ALTER TABLE managed_videos ADD COLUMN IF NOT EXISTS uploaded_by TEXT");
    await col("managed_videos.s3_mirrored_at",    "ALTER TABLE managed_videos ADD COLUMN IF NOT EXISTS s3_mirrored_at TIMESTAMPTZ");

    // Source-blob cleanup tracking — added with the storage cleanup worker.
    await col("managed_videos.source_cleanup_status", `
      ALTER TABLE managed_videos
        ADD COLUMN IF NOT EXISTS source_cleanup_status TEXT NOT NULL DEFAULT 'none'
    `);
    await col("managed_videos.source_cleanup_after",    "ALTER TABLE managed_videos ADD COLUMN IF NOT EXISTS source_cleanup_after TIMESTAMPTZ");
    await col("managed_videos.source_deleted_at",       "ALTER TABLE managed_videos ADD COLUMN IF NOT EXISTS source_deleted_at TIMESTAMPTZ");
    await col("managed_videos.source_cleanup_attempts", `
      ALTER TABLE managed_videos
        ADD COLUMN IF NOT EXISTS source_cleanup_attempts INTEGER NOT NULL DEFAULT 0
    `);

    // Admin metadata-lock — added May 2026.
    // Prevents YouTube sync from overwriting admin-curated category/preacher.
    await col("managed_videos.metadata_locked", `
      ALTER TABLE managed_videos
        ADD COLUMN IF NOT EXISTS metadata_locked BOOLEAN NOT NULL DEFAULT false
    `);
    // Faststart tracking — added May 2026.
    await col("managed_videos.faststart_applied", `
      ALTER TABLE managed_videos
        ADD COLUMN IF NOT EXISTS faststart_applied BOOLEAN NOT NULL DEFAULT false
    `);
    // Broadcast-only flag — added May 2026.
    // Public catalogue filters WHERE COALESCE(broadcast_only, false) = false.
    await col("managed_videos.broadcast_only", `
      ALTER TABLE managed_videos
        ADD COLUMN IF NOT EXISTS broadcast_only BOOLEAN NOT NULL DEFAULT false
    `);
    // Transcoding failure reason — added May 2026.
    await col("managed_videos.transcoding_error_message", `
      ALTER TABLE managed_videos
        ADD COLUMN IF NOT EXISTS transcoding_error_message TEXT
    `);
    // Machine-readable error classification code — added June 2026.
    // NOTE: drizzle-kit push silently skips this column on some prod DBs.
    await col("managed_videos.transcoding_error_code", `
      ALTER TABLE managed_videos
        ADD COLUMN IF NOT EXISTS transcoding_error_code TEXT
    `);
    // updated_at — added June 2026.
    // Drizzle's $onUpdate fires JS-side on every ORM UPDATE; without the column
    // every PATCH fails with SQLSTATE 42703.
    await col("managed_videos.updated_at", `
      ALTER TABLE managed_videos
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);
    // youtube_live_status — added June 2026 (YouTube Live Status feature).
    // Tracks whether a YouTube-sourced video is currently airing live or is a
    // VOD/replay. Written by live-status.service.ts. NULL for non-YouTube rows.
    // Without this guard, any query referencing schema.videosTable.youtubeLiveStatus
    // (SELECT, UPDATE, WHERE clause) throws SQLSTATE 42703 on prod DBs that
    // pre-date this column — crashing YouTube sync and live-status updates.
    await col("managed_videos.youtube_live_status", `
      ALTER TABLE managed_videos
        ADD COLUMN IF NOT EXISTS youtube_live_status TEXT
    `);
    // youtube_live_status_updated_at — added June 2026.
    // UTC timestamp of the last youtube_live_status write. Enables the background
    // sweep in live-status.service.ts to detect stale 'live' rows and heal them.
    await col("managed_videos.youtube_live_status_updated_at", `
      ALTER TABLE managed_videos
        ADD COLUMN IF NOT EXISTS youtube_live_status_updated_at TIMESTAMPTZ
    `);
    // transcoding_error_kind — added June 2026.
    // Machine-readable sub-kind of a terminal transcoding failure, e.g.
    // 'moov_absent' (MP4 with moov at EOF), 'structure_invalid' (unreadable
    // container), 'source_missing' (blob deleted before probe). Used by the
    // broadcast-v2 reprobe endpoint and the admin broadcast queue view.
    // Without this guard, any query touching the column on a pre-migration
    // prod DB throws SQLSTATE 42703.
    await col("managed_videos.transcoding_error_kind", `
      ALTER TABLE managed_videos
        ADD COLUMN IF NOT EXISTS transcoding_error_kind TEXT
    `);
    // faststart_attempts — added June 2026.
    // Counter incremented each time runFaststart() is attempted for a video.
    // The faststart-recovery worker uses this to enforce a per-process attempt
    // cap (MAX_ATTEMPTS=3) so a permanently corrupt source does not stampede
    // ffmpeg. NOT NULL DEFAULT 0 matches the Drizzle schema default.
    await col("managed_videos.faststart_attempts", `
      ALTER TABLE managed_videos
        ADD COLUMN IF NOT EXISTS faststart_attempts INTEGER NOT NULL DEFAULT 0
    `);

    // ── transcoding_jobs ──────────────────────────────────────────────────
    // last_progress_at — added June 2026 (stall-detection sprint 48).
    // Stall watchdog queries this column to detect frozen encodes.
    await col("transcoding_jobs.last_progress_at", `
      ALTER TABLE transcoding_jobs
        ADD COLUMN IF NOT EXISTS last_progress_at TIMESTAMPTZ
    `);
    // max_attempts default correction — DB was created with DEFAULT 3 but the
    // Drizzle schema expects DEFAULT 5. Update column default for new jobs only
    // (in-flight rows keep their existing attempt budget).
    await col("transcoding_jobs.max_attempts_default", `
      ALTER TABLE transcoding_jobs
        ALTER COLUMN max_attempts SET DEFAULT 5
    `);

    // ── broadcast_queue ───────────────────────────────────────────────────
    await col("broadcast_queue.hls_master_url",            "ALTER TABLE broadcast_queue ADD COLUMN IF NOT EXISTS hls_master_url TEXT");
    await col("broadcast_queue.scheduled_at",              "ALTER TABLE broadcast_queue ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ");
    await col("broadcast_queue.schedule_label",            "ALTER TABLE broadcast_queue ADD COLUMN IF NOT EXISTS schedule_label TEXT");
    // Written by the queue-integrity-validator when it auto-deactivates a row.
    // NOTE: drizzle-kit push silently skipped this column on existing prod DBs.
    await col("broadcast_queue.validator_deactivated_reason", `
      ALTER TABLE broadcast_queue
        ADD COLUMN IF NOT EXISTS validator_deactivated_reason TEXT
    `);

    // ── Data self-heal: broadcast_queue placeholder duration ──────────────
    // Rows inserted before faststart/ffprobe ran carry duration_secs=1800.
    // Sync the real duration from managed_videos so the queue-validator stops
    // flagging PLACEHOLDER_DURATION warnings for those historical rows.
    await col("broadcast_queue.duration_secs_selfheal", `
      UPDATE broadcast_queue bq
      SET    duration_secs = ROUND(mv.duration::numeric)
      FROM   managed_videos mv
      WHERE  bq.video_id    = mv.id
        AND  bq.duration_secs = 1800
        AND  mv.duration IS NOT NULL
        AND  mv.duration <> ''
        AND  mv.duration ~ '^[0-9]+(\\.[0-9]+)?$'
        AND  mv.duration::numeric > 10
    `);

    logger.info("db: user/auth schema columns ensured (all IF NOT EXISTS — idempotent)");
  } finally {
    client.release();
  }
}

/**
 * Mark youtube_sync_log entries stuck at status='running' as 'interrupted'.
 *
 * When the API process is killed (SIGKILL, OOM, container restart) while a
 * sync is in progress the finally-block in syncYouTubeChannel() cannot run,
 * leaving the row with status='running' and all stat columns NULL forever.
 * The admin "Sync" panel shows those rows as still in-progress, which is
 * misleading and can also block manual re-triggers if the service-level
 * semaphore is not reset.
 *
 * Recovery rule: any 'running' row older than 5 minutes at startup must have
 * been interrupted — a healthy sync never takes that long on this channel
 * (<1 min in production). We mark them 'interrupted' with a note so operators
 * can see exactly which runs were cut short and when.
 *
 * Called once at boot, non-blocking (errors are swallowed).
 */
export async function recoverStaleSyncLogs(): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      UPDATE youtube_sync_log
      SET    status       = 'interrupted',
             completed_at = NOW(),
             error_message = COALESCE(
               error_message,
               'Sync interrupted — server restarted before completion'
             )
      WHERE  status     = 'running'
        AND  started_at < NOW() - INTERVAL '5 minutes'
    `);
    const recovered = (result as unknown as { rowCount: number | null }).rowCount ?? 0;
    if (recovered > 0) {
      logger.warn(
        { recovered },
        "db: marked stale youtube_sync_log rows as 'interrupted' — " +
          "these syncs were cut short by a server restart; " +
          "trigger a manual sync from the admin panel to catch up",
      );
    } else {
      logger.info("db: no stale youtube_sync_log rows found at startup");
    }
  } catch (err) {
    // 42P01 = table doesn't exist (first boot before drizzle-kit push).
    // Any other error is also non-fatal — don't block startup.
    logger.warn({ err }, "db: recoverStaleSyncLogs failed (non-fatal)");
  } finally {
    client.release();
  }
}

/**
 * Periodic stale-data cleanup — removes expired/stale rows that accumulate
 * over time in high-churn tables and would never be swept by application logic.
 *
 * Runs once at startup (deferred 30 s so boot completes first) and then
 * every 6 hours. All DELETE statements are bounded, safe to re-run, and
 * will not block normal traffic for more than a few milliseconds on a
 * normally-sized installation.
 *
 * Tables swept:
 *   refresh_tokens        — rows past expires_at (JWTs already rejected)
 *   password_reset_tokens — rows past expires_at
 *   device_link_codes     — rows past expires_at
 *   viewer_sessions       — sessions with no heartbeat for >1 h and ended_at IS NULL
 *   upload_sessions       — completed/failed sessions older than 30 days
 *   rate_limit            — all rows (TRUNCATE; it's an in-process fallback table)
 *   broadcast_event_log   — events older than 14 days (replay window is seconds)
 */
export function scheduleStaleDataCleanup(): void {
  const INTERVAL_MS = 6 * 60 * 60 * 1_000; // 6 hours
  const STARTUP_DELAY_MS = 30_000;           // don't compete with boot queries

  async function runCleanup(): Promise<void> {
    const client = await pool.connect();
    try {
      const results: Record<string, number> = {};

      // Each sweep statement is attempted independently — one failure never
      // stops subsequent cleanup operations (e.g. a missing column in one
      // table should not prevent expiring tokens in another).
      const run = async (
        label: string,
        sql: string,
        opts: { ignoreMissingTable?: boolean } = {},
      ): Promise<void> => {
        try {
          const r = await client.query(sql);
          if (r.rowCount && r.rowCount > 0) results[label] = r.rowCount;
        } catch (err) {
          const pg = err as { code?: string };
          if (opts.ignoreMissingTable && pg.code === "42P01") {
            // Table doesn't exist yet (fresh DB or feature never deployed) — skip silently.
            return;
          }
          logger.warn({ err, sweep: label }, `db: stale-data cleanup step '${label}' failed (non-fatal)`);
        }
      };

      await run("refresh_tokens",
        "DELETE FROM refresh_tokens WHERE expires_at < NOW() - INTERVAL '1 day'");
      await run("password_reset_tokens",
        "DELETE FROM password_reset_tokens WHERE expires_at < NOW()");
      await run("device_link_codes",
        "DELETE FROM device_link_codes WHERE expires_at < NOW()");
      await run("viewer_sessions_stale",
        `DELETE FROM viewer_sessions
         WHERE ended_at IS NULL
           AND last_heartbeat_at < NOW() - INTERVAL '1 hour'`);
      await run("upload_sessions_old",
        `DELETE FROM upload_sessions
         WHERE status IN ('completed', 'failed', 'cancelled')
           AND created_at < NOW() - INTERVAL '30 days'`);
      // Sweep abandoned sessions that were stuck in 'uploading' status —
      // e.g. client disconnected mid-upload and never resumed. After 48 h
      // these are definitively abandoned and their storage_blobs rows were
      // already cleaned up by the orphan-blob sweeper above.
      await run("upload_sessions_abandoned",
        `DELETE FROM upload_sessions
         WHERE status = 'uploading'
           AND created_at < NOW() - INTERVAL '48 hours'`);
      await run("broadcast_event_log_old",
        "DELETE FROM broadcast_event_log WHERE created_at < NOW() - INTERVAL '14 days'");
      // rate_limit is an in-process sliding-window counter table used as a
      // Redis fallback when REDIS_URL is absent.  Rows accumulate indefinitely
      // (no TTL column, no expiry sweep) and are meaningless across restarts
      // because the counter state is rebuilt from scratch in memory.  TRUNCATE
      // removes the entire historical accumulation in O(1) — this is safe
      // because a single process restart already resets the in-memory counters
      // that back the table.
      // ignoreMissingTable=true: on a fresh DB or a deploy where Redis is
      // configured (so the pg-fallback table was never created), the TRUNCATE
      // would emit a noisy WARN every 6 h.  We silently skip 42P01 here.
      await run("rate_limit",
        "TRUNCATE TABLE rate_limit",
        { ignoreMissingTable: true });

      // ── Stuck-processing recovery ─────────────────────────────────────
      // 'processing' is the transient state set by runFaststart while it
      // atomically re-uploads the moov-optimised blob.  runFaststart
      // restores the prior status on a clean error path, but if the Node
      // process is killed mid-upload the row stays at 'processing' forever.
      // The startup reset in main.ts handles the previous-run case; this
      // sweep catches any crash that happened AFTER the last boot (e.g. an
      // OOM kill between cleanup runs).
      //
      // managed_videos.updated_at was added in June 2026.  We use it to
      // only reset rows stuck for longer than 20 minutes — safely above the
      // 15-minute faststart timeout — so a concurrent faststart in another
      // process is never accidentally reset.
      const stuckResult = await client.query(`
        UPDATE managed_videos
        SET    transcoding_status = CASE
                 WHEN local_video_url IS NOT NULL AND local_video_url != '' THEN 'queued'
                 ELSE 'none'
               END
        WHERE  transcoding_status = 'processing'
          AND  updated_at < NOW() - INTERVAL '20 minutes'
      `);
      const stuckReset = (stuckResult as unknown as { rowCount: number | null }).rowCount ?? 0;
      if (stuckReset > 0) {
        logger.warn(
          { stuckReset },
          "db: stale-cleanup: reset stuck 'processing' videos to queued/none — " +
            "these were interrupted mid-faststart; they are broadcast-ready at localVideoUrl",
        );
      }

      // ── Stuck-encoding recovery ────────────────────────────────────────
      // 'encoding' is the state set by the transcoder dispatcher when it
      // starts a job (job.status → processing, video → encoding). On a
      // clean failure or OOM-kill the dispatcher resets both; but if only
      // the job row was lost (manual deletion, watchdog force-fail, etc.)
      // the video stays 'encoding' indefinitely.
      //
      // Grace period: 90 minutes — well above the EARLY_STUCK threshold
      // (30 min) and the PROGRESS_STALE threshold (15 min) — so we never
      // race a legitimately long-running encode. Jobs that exceed the
      // stuck-job watchdog timeout will have already been failed/retried
      // before this 90-minute window opens.
      const stuckEncodingResult = await client.query(`
        UPDATE managed_videos mv
        SET    transcoding_status = CASE
                 WHEN mv.local_video_url IS NOT NULL AND mv.local_video_url != '' THEN 'queued'
                 ELSE 'none'
               END
        WHERE  mv.transcoding_status = 'encoding'
          AND  mv.updated_at < NOW() - INTERVAL '90 minutes'
          AND  NOT EXISTS (
            SELECT 1
            FROM   transcoding_jobs tj
            WHERE  tj.video_id  = mv.id
              AND  tj.status   IN ('processing', 'queued')
          )
      `);
      const stuckEncodingReset =
        (stuckEncodingResult as unknown as { rowCount: number | null }).rowCount ?? 0;
      if (stuckEncodingReset > 0) {
        logger.warn(
          { stuckEncodingReset },
          "db: stale-cleanup: reset stuck 'encoding' videos to queued/none — " +
            "no active job found after 90-minute grace; will be re-enqueued for transcoding",
        );
      }

      if (Object.keys(results).length > 0) {
        logger.info({ swept: results }, "db: stale-data cleanup completed");
      }
    } catch (err) {
      logger.warn({ err }, "db: stale-data cleanup failed (non-fatal)");
    } finally {
      client.release();
    }
  }

  const timer = setTimeout(() => {
    void runCleanup();
    const interval = setInterval(() => void runCleanup(), INTERVAL_MS);
    interval.unref?.();
  }, STARTUP_DELAY_MS);
  timer.unref?.();
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
