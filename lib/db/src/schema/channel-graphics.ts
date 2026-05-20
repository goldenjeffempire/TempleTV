import { pgTable, text, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";

/**
 * Channel Graphics — on-air graphic overlays for Temple TV channels.
 *
 * Types:
 *   ticker      — Crawling news/scripture ticker bar at the bottom of screen.
 *                 `content` is the full ticker text (can be long).
 *   lower_third — Temporary name/title overlay (e.g. "Pst. John Doe — Senior Pastor").
 *                 `content` is the primary label; `subContent` is the role/subtitle.
 *   bug_text    — Extra text appended to the channel bug (e.g. "LIVE" or "REPLAY").
 *
 * Only one graphic of each type is active at a time per channel. When a new
 * one is activated, the previous active graphic of the same type is deactivated.
 *
 * Priority: higher number = drawn over lower number.
 */
export const channelGraphicsTable = pgTable(
  "channel_graphics",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id").notNull(),
    type: text("type", { enum: ["ticker", "lower_third", "bug_text"] }).notNull(),
    content: text("content").notNull(),
    subContent: text("sub_content"),
    isActive: boolean("is_active").notNull().default(true),
    /** Auto-dismiss after this many seconds. NULL = manual dismiss only. */
    durationSecs: integer("duration_secs"),
    priority: integer("priority").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_channel_graphics_channel_active").on(t.channelId, t.isActive),
    index("idx_channel_graphics_type_active").on(t.channelId, t.type, t.isActive),
  ],
);

export type ChannelGraphic = typeof channelGraphicsTable.$inferSelect;
export type NewChannelGraphic = typeof channelGraphicsTable.$inferInsert;
