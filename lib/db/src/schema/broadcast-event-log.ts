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
    // eventType filter used by admin log dashboards and alert monitors.
    // Without this a filter on event_type alone requires a full table scan
    // on what can be a high-volume table (every broadcast tick emits events).
    index("broadcast_event_log_event_type_idx").on(t.eventType),
  ],
);

export type BroadcastEventLogRow = typeof broadcastEventLogTable.$inferSelect;
