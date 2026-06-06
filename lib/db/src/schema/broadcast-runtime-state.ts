import { pgTable, text, integer, bigint, timestamp, index, jsonb } from "drizzle-orm/pg-core";

export const broadcastRuntimeStateTable = pgTable(
  "broadcast_runtime_state",
  {
    channelId: text("channel_id").primaryKey(),
    mode: text("mode").notNull().default("queue"),
    currentItemId: text("current_item_id"),
    startedAtMs: bigint("started_at_ms", { mode: "number" }),
    offsetMs: integer("offset_ms").notNull().default(0),
    activeOverrideId: text("active_override_id"),
    sequence: bigint("sequence", { mode: "number" }).notNull().default(0),
    // Persisted bad-URL skip-count and blacklist cache. Restored on boot so
    // URLs confirmed unreachable before a restart stay out of broadcast
    // rotation for the remainder of their suspension window, and accumulated
    // failure counts survive short process restarts.
    // Shape: { urlCache: { [url]: expiresAtMs }, skipCounts: { [itemId]: count } }
    badUrlCache: jsonb("bad_url_cache"),
    // $onUpdateFn ensures the column is refreshed on every Drizzle-driven UPDATE,
    // not just on INSERT (defaultNow() only fires at INSERT time).
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [index("broadcast_runtime_state_mode_idx").on(t.mode)],
);

export type BroadcastRuntimeStateRow = typeof broadcastRuntimeStateTable.$inferSelect;
