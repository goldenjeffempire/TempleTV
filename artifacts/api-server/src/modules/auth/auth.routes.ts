import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ne, inArray, eq, and, isNull, gt } from "drizzle-orm";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import {
  AuthTokensSchema,
  ExtendBodySchema,
  ExtendResponseSchema,
  ForgotPasswordBodySchema,
  LoginBodySchema,
  LoginResponseSchema,
  MeResponseSchema,
  RefreshBodySchema,
  RegisterBodySchema,
  ResetPasswordBodySchema,
} from "./auth.schemas.js";
import { authService } from "./auth.service.js";
import { mfaRoutes } from "./mfa.routes.js";
import { signAccessToken, signRefreshToken } from "./jwt.js";
import { hashPassword } from "./password.js";
import { UnauthorizedError } from "../../shared/errors.js";
import { requireAuth, invalidateSessionsValidAfterCache } from "../../middleware/auth.js";
import type { Role } from "../../shared/types.js";
import { env } from "../../config/env.js";
import { db, schema } from "../../infrastructure/db.js";
import { nanoid } from "nanoid";
import {
  checkBruteForce,
  recordFailedAttempt,
  resetAttempts,
} from "./brute-force-guard.js";

// Stricter per-route rate limit for credential-bearing endpoints.
// Defaults to 20/min/IP — enough for a real user fat-fingering their
// password a few times, low enough to make online password-guessing
// attacks impractical. Tunable via RATE_LIMIT_AUTH_PER_MINUTE.
const authRateLimit = {
  rateLimit: {
    max: env.RATE_LIMIT_AUTH_PER_MINUTE,
    timeWindow: "1 minute",
  },
};

// Refresh token rotation gets its own higher limit (60/min) because it is
// called automatically by the client keep-alive, not triggered by human
// credential entry. Multiple authenticated admin tabs + aggressive keep-alive
// intervals can each fire independently — sharing the credential limit with
// /login would exhaust the 20/min budget for a normal operator.
const refreshRateLimit = {
  rateLimit: {
    max: 60,
    timeWindow: "1 minute",
  },
};

// Password-reset routes get a tighter limit (5/min) to reduce the
// attractiveness of using the endpoint as a spam relay.
const pwResetRateLimit = {
  rateLimit: {
    max: 5,
    timeWindow: "1 minute",
  },
};

