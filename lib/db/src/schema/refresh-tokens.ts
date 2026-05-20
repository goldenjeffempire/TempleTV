import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const refreshTokensTable = pgTable(
  "refresh_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replacedById: text("replaced_by_id"),
    userAgent: text("user_agent"),
    ip: text("ip"),
    deviceName: text("device_name"),
  },
  (t) => ({
    userIdx: index("refresh_tokens_user_id_idx").on(t.userId),
    expiresIdx: index("refresh_tokens_expires_at_idx").on(t.expiresAt),
  }),
);

export type RefreshToken = typeof refreshTokensTable.$inferSelect;
