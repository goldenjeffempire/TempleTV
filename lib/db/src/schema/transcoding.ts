import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { videosTable } from "./videos.js";

export const transcodingJobsTable = pgTable("transcoding_jobs", {
  id: text("id").primaryKey(),
  // Nullable: when the parent managed_videos row is deleted the FK is set to NULL
  // so the job record is preserved for audit rather than cascade-deleted.
  videoId: text("video_id").references(() => videosTable.id, { onDelete: "set null" }),
  videoPath: text("video_path").notNull(),
  status: text("status").notNull().default("queued"),
  priority: integer("priority").notNull().default(0),
  progress: integer("progress").notNull().default(0),
  errorMessage: text("error_message"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastProgressAt: timestamp("last_progress_at", { withTimezone: true }),
}, (t) => [
  index("idx_transcoding_jobs_status").on(t.status),
  index("idx_transcoding_jobs_video_id").on(t.videoId),
  index("idx_transcoding_jobs_next_retry_at").on(t.nextRetryAt),
  index("idx_transcoding_jobs_status_priority_created").on(t.status, t.priority, t.createdAt),
]);

export type TranscodingJob = typeof transcodingJobsTable.$inferSelect;
