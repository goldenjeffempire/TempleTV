import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Device-link codes power the "sign in on TV" flow. The TV (or any
 * keyboard-less device) calls /api/auth/device-link/create to mint a
 * short, human-readable code (e.g. "ABCD-1234") and then polls
 * /api/auth/device-link/exchange. The user, on a phone or laptop,
 * signs in with their account and POSTs the code to /claim, which
 * binds it to their userId. The TV's next /exchange call returns a
 * fresh access + refresh token pair and the code is consumed.
 *
 * Codes expire fast (10 min) and are single-use. They never carry
 * credentials by themselves — only the user's claim binds them.
 */
export const deviceLinkCodesTable = pgTable(
  "device_link_codes",
  {
    code: text("code").primaryKey(),
    userId: text("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deviceLabel: text("device_label"),
    ip: text("ip"),
  },
  (t) => ({
    expiresIdx: index("device_link_codes_expires_at_idx").on(t.expiresAt),
    userIdx: index("device_link_codes_user_id_idx").on(t.userId),
  }),
);

export type DeviceLinkCode = typeof deviceLinkCodesTable.$inferSelect;
