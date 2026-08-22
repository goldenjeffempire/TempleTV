import { pgTable, text, timestamp, boolean, jsonb, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const chatMessagesTable = pgTable("chat_messages", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull(),
  userId: text("user_id"),
  displayName: text("display_name").notNull(),
  body: text("body").notNull(),
  broadcastItemId: text("broadcast_item_id"),
  broadcastItemTitle: text("broadcast_item_title"),
  ipHash: text("ip_hash"),
  /** Sender role at time of posting — used for badge rendering on all clients. */
  role: text("role"),
  /** Set by a moderator to visually highlight an important message. */
  isHighlighted: boolean("is_highlighted").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: text("deleted_by"),
}, (table) => [
  index("idx_chat_messages_channel_created_at").on(
    table.channelId,
    table.createdAt.desc(),
  ),
  index("idx_chat_messages_user_id").on(table.userId),
  index("idx_chat_messages_ip_hash").on(table.ipHash),
  index("idx_chat_messages_channel_not_deleted").on(
    table.channelId,
    table.createdAt.desc(),
  ).where(sql`deleted_at IS NULL`),
]);

export type ChatMessageRow = typeof chatMessagesTable.$inferSelect;

export const chatModerationTable = pgTable("chat_moderation", {
  id: text("id").primaryKey(),
  subjectKind: text("subject_kind").notNull(),
  subjectId: text("subject_id").notNull(),
  action: text("action").notNull(),
  reason: text("reason"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by"),
}, (table) => [
  index("idx_chat_moderation_subject").on(
    table.subjectKind,
    table.subjectId,
    table.action,
  ),
]);

export type ChatModerationRow = typeof chatModerationTable.$inferSelect;

/**
 * Per-channel broadcast chat settings.
 *
 * One row per channel (channelId is the PK). Settings are cached in-memory
 * by ChatHub and broadcast to all connected clients when changed so every
 * client surface stays in sync without polling.
 *
 * Columns:
 *   slowModeSecs  — 0 = off; >0 = minimum seconds between sends per user
 *                   (bypassed for admin/mod roles)
 *   subscriberOnly — when true, only authenticated users can send messages
 *   pinnedMessageId — foreign-key to chat_messages.id; null = no pin
 *   bannedKeywords  — JSON array of strings; any message containing one is
 *                     rejected with code "blocked" before DB insert
 *   updatedAt      — tracked so admin surfaces can show "last changed by"
 */
export const chatSettingsTable = pgTable("chat_settings", {
  channelId: text("channel_id").primaryKey(),
  slowModeSecs: integer("slow_mode_secs").notNull().default(0),
  subscriberOnly: boolean("subscriber_only").notNull().default(false),
  pinnedMessageId: text("pinned_message_id"),
  bannedKeywords: jsonb("banned_keywords")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ChatSettingsRow = typeof chatSettingsTable.$inferSelect;

/**
 * User reports on individual chat messages.
 *
 * The route is authenticated-only, so reporterUserId is always populated.
 * reporterIpHash is stored as audit metadata only — it does not drive
 * deduplication. Uniqueness is enforced at the DB level on
 * (message_id, reporter_user_id) so concurrent duplicate submits get a
 * 23505 unique-violation rather than two rows.
 */
export const chatMessageReportsTable = pgTable("chat_message_reports", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull(),
  /** Authenticated reporter's user ID. Always non-null (route requires auth). */
  reporterUserId: text("reporter_user_id").notNull(),
  /** Hashed IP stored as audit metadata. */
  reporterIpHash: text("reporter_ip_hash"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Set by a moderator when the report is reviewed. */
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: text("resolved_by"),
}, (table) => [
  index("idx_chat_reports_message_id").on(table.messageId),
  index("idx_chat_reports_reporter_user_id").on(table.reporterUserId),
  // Race-safe unique constraint: concurrent submits get 23505 not two rows.
  uniqueIndex("uq_chat_reports_message_reporter").on(table.messageId, table.reporterUserId),
]);

export type ChatMessageReportRow = typeof chatMessageReportsTable.$inferSelect;
