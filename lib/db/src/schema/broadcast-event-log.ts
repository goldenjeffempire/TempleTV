import { pgTable, text, bigint, bigserial, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const broadcastEventLogTable = pgTable(
  "broadcast_event_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    channelId: text("channel_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("broadcast_event_log_channel_seq_uq").on(t.channelId, t.sequence),
    index("broadcast_event_log_channel_created_idx").on(t.channelId, t.createdAt),
  ],
);

export type BroadcastEventLogRow = typeof broadcastEventLogTable.$inferSelect;
