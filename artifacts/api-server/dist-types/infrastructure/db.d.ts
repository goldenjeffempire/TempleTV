import * as schema from "@workspace/db/schema";
export declare const db: import("drizzle-orm/node-postgres").NodePgDatabase<typeof schema> & {
    $client: import("pg").Pool;
};
export declare const pgPool: import("pg").Pool;
export { schema };
export type Database = typeof db;
export declare function closeDb(): Promise<void>;
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
export declare function ensureBroadcastV2Tables(): Promise<void>;
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
export declare function ensureMemoryHourlySnapshotsTable(): Promise<void>;
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
export declare function ensureMidnightPrayersTable(): Promise<void>;
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
export declare function resetStuckProcessingVideos(): Promise<void>;
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
export declare function resetStuckEncodingVideos(): Promise<void>;
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
export declare function deactivateUnresolvableQueueRows(): Promise<void>;
export declare function ensureRuntimeIndexes(): Promise<void>;
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
export declare function ensureUserSchemaColumns(): Promise<void>;
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
export declare function recoverStaleSyncLogs(): Promise<void>;
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
export declare function scheduleStaleDataCleanup(): void;
/**
 * Wrap a DB call in bounded exponential-backoff retries for *transient*
 * errors only. Use sparingly — most code should let errors bubble up
 * to the global handler. Worth wrapping: idempotent reads, dispatcher
 * loops, health probes.
 */
export declare function withDbRetry<T>(fn: () => Promise<T>, opts?: {
    attempts?: number;
    baseDelayMs?: number;
    label?: string;
}): Promise<T>;
