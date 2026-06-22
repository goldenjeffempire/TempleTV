import { pgTable, text, timestamp, integer, boolean, index, jsonb } from "drizzle-orm/pg-core";
import { broadcastQueueTable } from "./broadcast-queue";

/**
 * Persistent repair state machine for broadcast queue items.
 *
 * Tracks the lifecycle of automated and manual source-recovery attempts
 * for every active queue item. One row per queue item (upserted on first scan).
 *
 * State transitions:
 *   healthy     → quarantined : gap2/gap3 confidence OR explicit quarantine action
 *   quarantined → repairing   : self-healing worker picks it up
 *   repairing   → approved    : source verified reachable after repair
 *   repairing   → quarantined : repair failed but repairAttempts < MAX_ATTEMPTS
 *   repairing   → blocked     : repair failed and repairAttempts >= MAX_ATTEMPTS
 *   blocked     → quarantined : manual operator reset OR content-hash change detected
 *   approved    → healthy     : verification sweep confirms still reachable
 *   any         → healthy     : manual operator approval
 */
export const queueAssetHealthTable = pgTable("queue_asset_health", {
  id: text("id").primaryKey(),

  queueItemId: text("queue_item_id")
    .notNull()
    .references(() => broadcastQueueTable.id, { onDelete: "cascade" }),

  videoId: text("video_id"),

  /**
   * Current repair state.
   * Values: healthy | quarantined | repairing | approved | blocked
   */
  state: text("state").notNull().default("healthy"),

  /** How many automated repair attempts have been made. Resets on manual reset. */
  repairAttempts: integer("repair_attempts").notNull().default(0),

  /** Timestamp of the last repair attempt (null = never attempted). */
  lastRepairAt: timestamp("last_repair_at", { withTimezone: true }),

  /** When the self-healing worker should next try to repair this item. */
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),

  /** Machine-readable code of the last error that caused quarantine. */
  lastErrorCode: text("last_error_code"),

  /** Human-readable description of the last error. */
  lastError: text("last_error"),

  /** Operator-friendly repair suggestion computed by the worker. */
  suggestedFix: text("suggested_fix"),

  /**
   * SHA-256 / ETag of source content at last successful probe.
   * Used for change-detection: a new hash after quarantine resets the
   * repair cycle (content was re-uploaded → start fresh).
   */
  sourceHash: text("source_hash"),

  /**
   * Whether the worker should skip automated repair for this item.
   * Operators can set this via the admin panel to prevent interference
   * with a manual repair in progress.
   */
  autoRepairPaused: boolean("auto_repair_paused").notNull().default(false),

  /**
   * Structured audit log of all repair actions (automated + manual).
   * Array of { ts, actor, action, detail, outcome } entries.
   * Capped at 50 entries (oldest pruned).
   */
  repairLog: jsonb("repair_log").default([]).notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_queue_asset_health_queue_item_id").on(table.queueItemId),
  index("idx_queue_asset_health_state").on(table.state),
  index("idx_queue_asset_health_next_retry").on(table.nextRetryAt),
]);

export type QueueAssetHealth = typeof queueAssetHealthTable.$inferSelect;
export type QueueAssetHealthState = "healthy" | "quarantined" | "repairing" | "approved" | "blocked";

export interface RepairLogEntry {
  ts: string;
  actor: "system" | "operator";
  action: string;
  detail: string;
  outcome: "success" | "failure" | "pending" | "skipped";
}
