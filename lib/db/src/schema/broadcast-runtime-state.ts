import { pgTable, text, integer, bigint, boolean, timestamp, index, jsonb } from "drizzle-orm/pg-core";

export const broadcastRuntimeStateTable = pgTable(
  "broadcast_runtime_state",
  {
    channelId: text("channel_id").primaryKey(),
    mode: text("mode").notNull().default("queue"),
    currentItemId: text("current_item_id"),
    startedAtMs: bigint("started_at_ms", { mode: "number" }),
    offsetMs: integer("offset_ms").notNull().default(0),
    activeOverrideId: text("active_override_id"),
    sequence: bigint("sequence", { mode: "number" }).notNull().default(0),
    // Persisted bad-URL skip-count and blacklist cache. Restored on boot so
    // URLs confirmed unreachable before a restart stay out of broadcast
    // rotation for the remainder of their suspension window, and accumulated
    // failure counts survive short process restarts.
    // Shape: { urlCache: { [url]: expiresAtMs }, skipCounts: { [itemId]: count } }
    badUrlCache: jsonb("bad_url_cache"),
    // Operator-engaged failover state persisted across restarts so the engine
    // resumes in failover mode after a crash without requiring manual re-engagement.
    failoverActive: boolean("failover_active").notNull().default(false),
    failoverReason: text("failover_reason"),
    // Per-item consecutive failure counts from the media-integrity-scanner.
    // Persisted so failure budgets survive process restarts and bad URLs cannot
    // dodge suspension by triggering a restart before hitting the threshold.
    // Shape: { [itemId]: { count: number; lastFailedAtMs: number | null } }
    scannerFailureCounts: jsonb("scanner_failure_counts"),
    // DB-backed queue backup: a snapshot of the last known good queue items,
    // persisted after every successful orchestrator reload. Used as a primary
    // fallback when broadcast_queue is temporarily unreachable at boot (e.g.
    // transient PG connection issue). Eliminates the /tmp filesystem dependency.
    // Shape: { channelId: string; savedAt: number; items: CachedQueueItem[] }
    queueBackup: jsonb("queue_backup"),
    // $onUpdateFn ensures the column is refreshed on every Drizzle-driven UPDATE,
    // not just on INSERT (defaultNow() only fires at INSERT time).
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [index("broadcast_runtime_state_mode_idx").on(t.mode)],
);

export type BroadcastRuntimeStateRow = typeof broadcastRuntimeStateTable.$inferSelect;
