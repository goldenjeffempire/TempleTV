import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

export const playerPositionCheckpointTable = pgTable("player_position_checkpoint", {
  channelId: text("channel_id").primaryKey(),
  itemId: text("item_id"),
  positionMs: integer("position_ms").notNull().default(0),
  sourceHealth: text("source_health").notNull().default("ok"),
  // $onUpdateFn ensures the column is refreshed on every Drizzle-driven UPDATE,
  // not just on INSERT (defaultNow() only fires at INSERT time).
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
});

export type PlayerPositionCheckpointRow = typeof playerPositionCheckpointTable.$inferSelect;
