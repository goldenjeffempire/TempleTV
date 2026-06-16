import { pgTable, text, timestamp, integer, index, jsonb, boolean } from "drizzle-orm/pg-core";
import { videosTable } from "./videos";

export const transcodingJobsTable = pgTable("transcoding_jobs", {
  id: text("id").primaryKey(),
  videoId: text("video_id").references(() => videosTable.id, { onDelete: "set null" }),
  videoPath: text("video_path").notNull(),
  status: text("status").notNull().default("queued"),
  stage: text("stage").notNull().default("pending"),
  priority: integer("priority").notNull().default(0),
  progress: integer("progress").notNull().default(0),
  stageProgress: integer("stage_progress").notNull().default(0),
  errorMessage: text("error_message"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastProgressAt: timestamp("last_progress_at", { withTimezone: true }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  leasedBy: text("leased_by"),
  checkpoint: jsonb("checkpoint"),
}, (t) => [
  index("idx_transcoding_jobs_status").on(t.status),
  index("idx_transcoding_jobs_video_id").on(t.videoId),
  index("idx_transcoding_jobs_next_retry_at").on(t.nextRetryAt),
  index("idx_transcoding_jobs_status_priority_created").on(t.status, t.priority, t.createdAt),
  index("idx_transcoding_jobs_lease_expires_at").on(t.leaseExpiresAt),
  index("idx_transcoding_jobs_leased_by").on(t.leasedBy),
]);

export type TranscodingJob = typeof transcodingJobsTable.$inferSelect;

export const transcodingWorkersTable = pgTable("transcoding_workers", {
  workerId: text("worker_id").primaryKey(),
  hostname: text("hostname").notNull(),
  pid: integer("pid").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  currentJobId: text("current_job_id"),
  currentStage: text("current_stage"),
  jobsCompleted: integer("jobs_completed").notNull().default(0),
  jobsFailed: integer("jobs_failed").notNull().default(0),
  version: text("version"),
}, (t) => [
  index("idx_transcoding_workers_last_heartbeat").on(t.lastHeartbeatAt),
]);

export type TranscodingWorker = typeof transcodingWorkersTable.$inferSelect;

export const transcodingJobEventsTable = pgTable("transcoding_job_events", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => transcodingJobsTable.id, { onDelete: "cascade" }),
  workerId: text("worker_id"),
  eventType: text("event_type").notNull(),
  stage: text("stage"),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_transcoding_job_events_job_id_created").on(t.jobId, t.createdAt),
  index("idx_transcoding_job_events_created_at").on(t.createdAt),
]);

export type TranscodingJobEvent = typeof transcodingJobEventsTable.$inferSelect;

export const transcodingDeadLetterTable = pgTable("transcoding_dead_letter", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().unique(),
  videoId: text("video_id"),
  videoPath: text("video_path"),
  videoTitle: text("video_title"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  errorCode: text("error_code"),
  deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }).notNull().defaultNow(),
  requeuedAt: timestamp("requeued_at", { withTimezone: true }),
  notes: text("notes"),
  requeueCount: integer("requeue_count").notNull().default(0),
  nextDlqRetryAt: timestamp("next_dlq_retry_at", { withTimezone: true }),
  permanentFailure: boolean("permanent_failure").notNull().default(false),
}, (t) => [
  index("idx_transcoding_dead_letter_dead_lettered_at").on(t.deadLetteredAt),
  index("idx_transcoding_dead_letter_video_id").on(t.videoId),
]);

export type TranscodingDeadLetter = typeof transcodingDeadLetterTable.$inferSelect;
