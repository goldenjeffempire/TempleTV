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
 *
 * MFA (TOTP / RFC 6238) columns added May 2026:
 *   totpSecret      — base32-encoded 160-bit secret (null = MFA not configured)
 *   totpEnabled     — whether TOTP verification is required on login
 *   totpBackupCodes — SHA-256 hashes of one-time recovery codes (JSON array string)
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
    // TOTP MFA
    totpSecret: text("totp_secret"),
    totpEnabled: boolean("totp_enabled").notNull().default(false),
    totpBackupCodes: text("totp_backup_codes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    roleIdx: index("users_role_idx").on(t.role),
  }),
);

export type User = typeof usersTable.$inferSelect;
export type PublicUser = Omit<User, "passwordHash" | "sessionsValidAfter">;
