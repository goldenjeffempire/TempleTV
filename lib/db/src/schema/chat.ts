import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Live chat messages.
 *
 * Channel binding: `channel_id` ties every message to a broadcast room.
 * Today there is exactly one global room (`temple-tv-live`), but the column
 * is in place so per-event / per-stream rooms can be added without a
 * schema migration.
 *
 * Broadcast-aware context: `broadcast_item_id` and `broadcast_item_title`
 * snapshot the currently-airing playback item at the moment a message was
 * sent. This is what lets future surfaces ("highlights from the 9am
 * service", "what people said during the sermon") slice chat by segment
 * without joining back through the playback engine's transient queue
 * state.
 *
 * Soft delete: moderator deletes flip `deleted_at` rather than removing
 * the row, so audit logs and abuse forensics remain queryable.
 *
 * IP-hash (not IP): we store the hex-truncated SHA-256 of the connecting
 * IP rather than the raw address. That's enough to (a) ban repeat
 * offenders by hash and (b) let an admin correlate spam bursts, while
 * keeping us GDPR-defensible — the raw IP never lands in the chat table.
 */
export const chatMessagesTable = pgTable("chat_messages", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull(),
  userId: text("user_id"),
  displayName: text("display_name").notNull(),
  body: text("body").notNull(),
  broadcastItemId: text("broadcast_item_id"),
  broadcastItemTitle: text("broadcast_item_title"),
  ipHash: text("ip_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: text("deleted_by"),
}, (table) => [
  // History fetch is `WHERE channel_id = ? AND deleted_at IS NULL ORDER BY
  // created_at DESC LIMIT N` — a backward index walk on this composite
  // serves it without a sort node.
  index("idx_chat_messages_channel_created_at").on(
    table.channelId,
    table.createdAt.desc(),
  ),
]);

export type ChatMessageRow = typeof chatMessagesTable.$inferSelect;

/**
 * Active moderation actions (mutes + bans).
 *
 * Subject kind decouples the targeting strategy:
 *   - `user`: stable user id (for signed-in viewers)
 *   - `ip`  : hashed IP (catches anonymous viewers who can't be banned by
 *             user id)
 *
 * Indefinite actions have `expires_at = NULL`. The hot-path lookup in
 * `moderation.ts` filters by `(subject_kind, subject_id, action)` and
 * checks `expires_at` in JS, so the partial index below covers both the
 * temporal and permanent cases.
 */
export const chatModerationTable = pgTable("chat_moderation", {
  id: text("id").primaryKey(),
  subjectKind: text("subject_kind").notNull(), // 'user' | 'ip'
  subjectId: text("subject_id").notNull(),
  action: text("action").notNull(),            // 'mute' | 'ban'
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
