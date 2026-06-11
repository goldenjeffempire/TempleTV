import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Pending Storage Cleanup — tracks object-storage blobs scheduled for deletion.
 *
 * When an upload is cancelled, assembly fails, or a video is hard-deleted, the
 * raw blob in storage_blobs (or S3) must be cleaned up asynchronously. Writing
 * a row here decouples the "mark for cleanup" step from the actual deletion so
 * the request path stays fast and the cleanup worker retries safely on failures.
 *
 * Reasons:
 *   'upload_cancelled'   — user or admin cancelled an in-progress upload session.
 *   'assembly_failed'    — chunk assembly completed but finalize failed.
 *   'video_deleted'      — managed_videos row deleted; raw source blob orphaned.
 *   'superseded'         — blob replaced by a newer faststart/re-upload version.
 */
export const pendingStorageCleanupTable = pgTable("pending_storage_cleanup", {
  id: text("id").primaryKey(),
  // The storage key (object_path / storage_blobs.key) to delete.
  objectPath: text("object_path").notNull(),
  // Why the blob is queued for deletion.
  reason: text("reason").notNull(),
  // Optional reference to the video that owned this blob (for audit).
  videoId: text("video_id"),
  // When to attempt deletion; allows a configurable grace window before
  // permanently removing blobs (default: delete immediately).
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull().defaultNow(),
  // Last time a deletion was attempted.
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  // Number of failed deletion attempts. Used for exponential backoff.
  attempts: integer("attempts").notNull().default(0),
  // Set when the deletion succeeds; NULL while pending or retrying.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  // Error message from the most recent failed attempt.
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The cleanup worker polls: WHERE deleted_at IS NULL AND scheduled_at <= now()
  index("idx_pending_storage_cleanup_pending").on(t.scheduledAt).where(sql`deleted_at IS NULL`),
  // Dedup lookups by object path.
  index("idx_pending_storage_cleanup_object_path").on(t.objectPath),
]);

export type PendingStorageCleanup = typeof pendingStorageCleanupTable.$inferSelect;
export type NewPendingStorageCleanup = typeof pendingStorageCleanupTable.$inferInsert;
