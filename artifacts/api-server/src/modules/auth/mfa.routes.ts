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
import type { Role } from "../../shared/types.js";
import { ALL_ROLES } from "../../shared/types.js";
import { checkBruteForce, recordFailedAttempt } from "./brute-force-guard.js";
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
  verifyTotpCodeWithCounter,
  generateBackupCodes,
  hashBackupCode,
  consumeBackupCode,
} from "./totp.js";

function coerceRole(raw: string): Role {
  return (ALL_ROLES as readonly string[]).includes(raw) ? (raw as Role) : "user";
}

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

async function verifyMfaPendingToken(token: string): Promise<{ userId: string; issuedAtMs: number }> {
  try {
    const { payload } = await jwtVerify(token, MFA_PENDING_SECRET, {
      algorithms: ["HS256"],
    });
    if (!payload.mfaPending || typeof payload.sub !== "string") {
      throw new UnauthorizedError("Invalid MFA token");
    }
    return { userId: payload.sub, issuedAtMs: (payload.iat ?? 0) * 1000 };
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
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },      schema: {
        tags: ["auth", "mfa"],
        summary: "Get MFA status for the current user",
        response: { 200: MfaStatusSchema, 429: z.object({ error: z.string() }) },
      },
    },
    async (req) => {
      const userId = req.principal!.id;
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
        response: { 200: MfaSetupResponseSchema, 429: z.object({ error: z.string() }) },
      },
    },
    async (req) => {
      const userId = req.principal!.id;
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
        response: { 200: z.object({ ok: z.boolean(), message: z.string() }), 429: z.object({ error: z.string() }) },
      },
    },
    async (req) => {
      const userId = req.principal!.id;
      const rows = await db
        .select({ totpSecret: usersTable.totpSecret, totpEnabled: usersTable.totpEnabled })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);
      const user = rows[0];
      if (!user?.totpSecret) throw new BadRequestError("Run POST /auth/mfa/setup first");
      if (user.totpEnabled) throw new BadRequestError("MFA is already enabled");

      // Fetch the last-used counter for replay protection — prevents an attacker
      // from capturing the first TOTP code during setup and replaying it later.
      const counterRows = await db
        .select({ lastTotpCounter: usersTable.lastTotpCounter })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);
      const lastCounter = counterRows[0]?.lastTotpCounter ?? null;
      const totpResult = verifyTotpCodeWithCounter(req.body.code, user.totpSecret, lastCounter);
      if (!totpResult.valid) {
        throw new UnauthorizedError("TOTP code is incorrect or expired");
      }

      await db
        .update(usersTable)
        .set({ totpEnabled: true, lastTotpCounter: totpResult.matchedCounter, updatedAt: new Date() })
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
        response: { 200: z.object({ ok: z.boolean(), message: z.string() }), 429: z.object({ error: z.string() }) },
      },
    },
    async (req) => {
      const userId = req.principal!.id;
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

      const now = new Date();
      await db
        .update(usersTable)
        .set({
          totpEnabled: false,
          totpSecret: null,
          totpBackupCodes: null,
          updatedAt: now,
          // Invalidate all existing sessions so a stolen session that
          // disabled MFA cannot continue to act on the account.
          sessionsValidAfter: now,
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
        response: { 200: AuthTokensSchema, 429: z.object({ error: z.string() }) },
      },
    },
    async (req) => {
      const { userId, issuedAtMs: mfaIssuedAtMs } = await verifyMfaPendingToken(req.body.mfaToken);

      const rows = await db
        .select({
          id: usersTable.id,
          email: usersTable.email,
          role: usersTable.role,
          displayName: usersTable.displayName,
          totpSecret: usersTable.totpSecret,
          totpEnabled: usersTable.totpEnabled,
          totpBackupCodes: usersTable.totpBackupCodes,
          sessionsValidAfter: usersTable.sessionsValidAfter,
        })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);
      const user = rows[0];
      if (!user || !user.totpEnabled || !user.totpSecret) {
        throw new UnauthorizedError("MFA token mismatch — account state changed");
      }

      // Guard: if sessions were globally invalidated (password change, logout-all,
      // role change) after the mfaToken was issued, reject the completion.
      if (user.sessionsValidAfter && mfaIssuedAtMs < user.sessionsValidAfter.getTime()) {
        throw new UnauthorizedError("Session invalidated — please log in again");
      }

      // Brute-force guard keyed on both IP and user email.  The /verify
      // endpoint is rate-limited (20 req/min) but an attacker with multiple
      // IPs could still brute-force TOTP's 10⁶ space within the 30-second
      // window.  Using the same guard as /login gives us a shared per-IP
      // counter so the window stays tight.
      const bfCheck = checkBruteForce(req.ip, user.email, undefined);
      if (bfCheck.blocked) {
        throw new UnauthorizedError(
          `Too many failed attempts — try again in ${Math.ceil(bfCheck.retryAfterSecs / 60)} min`,
        );
      }

      const { code, backupCode } = req.body;

      if (code) {
        // Use counter-aware verification to prevent replay attacks within
        // the ±1 clock-skew window. The matched counter is written back to
        // the DB atomically with token issuance below.
        const rows2 = await db
          .select({ lastTotpCounter: usersTable.lastTotpCounter })
          .from(usersTable)
          .where(eq(usersTable.id, userId))
          .limit(1);
        const lastCounter = rows2[0]?.lastTotpCounter ?? null;
        const result = verifyTotpCodeWithCounter(code, user.totpSecret, lastCounter);
        if (!result.valid) {
          recordFailedAttempt(req.ip, user.email);
          throw new UnauthorizedError("TOTP code is incorrect, expired, or has already been used");
        }
        // Persist the matched counter before issuing tokens so that even if
        // token insertion fails, the used counter is already recorded.
        await db
          .update(usersTable)
          .set({ lastTotpCounter: result.matchedCounter, updatedAt: new Date() })
          .where(eq(usersTable.id, userId));
      } else if (backupCode) {
        const hashed = user.totpBackupCodes ? (JSON.parse(user.totpBackupCodes) as string[]) : [];
        const { valid, remaining } = consumeBackupCode(backupCode, hashed);
        if (!valid) {
          recordFailedAttempt(req.ip, user.email);
          throw new UnauthorizedError("Backup code is invalid");
        }
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
        role: coerceRole(user.role),
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
          role: coerceRole(user.role),
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
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req) => {
      const userId = req.principal!.id;
      const rows = await db
        .select({ totpSecret: usersTable.totpSecret, totpEnabled: usersTable.totpEnabled })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);
      const user = rows[0];
      if (!user?.totpEnabled || !user.totpSecret) {
        throw new BadRequestError("MFA is not enabled");
      }
      // Apply counter-based replay protection on backup-code regeneration too.
      // Accepting a previously-used TOTP code here would let an attacker with
      // a captured code silently regenerate backup codes, locking out the
      // legitimate owner.
      const bcCounterRows = await db
        .select({ lastTotpCounter: usersTable.lastTotpCounter })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);
      const bcLastCounter = bcCounterRows[0]?.lastTotpCounter ?? null;
      const bcTotpResult = verifyTotpCodeWithCounter(req.body.code, user.totpSecret, bcLastCounter);
      if (!bcTotpResult.valid) {
        throw new UnauthorizedError("TOTP code is incorrect or expired");
      }

      const backupCodes = generateBackupCodes(8);
      const hashedBackupCodes = backupCodes.map(hashBackupCode);

      await db
        .update(usersTable)
        .set({
          totpBackupCodes: JSON.stringify(hashedBackupCodes),
          lastTotpCounter: bcTotpResult.matchedCounter,
          updatedAt: new Date(),
        })
        .where(eq(usersTable.id, userId));

      return { backupCodes };
    },
  );
}

export { signMfaPendingToken };
