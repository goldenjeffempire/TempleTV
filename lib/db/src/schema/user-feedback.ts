import { pgTable, text, boolean, timestamp, index } from "drizzle-orm/pg-core";

export const userFeedbackTable = pgTable("user_feedback", {
  id: text("id").primaryKey(),
  type: text("type").notNull(), // "bug" | "suggestion" | "general"
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  platform: text("platform").notNull().default("mobile"), // "mobile" | "web" | "tv"
  appVersion: text("app_version"),
  userId: text("user_id"),
  userEmail: text("user_email"),
  isRead: boolean("is_read").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("user_feedback_created_at_idx").on(t.createdAt),
  index("user_feedback_is_read_idx").on(t.isRead),
  index("user_feedback_type_idx").on(t.type),
]);

export type UserFeedback = typeof userFeedbackTable.$inferSelect;