export async function authRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/register",
    {
      config: authRateLimit,
      // Email + password payloads are a few hundred bytes. Cap at 1 MiB so a
      // client cannot trigger a 110 MiB parse by posting a huge JSON body to
      // a credential endpoint (the global bodyLimit is set for chunk uploads).
      bodyLimit: 1 * 1024 * 1024,
      schema: {
        tags: ["auth"],
        summary: "Register a new viewer account",
        body: RegisterBodySchema,
        response: { 201: AuthTokensSchema },
      },
    },
    async (req, reply) => {
      const tokens = await authService.register(req.body);
      reply.code(201);
      return tokens;
    },
  );

  r.post(
    "/login",
    {
      config: authRateLimit,
      bodyLimit: 1 * 1024 * 1024,
      schema: {
        tags: ["auth"],
        summary: "Exchange credentials for a JWT pair (returns MFA challenge if TOTP is enabled)",
        body: LoginBodySchema,
        response: {
          200: LoginResponseSchema,
          // Brute-force lockout — the handler sends this explicitly via
          // reply.code(429).send(…) when the IP or account is locked out.
          // Declaring it here removes the TypeScript cast and makes the response
          // visible in the generated OpenAPI spec.
          429: z.object({
            error: z.string(),
            retryAfterSecs: z.number().optional(),
            lockedBy: z.string().optional(),
          }),
        },
      },
    },
    async (req, reply) => {
      // Brute-force guard: check before reaching the password-hash comparison
      // so a locked-out key never burns bcrypt work-factor CPU cycles.
      const bypass = req.headers["x-bypass-rate-limit"] as string | undefined;
      const bfCheck = checkBruteForce(req.ip, req.body.email, bypass);
      if (bfCheck.blocked) {
        reply.header("Retry-After", String(bfCheck.retryAfterSecs));
        return reply.code(429).send({
          error: "Too many failed login attempts. Please try again later.",
          retryAfterSecs: bfCheck.retryAfterSecs,
          lockedBy: bfCheck.reason,
        });
      }
      try {
        const result = await authService.login(req.body);
        // Successful auth — clear attempt counters so the user is not
        // punished for earlier fat-finger failures.
        resetAttempts(req.ip, req.body.email);
        return result;
      } catch (err) {
        // Record only credential errors (wrong password / unknown email).
        // Unexpected server errors (DB down, etc.) must not lock users out.
        if (err instanceof UnauthorizedError) {
          recordFailedAttempt(req.ip, req.body.email);
        }
        throw err;
      }
    },
  );

  // MFA / TOTP sub-routes — mounted at /auth/mfa/*
  await app.register(mfaRoutes, { prefix: "/mfa" });

  r.post(
    "/refresh",
    {
      // Higher rate limit (60/min) — this is called automatically by the
      // admin keep-alive and by every concurrent tab's interval, not by human
      // credential entry. Sharing the 20/min login limit would exhaust it.
      config: refreshRateLimit,
      schema: {
        tags: ["auth"],
        summary: "Rotate refresh token + issue new access token",
        body: RefreshBodySchema,
        response: { 200: AuthTokensSchema },
      },
    },
    async (req) => authService.refresh(req.body.refreshToken, {
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? undefined,
    }),
  );

  // Non-rotating session extension — issues a new access token without
  // revoking the refresh token. Used by the client keep-alive so normal
  // session maintenance never creates a rotation race between concurrent admin
  // tabs. Only rotates when the refresh token has < 7 days remaining.
  //
  // Rate limit: 120/min — generous for keep-alive from many concurrent tabs.
  // DB cost: read (verify RT) + sign (new AT in-memory). No DB write unless
  // the refresh token is near-expiry and rotation is triggered.
  r.post(
    "/extend",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        tags: ["auth"],
        summary: "Extend session — issues new access token without rotating refresh token",
        body: ExtendBodySchema,
        response: { 200: ExtendResponseSchema, 429: z.object({ error: z.string() }) },
      },
    },
    async (req) => authService.extend(req.body.refreshToken),
  );

  // Lightweight session heartbeat — validates the access token signature and
  // expiry in-memory (no DB writes). Used as a fast-path health check before
  // operations that need a guaranteed-fresh session, and by monitoring tooling
  // that needs to assert the admin session is alive without consuming a refresh
  // token rotation.
  //
  // Rate limit: 120/min — intentionally generous since the keep-alive calls
  // this frequently and multiple tabs each have their own interval.
  r.get(
    "/session/ping",
    {
      preHandler: requireAuth(),
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        tags: ["auth"],
        summary: "Session heartbeat — validates access token without DB writes",
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            ok: z.literal(true),
            userId: z.string(),
            role: z.string(),
          }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req) => ({
      ok: true as const,
      userId: req.principal!.id,
      role: req.principal!.role,
    }),
  );

  r.post(
    "/logout",
    {
      config: authRateLimit,
      schema: {
        tags: ["auth"],
        summary: "Revoke a refresh token (body optional — clears server session when provided)",
        // Body is optional so clients that cannot provide the refresh token
        // (e.g. race condition during teardown) still receive 204 and the
        // local session is cleared. When the token IS provided it is revoked
        // server-side immediately, preventing replay for the remaining 30-day
        // window.
        body: z.object({ refreshToken: z.string().min(10) }).nullish(),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await authService.logout(req.body?.refreshToken);
      reply.code(204);
      return null;
    },
  );

  r.get(
    "/me",
    {
      preHandler: requireAuth(),
      schema: {
        tags: ["auth"],
        summary: "Current authenticated principal",
        security: [{ bearerAuth: [] }],
        response: { 200: MeResponseSchema },
      },
    },
    async (req) => authService.getProfile(req.principal!.id),
  );

  // GET /profile — read-only alias for /me (used by mobile profile screen)
  r.get(
    "/profile",
    {
      preHandler: requireAuth(),
      schema: {
        tags: ["auth"],
        summary: "Get authenticated user's profile (alias for GET /me)",
        security: [{ bearerAuth: [] }],
        response: { 200: MeResponseSchema },
      },
    },
    async (req) => authService.getProfile(req.principal!.id),
  );

  // ── Password reset flow ─────────────────────────────────────────────────

  r.post(
    "/forgot-password",
    {
      config: pwResetRateLimit,
      bodyLimit: 1 * 1024 * 1024,
      schema: {
        tags: ["auth"],
        summary: "Request a password reset email",
        description:
          "Always returns 202 regardless of whether the email exists — prevents email enumeration.",
        body: ForgotPasswordBodySchema,
        response: {
          202: z.object({ message: z.string() }),
        },
      },
    },
    async (req, reply) => {
      // Fire-and-forget: DB + email work happens after the 202 response is
      // sent so the caller cannot use timing side-channels to enumerate emails.
      authService.forgotPassword(req.body).catch((err: unknown) => {
        // Log internally so operators can detect SMTP/DB failures, but never
        // surface the error to the caller (timing-safe enumeration prevention).
        req.log.error({ err }, "[auth] forgotPassword background task failed — reset email may not have been sent");
      });
      reply.code(202);
      return { message: "If that email is registered, you will receive a reset link shortly." };
    },
  );

  r.post(
    "/reset-password",
    {
      config: pwResetRateLimit,
      bodyLimit: 1 * 1024 * 1024,
      schema: {
        tags: ["auth"],
        summary: "Complete a password reset using the token from the email link",
        body: ResetPasswordBodySchema,
        response: {
          200: z.object({ message: z.string() }),
        },
      },
    },
    async (req) => {
      await authService.resetPassword(req.body);
      return { message: "Password updated successfully. Please log in with your new password." };
    },
  );

  // ── Authenticated profile management ────────────────────────────────────

  r.patch(
    "/password",
    {
      preHandler: requireAuth(),
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["auth"],
        summary: "Change authenticated user's password",
        security: [{ bearerAuth: [] }],
        body: z.object({
          currentPassword: z.string().min(1),
          newPassword: z.string().min(8).max(128),
          // Required when the account has MFA enabled. Prevents a hijacked
          // session from silently changing the password and locking the
          // legitimate owner out without needing their second factor.
          totpCode: z.string().regex(/^\d{6}$/).optional(),
        }),
        response: { 200: z.object({ message: z.string() }), 429: z.object({ error: z.string() }) },
      },
    },
    async (req) => {
      await authService.changePassword(req.principal!.id, req.body);
      // Invalidate the in-process sessionsValidAfter cache so the next request
      // from any existing session is immediately rejected (no stale 30 s window).
      invalidateSessionsValidAfterCache(req.principal!.id);
      return { message: "Password updated successfully" };
    },
  );

  r.patch(
    "/profile",
    {
      preHandler: requireAuth(),
      schema: {
        tags: ["auth"],
        summary: "Update authenticated user's profile",
        security: [{ bearerAuth: [] }],
        body: z.object({
          displayName: z.string().min(1).max(80).optional(),
        }),
        response: { 200: MeResponseSchema },
      },
    },
    async (req) => authService.updateProfile(req.principal!.id, req.body),
  );

  // ── Account deletion (App Store / Play Store mandatory) ────────────────
  // Requires re-entering the current password. Cascade FKs in the schema
  // clean up refresh tokens, favorites, history, device-link codes, and
  // password-reset tokens automatically.
  r.delete(
    "/account",
    {
      preHandler: requireAuth(),
      config: authRateLimit,
      schema: {
        tags: ["auth"],
        summary: "Permanently delete the authenticated user's account",
        security: [{ bearerAuth: [] }],
        body: z.object({ currentPassword: z.string().min(1) }),
        response: { 200: z.object({ message: z.string() }) },
      },
    },
    async (req) => {
      await authService.deleteAccount(req.principal!.id, req.body);
      return { message: "Account deleted" };
    },
  );

  // ── Admin seed endpoint ──────────────────────────────────────────────────
  // Creates the first admin account when none exist. Protected by the
  // ADMIN_API_TOKEN (Bearer) so it can only be called from tooling/CI.
  //
  // force=true: deletes ALL existing elevated accounts (admin, system,
  // editor, moderator) and their refresh tokens first, then creates
  // the requested account. Use when resetting production credentials.
  // force=false (default): no-op if any elevated account already exists.

  r.post(
    "/seed",
    {
      schema: {
        tags: ["auth"],
        summary: "Seed an initial admin account (requires ADMIN_API_TOKEN). Use force=true to wipe and re-seed.",
        security: [{ bearerAuth: [] }],
        body: z.object({
          email: z.string().email(),
          password: z.string().min(8),
          displayName: z.string().min(1).max(80).optional(),
          force: z.boolean().optional().default(false),
        }),
        response: {
          200: z.object({
            created: z.boolean(),
            message: z.string(),
            email: z.string(),
            wiped: z.number().optional(),
          }),
        },
      },
    },
    async (req, _reply) => {
      // Defense-in-depth: even with a valid ADMIN_API_TOKEN, refuse to mint
      // admin accounts in production. Production seeding must go through the
      // SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD env-based path which is gated
      // by a deploy-time secret rotation, not a long-lived token that could
      // leak via logs or backups. (P0 — audit finding F-seed)
      if (env.NODE_ENV === "production") {
        throw new UnauthorizedError(
          "POST /auth/seed is disabled in production — use SEED_ADMIN_EMAIL/PASSWORD env vars",
        );
      }
      // Only the static ADMIN_API_TOKEN may call this endpoint.
      // Use timing-safe comparison to prevent timing-oracle attacks on the token.
      const authHeader = req.headers.authorization ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      const expected = env.ADMIN_API_TOKEN ?? "";
      const isValid = expected.length > 0
        && token.length === expected.length
        && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
      if (!isValid) {
        throw new UnauthorizedError("Invalid or missing ADMIN_API_TOKEN");
      }

      const usersTable = schema.usersTable;
      const refreshTokensTable = schema.refreshTokensTable;

      // Hash password outside the transaction (CPU-bound, not DB-bound).
      const email = req.body.email.toLowerCase();
      const passwordHash = await hashPassword(req.body.password);
      const displayName = req.body.displayName ?? email.split("@")[0] ?? "Admin";

      // Wrap the entire read-check / wipe / insert sequence in a single
      // transaction so a mid-flight crash cannot leave the DB in a partially
      // wiped state (elevated accounts deleted but no new admin created).
      const { created, wiped } = await db.transaction(async (tx) => {
        if (req.body.force) {
          const elevated = await tx
            .select({ id: usersTable.id })
            .from(usersTable)
            .where(ne(usersTable.role, "user"));

          if (elevated.length > 0) {
            const ids = elevated.map((u) => u.id);
            // Revoke all refresh tokens for these accounts.
            await tx
              .delete(refreshTokensTable)
              .where(inArray(refreshTokensTable.userId, ids));
            // Delete the accounts.
            await tx
              .delete(usersTable)
              .where(inArray(usersTable.id, ids));
          }

          await tx.insert(usersTable).values({
            id: nanoid(),
            email,
            passwordHash,
            displayName,
            role: "admin",
          });

          return { created: true, wiped: elevated.length };
        } else {
          const existing = await tx
            .select({ id: usersTable.id })
            .from(usersTable)
            .where(ne(usersTable.role, "user"))
            .limit(1);

          if (existing.length > 0) {
            return { created: false, wiped: 0 };
          }

          await tx.insert(usersTable).values({
            id: nanoid(),
            email,
            passwordHash,
            displayName,
            role: "admin",
          });

          return { created: true, wiped: 0 };
        }
      });

      if (!created) {
        return {
          created: false,
          message: "Admin account already exists — pass force=true to wipe and re-seed",
          email,
        };
      }

      const msg = wiped > 0
        ? `Wiped ${wiped} existing account(s) and created admin`
        : "Admin account created successfully";

      return { created: true, message: msg, email, wiped };
    },
  );

  // ── Device-Link (TV pairing) ───────────────────────────────────────────────
  // Flow: TV calls /create → displays code → user /claim on mobile → TV polls /exchange
  const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I O 0 1
  function generateCode(): string {
    const bytes = randomBytes(8);
    return Array.from({ length: 8 }, (_, i) => CODE_CHARS[bytes[i] % CODE_CHARS.length]).join("");
  }
  function sha256hex(s: string): string {
    return createHash("sha256").update(s).digest("hex");
  }

  r.post(
    "/device-link/create",
    {
      // Strict rate limit: each call inserts a row into device_link_codes.
      // Without this, a malicious client can flood the table to cause OOM
      // or exhaust connection pool bandwidth on the cleanup sweep.
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["auth"],
        summary: "Create a device-link pairing code (TV side)",
        body: z.object({ deviceLabel: z.string().max(80).optional() }),
        response: {
          200: z.object({ code: z.string(), expiresIn: z.number(), expiresAt: z.string() }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req) => {
      const code = generateCode();
      const expiresAt = new Date(Date.now() + CODE_TTL_MS);
      await db.insert(schema.deviceLinkCodesTable).values({
        code,
        expiresAt,
        deviceLabel: req.body.deviceLabel ?? "Smart TV",
        ip: req.ip ?? null,
      });
      return { code, expiresIn: CODE_TTL_MS / 1000, expiresAt: expiresAt.toISOString() };
    },
  );

  r.post(
    "/device-link/exchange",
    {
      schema: {
        tags: ["auth"],
        summary: "TV polls to exchange a claimed code for tokens",
        body: z.object({ code: z.string().min(1).max(32) }),
      },
    },
    async (req, reply) => {
      const code = req.body.code.toUpperCase().replace(/[\s-]+/g, "");
      const [row] = await db
        .select()
        .from(schema.deviceLinkCodesTable)
        .where(eq(schema.deviceLinkCodesTable.code, code))
        .limit(1);

      if (!row || row.consumedAt || new Date() > row.expiresAt) {
        reply.status(410);
        return { error: "Code not found, consumed, or expired" };
      }

      if (!row.userId || !row.claimedAt) {
        reply.status(202);
        return { status: "pending" };
      }

      const [user] = await db
        .select()
        .from(schema.usersTable)
        .where(eq(schema.usersTable.id, row.userId))
        .limit(1);

      if (!user) {
        reply.status(410);
        return { error: "Linked user not found" };
      }

      // Sign tokens outside the transaction — crypto ops should not hold a
      // DB connection open unnecessarily.
      const jti = nanoid(32);
      const accessToken = await signAccessToken({ sub: user.id, email: user.email, role: user.role as Role });
      const refreshToken = await signRefreshToken({ sub: user.id, jti });
      const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);

      // Atomically insert the refresh token and mark the code as consumed.
      // Without a transaction a concurrent /exchange call could read the same
      // unconsummed code and issue a second set of tokens for the same pairing.
      try {
        await db.transaction(async (tx) => {
          // Re-read inside the transaction to ensure the code hasn't been
          // consumed by a concurrent request between our check above and now.
          const [check] = await tx
            .select({ consumedAt: schema.deviceLinkCodesTable.consumedAt })
            .from(schema.deviceLinkCodesTable)
            .where(eq(schema.deviceLinkCodesTable.code, code))
            .limit(1);
          if (check?.consumedAt) throw Object.assign(new Error("already_consumed"), { _deviceLink: true });

          await tx.insert(schema.refreshTokensTable).values({
            id: jti,
            userId: user.id,
            tokenHash: sha256hex(refreshToken),
            expiresAt,
            ip: req.ip ?? null,
            userAgent: req.headers["user-agent"] ?? null,
          });
          await tx
            .update(schema.deviceLinkCodesTable)
            .set({ consumedAt: new Date() })
            .where(eq(schema.deviceLinkCodesTable.code, code));
        });
      } catch (err: unknown) {
        if (err instanceof Error && (err as NodeJS.ErrnoException & { _deviceLink?: boolean })._deviceLink) {
          reply.status(410);
          return { error: "Code already consumed by a concurrent request" };
        }
        throw err;
      }

      return { accessToken, refreshToken, user: { id: user.id, email: user.email, displayName: user.displayName } };
    },
  );

  r.post(
    "/device-link/claim",
    {
      preHandler: requireAuth("user"),
      schema: {
        tags: ["auth"],
        summary: "Authenticated user claims a device-link code (mobile/web side)",
        body: z.object({ code: z.string().min(1).max(32) }),
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const code = req.body.code.toUpperCase().replace(/[\s-]+/g, "");
      const [row] = await db
        .select()
        .from(schema.deviceLinkCodesTable)
        .where(
          and(
            eq(schema.deviceLinkCodesTable.code, code),
            isNull(schema.deviceLinkCodesTable.consumedAt),
            gt(schema.deviceLinkCodesTable.expiresAt, new Date()),
          ),
        )
        .limit(1);

      if (!row) {
        reply.status(410);
        return { error: "Code not found, already used, or expired" };
      }

      if (row.claimedAt) {
        reply.status(409);
        return { error: "Code has already been claimed" };
      }

      // Use a conditional UPDATE (WHERE claimed_at IS NULL) instead of a
      // plain update to prevent a TOCTOU race: two concurrent /claim requests
      // can both pass the `row.claimedAt` check above, then both attempt to
      // set the claim. The first wins; the second's UPDATE matches 0 rows and
      // we return 409 — exactly as if the race never happened.
      const updated = await db
        .update(schema.deviceLinkCodesTable)
        .set({ userId: req.principal!.id, claimedAt: new Date() })
        .where(
          and(
            eq(schema.deviceLinkCodesTable.code, code),
            isNull(schema.deviceLinkCodesTable.claimedAt),
          ),
        )
        .returning({ id: schema.deviceLinkCodesTable.code });

      if (updated.length === 0) {
        reply.status(409);
        return { error: "Code has already been claimed" };
      }

      return { ok: true };
    },
  );
}
