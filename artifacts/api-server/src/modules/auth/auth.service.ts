import { createHash, randomBytes } from "node:crypto";
import { eq, and, gt, isNull } from "drizzle-orm";
import { logger } from "../../infrastructure/logger.js";
import { InternalError } from "../../shared/errors.js";
import { nanoid } from "nanoid";
import { db, schema, pgPool } from "../../infrastructure/db.js";
import { hashPassword, verifyPassword } from "./password.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "./jwt.js";
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  BadRequestError,
} from "../../shared/errors.js";
import type { ExtendResponse } from "./auth.schemas.js";
import { env } from "../../config/env.js";
import type { Role } from "../../shared/types.js";
import type { AuthTokens, LoginBody, RegisterBody, ForgotPasswordBody, ResetPasswordBody } from "./auth.schemas.js";
import { sendWelcomeEmail, sendPasswordResetEmail, PASSWORD_RESET_TTL_MS } from "../mail/mail.service.js";

const usersTable = schema.usersTable;
const refreshTokensTable = schema.refreshTokensTable;
const passwordResetTokensTable = schema.passwordResetTokensTable;

const ALLOWED_ROLES: ReadonlySet<Role> = new Set(["admin", "editor", "user", "system"]);

function coerceRole(raw: string): Role {
  return (ALLOWED_ROLES.has(raw as Role) ? (raw as Role) : "user");
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function defaultDisplayName(email: string): string {
  const local = email.split("@")[0] ?? "viewer";
  return local.slice(0, 80);
}

interface IssuedTokens {
  tokens: AuthTokens;
}

// Prune expired or revoked refresh tokens older than PRUNE_AFTER_DAYS days.
//
// Two variants:
//   - pruneAllExpiredRefreshTokens()  → global sweep across ALL users;
//     intended for the background worker that runs every 5 minutes.
//     Exported so main.ts can register it with workerSupervisor.
//   - (internal) per-user path removed from the login hot path.
//     Centralising pruning in a single periodic worker avoids a DB write
//     on every login / token-refresh, keeps the hot path lean, and ensures
//     the table is cleaned even for users who haven't logged in recently.
const PRUNE_AFTER_DAYS = 30;

/**
 * Delete all refresh token rows (across ALL users) that are either:
 *   - past their expiresAt, or
 *   - revoked and whose revokedAt is older than PRUNE_AFTER_DAYS days.
 *
 * Returns the number of rows deleted (for telemetry). Non-fatal — any DB
 * error is logged and re-thrown so the worker supervisor can track failures.
 */
export async function pruneAllExpiredRefreshTokens(): Promise<number> {
  const cutoff = new Date(Date.now() - PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000);
  // Use the raw pg pool instead of Drizzle's .returning() so we get the
  // driver-level rowCount without materialising deleted row IDs in memory.
  // On a large backlog, .returning({ id }) would build an array of thousands
  // of UUID strings before we just call .length on it — O(n) memory for O(1)
  // work.  pgPool.query() returns rowCount directly at O(1).
  const result = await pgPool.query(
    `DELETE FROM refresh_tokens
       WHERE expires_at < $1
          OR (revoked_at IS NOT NULL AND revoked_at < $1)`,
    [cutoff],
  );
  const count = result.rowCount ?? 0;
  if (count > 0) {
    logger.info({ pruned: count }, "[auth] pruneAllExpiredRefreshTokens: rows deleted");
  }
  return count;
}

async function issueTokens(
  user: { id: string; email: string; role: Role; displayName: string },
  ctx?: { ip?: string; userAgent?: string },
): Promise<IssuedTokens> {
  const jti = nanoid(32);
  const accessToken = await signAccessToken({ sub: user.id, email: user.email, role: user.role });
  const refreshToken = await signRefreshToken({ sub: user.id, jti });

  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);
  await db.insert(refreshTokensTable).values({
    id: jti,
    userId: user.id,
    tokenHash: sha256(refreshToken),
    expiresAt,
    // F22: store origin so re-validation can detect stolen-token replays
    ip: ctx?.ip ?? null,
    userAgent: ctx?.userAgent ?? null,
  });

  return {
    tokens: {
      accessToken,
      refreshToken,
      accessTokenExpiresIn: env.JWT_ACCESS_TTL_SECONDS,
      refreshTokenExpiresIn: env.JWT_REFRESH_TTL_SECONDS,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        displayName: user.displayName,
      },
    },
  };
}

