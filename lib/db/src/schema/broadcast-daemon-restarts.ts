import { pgTable, serial, text, integer, bigint, timestamp } from "drizzle-orm/pg-core";

/**
 * Tracks every broadcast daemon boot — what it resumed from and the position
 * it restored. Used by the admin panel to show restart history and prove that
 * state was preserved across deployments, crashes, and planned restarts.
 *
 * resume_source values:
 *   "checkpoint"   — resumed from DB runtime_state + player_position_checkpoint
 *   "disk_backup"  — DB hydrate returned empty; fell back to /tmp disk snapshot
 *   "cold_start"   — no persisted state found; started fresh from sequence 0
 */
export const broadcastDaemonRestartsTable = pgTable("broadcast_daemon_restarts", {
  id: serial("id").primaryKey(),
  channelId: text("channel_id").notNull(),
  restartedAt: timestamp("restarted_at", { withTimezone: true }).notNull().defaultNow(),
  /** What the orchestrator resumed from on this boot. */
  resumeSource: text("resume_source").notNull().default("cold_start"),
  /** broadcast_queue item_id that was playing when the last checkpoint was saved. */
  resumeItemId: text("resume_item_id"),
  /** Milliseconds into the item that the checkpoint captured. */
  resumePositionMs: integer("resume_position_ms").notNull().default(0),
  /** Broadcast sequence number restored from the persisted state. */
  resumeSequence: bigint("resume_sequence", { mode: "number" }).notNull().default(0),
});

export type BroadcastDaemonRestartRow = typeof broadcastDaemonRestartsTable.$inferSelect;
