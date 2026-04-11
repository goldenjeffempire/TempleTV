import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";

export const transcodingJobsTable = pgTable("transcoding_jobs", {
  id: text("id").primaryKey(),
  videoId: text("video_id").notNull(),
  videoPath: text("video_path").notNull(),
  status: text("status").notNull().default("queued"),
  priority: integer("priority").notNull().default(0),
  progress: integer("progress").notNull().default(0),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TranscodingJob = typeof transcodingJobsTable.$inferSelect;
