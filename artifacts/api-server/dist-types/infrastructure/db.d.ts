import * as schema from "@workspace/db/schema";
export declare const db: import("drizzle-orm/node-postgres").NodePgDatabase<typeof schema> & {
    $client: import("pg").Pool;
};
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
export declare function ensureRuntimeIndexes(): Promise<void>;
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
