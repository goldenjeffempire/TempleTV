/**
 * MFA / TOTP routes — POST /auth/mfa/*
 *
 * Setup flow (requires existing auth):
 *   POST /auth/mfa/setup   — generate secret + backup codes (stored, not yet active)
 *   POST /auth/mfa/enable  — verify first TOTP code → activate MFA on the account
 *   POST /auth/mfa/disable — verify TOTP or password → deactivate MFA
 *   GET  /auth/mfa/status  — whether MFA is configured for the current user
 *
 * Login flow (no existing auth):
 *   POST /auth/mfa/verify  — exchange mfaToken + TOTP code for real access+refresh tokens
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { SignJWT, jwtVerify } from "jose";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { env } from "../../config/env.js";
import { verifyPassword } from "./password.js";
import { signAccessToken, signRefreshToken } from "./jwt.js";
import { nanoid } from "nanoid";
import { UnauthorizedError, BadRequestError } from "../../shared/errors.js";
import {
  MfaSetupResponseSchema,
  MfaEnableBodySchema,
  MfaDisableBodySchema,
  MfaVerifyBodySchema,
  MfaStatusSchema,
  AuthTokensSchema,
} from "./auth.schemas.js";
import { createHash } from "node:crypto";
import {
  generateTotpSecret,
  buildOtpauthUri,
  verifyTotpCode,
  generateBackupCodes,
  hashBackupCode,
  consumeBackupCode,
} from "./totp.js";

const usersTable = schema.usersTable;
const refreshTokensTable = schema.refreshTokensTable;

const authRateLimit = {
  rateLimit: { max: 20, timeWindow: "1 minute" },
};

// ── MFA pending JWT helpers ───────────────────────────────────────────────────

const MFA_PENDING_TTL_SECS = 300; // 5 minutes
const MFA_PENDING_SECRET = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

async function signMfaPendingToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId, mfaPending: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MFA_PENDING_TTL_SECS}s`)
    .sign(MFA_PENDING_SECRET);
}

async function verifyMfaPendingToken(token: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, MFA_PENDING_SECRET, {
      algorithms: ["HS256"],
    });
    if (!payload.mfaPending || typeof payload.sub !== "string") {
      throw new UnauthorizedError("Invalid MFA token");
    }
    return payload.sub;
  } catch {
    throw new UnauthorizedError("MFA token is invalid or expired");
  }
}

// ── Route registration ────────────────────────────────────────────────────────

export async function mfaRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /**
   * GET /auth/mfa/status
   * Returns whether MFA is currently enabled for the authenticated user.
   */
  r.get(
    "/status",
    {
      preHandler: requireAuth("user"),
      schema: {
        tags: ["auth", "mfa"],
        summary: "Get MFA status for the current user",
        response: { 200: MfaStatusSchema },
      },
    },
    async (req) => {
      const userId = (req as any).user.id as string;
      const rows = await db
        .select({
          totpEnabled: usersTable.totpEnabled,
          totpSecret: usersTable.totpSecret,
          totpBackupCodes: usersTable.totpBackupCodes,
          updatedAt: usersTable.updatedAt,
        })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);
      const user = rows[0];
      if (!user) throw new UnauthorizedError("User not found");

      let backupCodesRemaining = 0;
      if (user.totpBackupCodes) {
        try {
          backupCodesRemaining = (JSON.parse(user.totpBackupCodes) as string[]).length;
        } catch { /* ignore */ }
      }

      return {
        enabled: user.totpEnabled,
        configuredAt: user.totpEnabled ? user.updatedAt.toISOString() : null,
        backupCodesRemaining,
      };
    },
  );

  /**
   * POST /auth/mfa/setup
   * Generates a TOTP secret + backup codes, stores them (not yet active),
   * and returns the otpauth:// URI for QR display + the plaintext backup codes.
   * Call POST /mfa/enable with a valid code to activate.
   */
  r.post(
    "/setup",
    {
      config: authRateLimit,
      preHandler: requireAuth("user"),
      schema: {
        tags: ["auth", "mfa"],
        summary: "Generate a new TOTP secret (not yet enabled)",
        response: { 200: MfaSetupResponseSchema },
      },
    },
    async (req) => {
      const userId = (req as any).user.id as string;
      const rows = await db
        .select({ email: usersTable.email })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);
      const user = rows[0];
      if (!user) throw new UnauthorizedError("User not found");

      const secret = generateTotpSecret();
      const backupCodes = generateBackupCodes(8);
      const hashedBackupCodes = backupCodes.map(hashBackupCode);

      await db
        .update(usersTable)
        .set({
          totpSecret: secret,
          totpEnabled: false,
          totpBackupCodes: JSON.stringify(hashedBackupCodes),
          updatedAt: new Date(),
        })
        .where(eq(usersTable.id, userId));

      return {
        secret,
        otpauthUri: buildOtpauthUri(secret, user.email),
        backupCodes,
      };
    },
  );

  /**
   * POST /auth/mfa/enable
   * Activates TOTP MFA after verifying the first code from the authenticator app.
   * Requires the user to have called POST /mfa/setup first.
   */
  r.post(
    "/enable",
    {
      config: authRateLimit,
      preHandler: requireAuth("user"),
      schema: {
        tags: ["auth", "mfa"],
        summary: "Activate MFA by verifying first TOTP code",
        body: MfaEnableBodySchema,
        response: { 200: z.object({ ok: z.boolean(), message: z.string() }) },
      },
    },
    async (req) => {
      const userId = (req as any).user.id as string;
      const rows = await db
        .select({ totpSecret: usersTable.totpSecret, totpEnabled: usersTable.totpEnabled })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);
      const user = rows[0];
      if (!user?.totpSecret) throw new BadRequestError("Run POST /auth/mfa/setup first");
      if (user.totpEnabled) throw new BadRequestError("MFA is already enabled");

      if (!verifyTotpCode(req.body.code, user.totpSecret)) {
        throw new UnauthorizedError("TOTP code is incorrect or expired");
      }

      await db
        .update(usersTable)
        .set({ totpEnabled: true, updatedAt: new Date() })
        .where(eq(usersTable.id, userId));

      return { ok: true, message: "MFA enabled successfully" };
    },
  );

  /**
   * POST /auth/mfa/disable
   * Disables TOTP MFA. Requires either a valid TOTP code or backup code plus
   * the account password to prevent account-takeover via stolen sessions.
   */
  r.post(
    "/disable",
    {
      config: authRateLimit,
      preHandler: requireAuth("user"),
      schema: {
        tags: ["auth", "mfa"],
        summary: "Disable MFA (requires TOTP or backup code + password)",
        body: MfaDisableBodySchema,
        response: { 200: z.object({ ok: z.boolean(), message: z.string() }) },
      },
    },
    async (req) => {
      const userId = (req as any).user.id as string;
      const rows = await db
        .select({
          totpSecret: usersTable.totpSecret,
          totpEnabled: usersTable.totpEnabled,
          totpBackupCodes: usersTable.totpBackupCodes,
          passwordHash: usersTable.passwordHash,
        })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);
      const user = rows[0];
      if (!user) throw new UnauthorizedError("User not found");
      if (!user.totpEnabled) throw new BadRequestError("MFA is not currently enabled");

      const passwordOk = await verifyPassword(req.body.password, user.passwordHash);
      if (!passwordOk) throw new UnauthorizedError("Password is incorrect");

      const { code, backupCode } = req.body;
      if (code && user.totpSecret) {
        if (!verifyTotpCode(code, user.totpSecret)) {
          throw new UnauthorizedError("TOTP code is incorrect or expired");
        }
      } else if (backupCode) {
        const hashed = user.totpBackupCodes ? (JSON.parse(user.totpBackupCodes) as string[]) : [];
        const { valid } = consumeBackupCode(backupCode, hashed);
        if (!valid) throw new UnauthorizedError("Backup code is invalid");
      } else {
        throw new BadRequestError("Provide either a TOTP code or backup code");
      }

      await db
        .update(usersTable)
        .set({
          totpEnabled: false,
          totpSecret: null,
          totpBackupCodes: null,
          updatedAt: new Date(),
        })
        .where(eq(usersTable.id, userId));

      return { ok: true, message: "MFA disabled successfully" };
    },
  );

  /**
   * POST /auth/mfa/verify
   * Exchange a short-lived mfaToken (from login step 1) + TOTP code for a real
   * access/refresh token pair. This completes the two-factor login flow.
   */
  r.post(
    "/verify",
    {
      config: authRateLimit,
      schema: {
        tags: ["auth", "mfa"],
        summary: "Complete MFA login — exchange mfaToken + TOTP code for session tokens",
        body: MfaVerifyBodySchema,
        response: { 200: AuthTokensSchema },
      },
    },
    async (req) => {
      const userId = await verifyMfaPendingToken(req.body.mfaToken);

      const rows = await db
        .select({
          id: usersTable.id,
          email: usersTable.email,
          role: usersTable.role,
          displayName: usersTable.displayName,
          totpSecret: usersTable.totpSecret,
          totpEnabled: usersTable.totpEnabled,
          totpBackupCodes: usersTable.totpBackupCodes,
        })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);
      const user = rows[0];
      if (!user || !user.totpEnabled || !user.totpSecret) {
        throw new UnauthorizedError("MFA token mismatch — account state changed");
      }

      const { code, backupCode } = req.body;

      if (code) {
        if (!verifyTotpCode(code, user.totpSecret)) {
          throw new UnauthorizedError("TOTP code is incorrect or expired");
        }
      } else if (backupCode) {
        const hashed = user.totpBackupCodes ? (JSON.parse(user.totpBackupCodes) as string[]) : [];
        const { valid, remaining } = consumeBackupCode(backupCode, hashed);
        if (!valid) throw new UnauthorizedError("Backup code is invalid");
        await db
          .update(usersTable)
          .set({ totpBackupCodes: JSON.stringify(remaining), updatedAt: new Date() })
          .where(eq(usersTable.id, userId));
      } else {
        throw new BadRequestError("Provide either a TOTP code or backup code");
      }

      // Issue full session tokens.
      const jti = nanoid(32);
      const accessToken = await signAccessToken({
        sub: user.id,
        email: user.email,
        role: user.role as any,
      });
      const refreshToken = await signRefreshToken({ sub: user.id, jti });
      const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);

      await db.insert(refreshTokensTable).values({
        id: jti,
        userId: user.id,
        tokenHash: createHash("sha256").update(refreshToken).digest("hex"),
        expiresAt,
        ip: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
      });

      return {
        accessToken,
        refreshToken,
        accessTokenExpiresIn: env.JWT_ACCESS_TTL_SECONDS,
        refreshTokenExpiresIn: env.JWT_REFRESH_TTL_SECONDS,
        user: {
          id: user.id,
          email: user.email,
          role: user.role as any,
          displayName: user.displayName,
        },
      };
    },
  );

  /**
   * POST /auth/mfa/regenerate-backup-codes
   * Replace all backup codes. Requires a valid TOTP code.
   */
  r.post(
    "/regenerate-backup-codes",
    {
      config: authRateLimit,
      preHandler: requireAuth("user"),
      schema: {
        tags: ["auth", "mfa"],
        summary: "Regenerate backup codes (invalidates all existing codes)",
        body: MfaEnableBodySchema,
        response: {
          200: z.object({ backupCodes: z.array(z.string()) }),
        },
      },
    },
    async (req) => {
      const userId = (req as any).user.id as string;
      const rows = await db
        .select({ totpSecret: usersTable.totpSecret, totpEnabled: usersTable.totpEnabled })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);
      const user = rows[0];
      if (!user?.totpEnabled || !user.totpSecret) {
        throw new BadRequestError("MFA is not enabled");
      }
      if (!verifyTotpCode(req.body.code, user.totpSecret)) {
        throw new UnauthorizedError("TOTP code is incorrect or expired");
      }

      const backupCodes = generateBackupCodes(8);
      const hashedBackupCodes = backupCodes.map(hashBackupCode);

      await db
        .update(usersTable)
        .set({ totpBackupCodes: JSON.stringify(hashedBackupCodes), updatedAt: new Date() })
        .where(eq(usersTable.id, userId));

      return { backupCodes };
    },
  );
}

export { signMfaPendingToken };