export const authService = {
  async register(body: RegisterBody): Promise<AuthTokens> {
    const email = body.email.toLowerCase();
    const existing = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);
    if (existing.length > 0) throw new ConflictError("Unable to complete registration — please try different details");

    const id = nanoid();
    const passwordHash = await hashPassword(body.password);
    const displayName = body.displayName ?? defaultDisplayName(email);

    // The SELECT existence check above is not atomic with the INSERT below.
    // Two concurrent registrations for the same email can both pass the SELECT
    // and then race to INSERT; the users.email UNIQUE constraint rejects the
    // loser with SQLSTATE 23505. Map that to a clean 409 ConflictError instead
    // of letting a raw unique-violation surface to the caller as a 500.
    let inserted;
    try {
      inserted = await db
        .insert(usersTable)
        .values({ id, email, passwordHash, displayName, role: "user" })
        .returning();
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictError("Unable to complete registration — please try different details");
      }
      throw err;
    }
    const user = inserted[0];
    if (!user) throw new InternalError("user insert returned no row — please retry registration");

    // Fire-and-forget welcome email — never blocks registration.
    // sendWelcomeEmail uses sendMailSilent internally; errors are swallowed and
    // logged inside the mailer — no .catch() needed here.
    sendWelcomeEmail({ email: user.email, displayName: user.displayName });

    const { tokens } = await issueTokens({
      id: user.id,
      email: user.email,
      role: coerceRole(user.role),
      displayName: user.displayName,
    });
    return tokens;
  },

  async login(body: LoginBody): Promise<AuthTokens | { mfaRequired: true; mfaToken: string }> {
    const email = body.email.toLowerCase();
    const rows = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    const user = rows[0];
    if (!user) throw new UnauthorizedError("Invalid credentials");
    const ok = await verifyPassword(body.password, user.passwordHash);
    if (!ok) throw new UnauthorizedError("Invalid credentials");

    // If MFA is enabled, issue a short-lived MFA-pending token instead of full tokens.
    // The client must POST the TOTP code + this token to /auth/mfa/verify to get
    // a real access+refresh pair. The pending token is signed with the access secret
    // but carries a `mfaPending: true` claim that mfa.routes.ts validates.
    if (user.totpEnabled) {
      const { signMfaPendingToken } = await import("./mfa.routes.js");
      const mfaToken = await signMfaPendingToken(user.id);
      return { mfaRequired: true, mfaToken };
    }

    const { tokens } = await issueTokens({
      id: user.id,
      email: user.email,
      role: coerceRole(user.role),
      displayName: user.displayName,
    });
    return tokens;
  },

  async refresh(
    refreshToken: string,
    ctx?: { ip?: string; userAgent?: string },
  ): Promise<AuthTokens> {
    const decoded = await verifyRefreshToken(refreshToken);
    const tokenHash = sha256(refreshToken);

    const stored = await db
      .select()
      .from(refreshTokensTable)
      .where(
        and(
          eq(refreshTokensTable.id, decoded.jti),
          eq(refreshTokensTable.tokenHash, tokenHash),
          eq(refreshTokensTable.userId, decoded.sub),
          gt(refreshTokensTable.expiresAt, new Date()),
          isNull(refreshTokensTable.revokedAt),
        ),
      )
      .limit(1);
    if (stored.length === 0) {
      throw new UnauthorizedError("Refresh token revoked or unknown");
    }

    // F22: Soft-warn on IP / user-agent mismatch — could indicate a stolen
    // token replay. We do NOT hard-reject because legitimate IP changes are
    // common on mobile networks. Set REFRESH_TOKEN_STRICT_IP_CHECK=true to
    // upgrade this to a hard rejection.
    const row = stored[0]!;
    if (ctx?.ip && row.ip && ctx.ip !== row.ip) {
      logger.warn(
        { jti: decoded.jti, storedIp: row.ip, currentIp: ctx.ip, userId: decoded.sub },
        "[auth] refresh token IP mismatch — possible stolen-token replay",
      );
      if (env.REFRESH_TOKEN_STRICT_IP_CHECK) {
        throw new UnauthorizedError("Refresh token presented from an unexpected IP address");
      }
    }

    // Fetch the user before entering the transaction — read-only, no hold needed.
    const userRows = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, decoded.sub))
      .limit(1);
    const user = userRows[0];
    if (!user) throw new UnauthorizedError("User no longer exists");

    // Guard: if the user changed their password (or an admin force-invalidated
    // sessions), reject any refresh token issued before sessionsValidAfter.
    // Without this check a stolen long-lived refresh token can still obtain a
    // fresh access token even after the account owner resets their password,
    // because the new access token's iat would be after sessionsValidAfter.
    if (user.sessionsValidAfter) {
      const tokenIssuedAtMs = (decoded.iat ?? 0) * 1000;
      if (tokenIssuedAtMs < user.sessionsValidAfter.getTime()) {
        throw new UnauthorizedError("Session invalidated — please sign in again");
      }
    }

    // Generate new token values outside the transaction. JWT signing is pure
    // crypto — no DB I/O — so doing it outside minimises the transaction's
    // connection-pool hold time.
    const newJti = nanoid(32);
    const [newAccessToken, newRefreshToken] = await Promise.all([
      signAccessToken({ sub: user.id, email: user.email, role: coerceRole(user.role) }),
      signRefreshToken({ sub: user.id, jti: newJti }),
    ]);
    const newExpiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);

    // Atomically revoke the consumed token and insert the replacement so a
    // DB failure between the two writes never permanently logs the user out
    // (old token gone, no new token issued).
    //
    // Concurrent-refresh guard: two requests carrying the same refresh token
    // (e.g. a mobile client retrying on a slow network) can both decode the
    // JWT before either has a chance to revoke it. Without the `revokedAt IS
    // NULL` guard both transactions would succeed and two new sessions would
    // be minted from one rotation. The `.returning()` check detects the race:
    // the second writer sees 0 rows updated and fails with 401 so the client
    // retries with the NEW token it should have received from the first call.
    await db.transaction(async (tx) => {
      const revoked = await tx
        .update(refreshTokensTable)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(refreshTokensTable.id, decoded.jti),
            isNull(refreshTokensTable.revokedAt),
          ),
        )
        .returning({ id: refreshTokensTable.id });
      if (revoked.length === 0) {
        throw new UnauthorizedError("Refresh token already consumed");
      }
      await tx.insert(refreshTokensTable).values({
        id: newJti,
        userId: user.id,
        tokenHash: sha256(newRefreshToken),
        expiresAt: newExpiresAt,
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent ?? null,
      });
    });

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      accessTokenExpiresIn: env.JWT_ACCESS_TTL_SECONDS,
      refreshTokenExpiresIn: env.JWT_REFRESH_TTL_SECONDS,
      user: {
        id: user.id,
        email: user.email,
        role: coerceRole(user.role),
        displayName: user.displayName,
      },
    };
  },

  async logout(refreshToken?: string): Promise<void> {
    if (!refreshToken) return;
    try {
      const decoded = await verifyRefreshToken(refreshToken);
      await db
        .update(refreshTokensTable)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokensTable.id, decoded.jti));
    } catch {
      /* idempotent */
    }
  },

  /**
   * Non-rotating token extension — issues a new access token WITHOUT revoking
   * the refresh token. Used by the client keep-alive so session maintenance
   * never creates a rotation race between concurrent admin tabs.
   *
   * Rotation is still performed when the refresh token has < 7 days remaining,
   * ensuring long-lived sessions are silently extended before the refresh token
   * could expire.
   */
  async extend(refreshToken: string): Promise<ExtendResponse> {
    const decoded = await verifyRefreshToken(refreshToken);
    const tokenHash = sha256(refreshToken);

    const stored = await db
      .select()
      .from(refreshTokensTable)
      .where(
        and(
          eq(refreshTokensTable.id, decoded.jti),
          eq(refreshTokensTable.tokenHash, tokenHash),
          eq(refreshTokensTable.userId, decoded.sub),
          gt(refreshTokensTable.expiresAt, new Date()),
          isNull(refreshTokensTable.revokedAt),
        ),
      )
      .limit(1);

    if (stored.length === 0) {
      throw new UnauthorizedError("Refresh token revoked or unknown");
    }

    const row = stored[0]!;

    const userRows = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, decoded.sub))
      .limit(1);
    const user = userRows[0];
    if (!user) throw new UnauthorizedError("User no longer exists");

    // Guard: if the user changed their password (or an admin force-invalidated
    // sessions), reject any refresh token issued before sessionsValidAfter.
    // This closes the gap where extend() previously issued a new access token
    // from a stale refresh token that pre-dated the password change.
    if (user.sessionsValidAfter) {
      const tokenIssuedAtMs = (decoded.iat ?? 0) * 1000;
      if (tokenIssuedAtMs < user.sessionsValidAfter.getTime()) {
        throw new UnauthorizedError("Session invalidated — please sign in again");
      }
    }

    // Issue a new access token in-memory (no DB write in the happy path).
    const role = coerceRole(user.role);
    const accessToken = await signAccessToken({ sub: user.id, email: user.email, role });

    // Only rotate the refresh token when it is < 7 days from expiry so the
    // session can silently extend past the original 30-day window. In normal
    // operation (daily usage, keep-alive every 3 min) the refresh token is
    // rotated well before it would otherwise expire.
    const daysRemaining = (row.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysRemaining < 7) {
      // Near-expiry: revoke old token and issue a full new pair.
      await db
        .update(refreshTokensTable)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokensTable.id, decoded.jti));

      const { tokens } = await issueTokens(
        { id: user.id, email: user.email, role, displayName: user.displayName },
      );
      return {
        accessToken: tokens.accessToken,
        accessTokenExpiresIn: env.JWT_ACCESS_TTL_SECONDS,
        refreshToken: tokens.refreshToken,
        refreshTokenExpiresIn: env.JWT_REFRESH_TTL_SECONDS,
      };
    }

    // Happy path: new access token, same refresh token.
    return {
      accessToken,
      accessTokenExpiresIn: env.JWT_ACCESS_TTL_SECONDS,
    };
  },

  async getProfile(userId: string) {
    if (userId.startsWith("system:")) {
      return {
        id: userId,
        email: "system@temple.tv",
        role: "system" as Role,
        displayName: "System",
        createdAt: new Date(0).toISOString(),
        mfaEnabled: false,
      };
    }
    const rows = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const user = rows[0];
    if (!user) throw new NotFoundError("User not found");
    return {
      id: user.id,
      email: user.email,
      role: coerceRole(user.role),
      displayName: user.displayName,
      createdAt: user.createdAt.toISOString(),
      mfaEnabled: user.totpEnabled,
    };
  },

  /**
   * Change the authenticated user's password.
   * Verifies the current password before applying the new one, then
   * invalidates all active sessions for security (same as reset-password).
   */
  async changePassword(userId: string, body: { currentPassword: string; newPassword: string; totpCode?: string }): Promise<void> {
    const rows = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const user = rows[0];
    if (!user) throw new NotFoundError("User not found");
    const valid = await verifyPassword(body.currentPassword, user.passwordHash);
    if (!valid) throw new UnauthorizedError("Current password is incorrect");
    // MFA guard: if the account has TOTP enabled, require a valid TOTP code
    // before accepting the new password. Without this check, a hijacked session
    // can change the password and lock the legitimate owner out without ever
    // needing the second factor — a complete MFA bypass.
    // Capture the matched TOTP counter so we can persist it in the transaction
    // below and prevent replay attacks on subsequent password changes.
    let totpCounterToSave: bigint | null = null;
    if (user.totpEnabled) {
      if (!body.totpCode) {
        throw new UnauthorizedError("TOTP code is required to change password on MFA-enabled accounts");
      }
      const { verifyTotpCodeWithCounter } = await import("./totp.js");
      const counterRows = await db
        .select({ lastTotpCounter: usersTable.lastTotpCounter })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);
      const lastCounter = counterRows[0]?.lastTotpCounter ?? null;
      const totpResult = verifyTotpCodeWithCounter(body.totpCode, user.totpSecret!, lastCounter);
      if (!totpResult.valid) throw new UnauthorizedError("Invalid TOTP code");
      totpCounterToSave = totpResult.matchedCounter;
    }
    const newHash = await hashPassword(body.newPassword);
    const now = new Date();
    // Atomically update the password hash AND revoke all active sessions so
    // that a partial write cannot leave the account with a new password but
    // still-valid old sessions (or vice versa).
    await db.transaction(async (tx) => {
      await tx.update(usersTable)
        .set({
          passwordHash: newHash,
          updatedAt: now,
          sessionsValidAfter: now,
          ...(totpCounterToSave != null ? { lastTotpCounter: totpCounterToSave } : {}),
        })
        .where(eq(usersTable.id, userId));
      await tx.update(refreshTokensTable)
        .set({ revokedAt: now })
        .where(and(eq(refreshTokensTable.userId, userId), isNull(refreshTokensTable.revokedAt)));
    });
  },

  /**
   * Update the authenticated user's profile fields.
   * Only displayName is currently mutable via this endpoint.
   */
  async updateProfile(userId: string, body: { displayName?: string }): Promise<{ id: string; email: string; role: Role; displayName: string; createdAt: string; mfaEnabled: boolean }> {
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (body.displayName) update.displayName = body.displayName;
    const updated = await db.update(usersTable).set(update).where(eq(usersTable.id, userId)).returning();
    const user = updated[0];
    if (!user) throw new NotFoundError("User not found");
    return {
      id: user.id,
      email: user.email,
      role: coerceRole(user.role),
      displayName: user.displayName,
      createdAt: user.createdAt.toISOString(),
      mfaEnabled: user.totpEnabled,
    };
  },

  /**
   * Permanently delete the authenticated user's account.
   * Requires re-entering the current password as a confirmation step
   * (Apple App Store Review Guideline 5.1.1(v) — "If your app supports
   * account creation, you must also offer account deletion within the app").
   *
   * Cascade FKs on refresh_tokens / favorites / history / password_reset_tokens
   * / device_link_codes clean up dependent rows automatically.
   */
  async deleteAccount(userId: string, body: { currentPassword: string }): Promise<void> {
    const rows = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const user = rows[0];
    if (!user) throw new NotFoundError("User not found");
    const valid = await verifyPassword(body.currentPassword, user.passwordHash);
    if (!valid) throw new UnauthorizedError("Current password is incorrect");
    // Single DELETE — ON DELETE CASCADE removes all dependent rows.
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  },

  /**
   * Initiate a password reset flow.
   *
   * Always returns success (even for unknown emails) to prevent email
   * enumeration — callers cannot distinguish "email not found" from "email
   * sent" via this endpoint.
   */
  async forgotPassword(body: ForgotPasswordBody): Promise<void> {
    const email = body.email.toLowerCase();
    const rows = await db
      .select({ id: usersTable.id, email: usersTable.email, displayName: usersTable.displayName })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);
    const user = rows[0];
    // Silently return when user not found — anti-enumeration.
    if (!user) return;

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = sha256(rawToken);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

    // Atomically invalidate previous tokens AND insert the new one so the user
    // can never end up with zero valid tokens due to a mid-operation failure.
    // Without a transaction, a crash between the UPDATE and INSERT would leave
    // the user unable to reset their password (old links invalidated, new one
    // never created), forcing an operator intervention to unblock them.
    await db.transaction(async (tx) => {
      // Invalidate any previous unused tokens for this user so only the
      // most recent link is valid. We mark them used rather than deleting
      // so any in-transit links produce a clear "already used" error.
      await tx
        .update(passwordResetTokensTable)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(passwordResetTokensTable.userId, user.id),
            isNull(passwordResetTokensTable.usedAt),
          ),
        );
      await tx.insert(passwordResetTokensTable).values({
        id: nanoid(),
        userId: user.id,
        tokenHash,
        expiresAt,
      });
    });

    // sendPasswordResetEmail uses sendMailSilent internally; errors are swallowed
    // and logged inside the mailer — no .catch() needed here.
    sendPasswordResetEmail({ email: user.email, displayName: user.displayName }, rawToken);
  },

  /**
   * Complete a password reset using the token from the email link.
   * Throws BadRequestError when the token is invalid, expired, or already used.
   */
  async resetPassword(body: ResetPasswordBody): Promise<void> {
    const tokenHash = sha256(body.token);

    const tokenRows = await db
      .select()
      .from(passwordResetTokensTable)
      .where(
        and(
          eq(passwordResetTokensTable.tokenHash, tokenHash),
          gt(passwordResetTokensTable.expiresAt, new Date()),
          isNull(passwordResetTokensTable.usedAt),
        ),
      )
      .limit(1);

    const tokenRow = tokenRows[0];
    if (!tokenRow) {
      throw new BadRequestError("Password reset link is invalid, expired, or already used");
    }

    const newHash = await hashPassword(body.password);

    const now = new Date();

    // Execute atomically: mark token used + update password + bump
    // sessionsValidAfter + revoke all active refresh tokens — all in one
    // transaction.  Using separate queries would leave a window where:
    //   - the token is marked used but the password not updated (token burned)
    //   - the password is updated but old sessions remain valid (session gap)
    // Both are security bugs. Wrapping all four writes in one transaction
    // eliminates both races and ensures "logout everywhere" is guaranteed.
    await db.transaction(async (tx) => {
      // Atomic claim: if two concurrent requests carry the same reset token,
      // only the first UPDATE (WHERE usedAt IS NULL) will touch a row.
      // The second sees 0 rows returned and throws — the transaction rolls
      // back before touching the password, preventing an attacker from
      // overwriting a legitimate reset with a different password.
      const claimed = await tx
        .update(passwordResetTokensTable)
        .set({ usedAt: now })
        .where(
          and(
            eq(passwordResetTokensTable.id, tokenRow.id),
            isNull(passwordResetTokensTable.usedAt),
          ),
        )
        .returning({ id: passwordResetTokensTable.id });
      if (claimed.length === 0) {
        throw new BadRequestError("Password reset link is invalid, expired, or already used");
      }
      await tx
        .update(usersTable)
        .set({ passwordHash: newHash, sessionsValidAfter: now, updatedAt: now })
        .where(eq(usersTable.id, tokenRow.userId));
      // Revoke all existing refresh tokens inside the same transaction so a
      // crash between the password update and this revocation cannot leave
      // active sessions after a password reset — critical security guarantee.
      await tx
        .update(refreshTokensTable)
        .set({ revokedAt: now })
        .where(
          and(
            eq(refreshTokensTable.userId, tokenRow.userId),
            isNull(refreshTokensTable.revokedAt),
          ),
        );
    });
  },
};
