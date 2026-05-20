import { createHash, randomBytes } from "node:crypto";
import { eq, and, gt, lt, isNull, or } from "drizzle-orm";
import { logger } from "../../infrastructure/logger.js";
import { nanoid } from "nanoid";
import { db, schema } from "../../infrastructure/db.js";
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
// Runs opportunistically on every token issue — a lightweight background
// DELETE that prevents the refresh_tokens table from growing without bound.
// Non-fatal: any DB error is logged and swallowed.
const PRUNE_AFTER_DAYS = 30;
async function pruneExpiredRefreshTokens(userId: string): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000);
    await db
      .delete(refreshTokensTable)
      .where(
        and(
          eq(refreshTokensTable.userId, userId),
          or(
            lt(refreshTokensTable.expiresAt, cutoff),
            and(
              lt(refreshTokensTable.revokedAt!, cutoff),
            ),
          ),
        ),
      );
  } catch (err) {
    logger.warn({ err, userId }, "[auth] pruneExpiredRefreshTokens failed (non-fatal)");
  }
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

  // Fire-and-forget: prune stale rows for this user to keep the table lean.
  void pruneExpiredRefreshTokens(user.id);

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
    if (existing.length > 0) throw new ConflictError("Email already registered");

    const id = nanoid();
    const passwordHash = await hashPassword(body.password);
    const displayName = body.displayName ?? defaultDisplayName(email);

    const inserted = await db
      .insert(usersTable)
      .values({ id, email, passwordHash, displayName, role: "user" })
      .returning();
    const user = inserted[0];
    if (!user) throw new Error("user insert returned no row");

    // Fire-and-forget welcome email — never blocks registration.
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

    await db
      .update(refreshTokensTable)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokensTable.id, decoded.jti));

    const userRows = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, decoded.sub))
      .limit(1);
    const user = userRows[0];
    if (!user) throw new UnauthorizedError("User no longer exists");

    const { tokens } = await issueTokens(
      { id: user.id, email: user.email, role: coerceRole(user.role), displayName: user.displayName },
      ctx,
    );
    return tokens;
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
  async changePassword(userId: string, body: { currentPassword: string; newPassword: string }): Promise<void> {
    const rows = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const user = rows[0];
    if (!user) throw new NotFoundError("User not found");
    const valid = await verifyPassword(body.currentPassword, user.passwordHash);
    if (!valid) throw new UnauthorizedError("Current password is incorrect");
    const newHash = await hashPassword(body.newPassword);
    await Promise.all([
      db.update(usersTable)
        .set({ passwordHash: newHash, updatedAt: new Date(), sessionsValidAfter: new Date() })
        .where(eq(usersTable.id, userId)),
      db.update(refreshTokensTable)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokensTable.userId, userId), isNull(refreshTokensTable.revokedAt))),
    ]);
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

    // Invalidate any previous unused tokens for this user so only the
    // most recent link is valid. We mark them used rather than deleting
    // so any in-transit links produce a clear "already used" error.
    await db
      .update(passwordResetTokensTable)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResetTokensTable.userId, user.id),
          isNull(passwordResetTokensTable.usedAt),
        ),
      );

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = sha256(rawToken);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

    await db.insert(passwordResetTokensTable).values({
      id: nanoid(),
      userId: user.id,
      tokenHash,
      expiresAt,
    });

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

    // Execute atomically: mark token used + update password in parallel.
    await Promise.all([
      db
        .update(passwordResetTokensTable)
        .set({ usedAt: new Date() })
        .where(eq(passwordResetTokensTable.id, tokenRow.id)),
      db
        .update(usersTable)
        .set({ passwordHash: newHash })
        .where(eq(usersTable.id, tokenRow.userId)),
    ]);

    // Revoke all existing refresh tokens so every active session is
    // invalidated — standard security practice after a password change.
    await db
      .update(refreshTokensTable)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokensTable.userId, tokenRow.userId),
          isNull(refreshTokensTable.revokedAt),
        ),
      );
  },
};
