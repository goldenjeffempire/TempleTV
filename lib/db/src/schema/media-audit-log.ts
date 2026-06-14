import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const mediaAuditLogTable = pgTable(
  "media_audit_log",
  {
    id: text("id").primaryKey(),
    videoId: text("video_id"),
    action: text("action").notNull(),
    reason: text("reason"),
    errorCode: text("error_code"),
    triggeredBy: text("triggered_by").notNull().default("system"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    videoIdx: index("media_audit_log_video_id_idx").on(t.videoId),
    actionIdx: index("media_audit_log_action_idx").on(t.action),
    createdAtIdx: index("media_audit_log_created_at_idx").on(t.createdAt),
  }),
);

export type MediaAuditLog = typeof mediaAuditLogTable.$inferSelect;
export type NewMediaAuditLog = typeof mediaAuditLogTable.$inferInsert;
