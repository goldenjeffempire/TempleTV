import { pgTable, text, timestamp, boolean, index } from "drizzle-orm/pg-core";

/**
 * Application principals (signed-in viewers, editors, admins).
 *
 * `role` was added April 2026 alongside the rebuilt API. It uses a
 * plain text column rather than a pg enum so adding a new role doesn't
 * require an `ALTER TYPE` migration. Application code coerces it to the
 * `Role` union (`admin | editor | user | system`); any other value is
 * treated as `user` defensively.
 *
 * `sessionsValidAfter` is bumped on password change / logout-everywhere.
 * Access tokens whose `iat` is older than this timestamp are rejected,
 * giving us immediate global session invalidation without waiting for
 * JWT expiry.
 */
export const usersTable = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    role: text("role").notNull().default("user"),
    emailVerified: boolean("email_verified").notNull().default(false),
    sessionsValidAfter: timestamp("sessions_valid_after", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    roleIdx: index("users_role_idx").on(t.role),
  }),
);

export type User = typeof usersTable.$inferSelect;
export type PublicUser = Omit<User, "passwordHash" | "sessionsValidAfter">;
