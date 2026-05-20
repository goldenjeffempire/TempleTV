import { pgTable, text, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";

/**
 * Channels — named broadcast streams for the Temple TV network.
 *
 * Each channel has its own broadcast queue engine, EPG projection, and SSE
 * feed. The primary channel (isPrimary = true) is the one all legacy clients
 * connect to when they don't specify a channelId. Only one channel should be
 * primary at any time — enforced at the application layer.
 *
 * slug: URL-safe identifier, e.g. "main", "worship", "sermons"
 */
export const channelsTable = pgTable(
  "channels",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    description: text("description").notNull().default(""),
    logoUrl: text("logo_url"),
    color: text("color").notNull().default("#DC2626"),
    isPrimary: boolean("is_primary").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Fallback HLS URL used if the channel's queue is empty. */
    failoverHlsUrl: text("failover_hls_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_channels_active_sort").on(t.isActive, t.sortOrder),
    index("idx_channels_slug").on(t.slug),
  ],
);

export type Channel = typeof channelsTable.$inferSelect;
export type NewChannel = typeof channelsTable.$inferInsert;
