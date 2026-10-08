import { pgTable, text, timestamp, integer, bigint, boolean, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const viewerPresenceCredentials = pgTable("viewer_presence_credentials", {
  tokenHash: text("token_hash").primaryKey(),
  ownerKey: text("owner_key").notNull(),
  userId: text("user_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
    .default(sql`clock_timestamp() + interval '30 days'`),
}, t => [index("viewer_presence_credentials_expiry_idx").on(t.expiresAt)]);

export const viewerPresenceLeases = pgTable("viewer_presence_leases", {
  tokenHash: text("token_hash").primaryKey().references(() => viewerPresenceCredentials.tokenHash, { onDelete: "cascade" }),
  streamId: text("stream_id").notNull(),
  sequence: bigint("sequence", { mode: "number" }).notNull(),
  active: boolean("active").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  platform: text("platform"),
}, t => [
  index("viewer_presence_active_idx").on(t.streamId, t.expiresAt).where(sql`${t.active} = true`),
  index("viewer_presence_live_expiry_idx").on(t.expiresAt, t.streamId).where(sql`${t.active} = true`),
]);

export const viewerPresenceMetrics = pgTable("viewer_presence_metrics", {
  streamId: text("stream_id").primaryKey(),
  peak: integer("peak").notNull().default(0),
});
