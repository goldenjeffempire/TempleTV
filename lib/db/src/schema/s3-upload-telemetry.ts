import { pgTable, text, timestamp, integer, bigint, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const S3_TELEMETRY_EVENTS = [
  "init",          // server: presigned PUT URL minted
  "success",       // server: finalize succeeded → DB row inserted
  "server_fail",   // server: finalize rejected (HEAD missing, ACL fail, etc.)
  "client_error",  // client: XHR network error or HTTP error from S3
  "client_stall",  // client: stall watchdog tripped (no bytes for N seconds)
  "client_abort",  // client: user paused/cancelled the upload
] as const;
export type S3TelemetryEvent = (typeof S3_TELEMETRY_EVENTS)[number];

export const s3UploadTelemetryTable = pgTable(
  "s3_upload_telemetry",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id"),
    videoId: text("video_id"),
    event: text("event").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    durationMs: integer("duration_ms"),
    throughputBps: bigint("throughput_bps", { mode: "number" }),
    errorKind: text("error_kind"),
    errorMessage: text("error_message"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_s3_telemetry_event").on(t.event),
    index("idx_s3_telemetry_created_at").on(t.createdAt),
    index("idx_s3_telemetry_session").on(t.sessionId),
  ],
);

export const insertS3UploadTelemetrySchema = createInsertSchema(s3UploadTelemetryTable).omit({
  createdAt: true,
});
export type InsertS3UploadTelemetry = z.infer<typeof insertS3UploadTelemetrySchema>;
export type S3UploadTelemetry = typeof s3UploadTelemetryTable.$inferSelect;
