import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { createHash, randomBytes, randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { db, usersTable, refreshTokensTable } from "@workspace/db";
import { and, eq, isNull, lt } from "drizzle-orm";
import type { PublicUser } from "@workspace/db";

declare global {
  namespace Express {
    interface Request {
      user?: PublicUser;
    }
  }
}

// ── TTLs ──────────────────────────────────────────────────────────────────
// Access tokens are short-lived; refresh tokens are long-lived but
// single-use and revocable (rotation on every refresh).
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET environment variable is not set");
  return secret;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid authorization header" });
      return;
    }

    const token = authHeader.slice(7);
    const payload = jwt.verify(token, getJwtSecret()) as { userId: string; typ?: string; iat?: number };
    if (payload.typ && payload.typ !== "access") {
      res.status(401).json({ error: "Invalid token type" });
      return;
    }

    const [row] = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        displayName: usersTable.displayName,
        avatarUrl: usersTable.avatarUrl,
        emailVerified: usersTable.emailVerified,
        sessionsValidAfter: usersTable.sessionsValidAfter,
        createdAt: usersTable.createdAt,
        updatedAt: usersTable.updatedAt,
      })
      .from(usersTable)
      .where(eq(usersTable.id, payload.userId))
      .limit(1);

    if (!row) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    // Reject tokens minted before the most recent global session reset
    // (password change, logout-everywhere). `iat` is in seconds.
    const tokenIssuedAtMs = (payload.iat ?? 0) * 1000;
    if (tokenIssuedAtMs < row.sessionsValidAfter.getTime()) {
      res.status(401).json({ error: "Session has been invalidated" });
      return;
    }

    const { sessionsValidAfter: _omit, ...publicUser } = row;
    req.user = publicUser as PublicUser;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

/** Sign a short-lived access token (JWT). */
export function signAccessToken(userId: string): string {
  return jwt.sign({ userId, typ: "access" }, getJwtSecret(), {
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  });
}

/** Back-compat alias used by existing callers. */
export function signToken(userId: string): string {
  return signAccessToken(userId);
}

function hashRefreshToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function getClientUserAgent(req: Request): string | null {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" && ua.length <= 512 ? ua : null;
}

function getClientIp(req: Request): string | null {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0]!.trim().slice(0, 64);
  return (req.socket.remoteAddress ?? null)?.slice(0, 64) ?? null;
}

/**
 * Mint and persist a new refresh token for `userId`. The raw secret is
 * returned to the caller (sent to the client); only its SHA-256 is stored.
 */
export async function issueRefreshToken(
  userId: string,
  req: Request,
  replacedById?: string,
): Promise<{ id: string; raw: string; expiresAt: Date }> {
  const id = randomUUID();
  const raw = `${id}.${randomBytes(48).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
  await db.insert(refreshTokensTable).values({
    id,
    userId,
    tokenHash: hashRefreshToken(raw),
    expiresAt,
    userAgent: getClientUserAgent(req),
    ip: getClientIp(req),
    replacedById: replacedById ?? null,
  });
  return { id, raw, expiresAt };
}

/** Issue an access + refresh pair for `userId` and best-effort cleanup of expired rows. */
export async function issueAuthTokens(
  userId: string,
  req: Request,
): Promise<{ accessToken: string; refreshToken: string; accessTokenExpiresInSecs: number }> {
  const refresh = await issueRefreshToken(userId, req);
  // Opportunistic cleanup: drop expired tokens for this user.
  db.delete(refreshTokensTable)
    .where(
      and(eq(refreshTokensTable.userId, userId), lt(refreshTokensTable.expiresAt, new Date())),
    )
    .catch(() => {});
  return {
    accessToken: signAccessToken(userId),
    refreshToken: refresh.raw,
    accessTokenExpiresInSecs: ACCESS_TOKEN_TTL_SECONDS,
  };
}

/**
 * Validate a presented refresh token, rotate it (mark used + issue new pair),
 * and return the new credentials. Throws on invalid/expired/revoked/reused.
 *
 * The entire rotation runs inside a single DB transaction with a row-level
 * lock (`SELECT … FOR UPDATE`) on the presented refresh-token row, plus a
 * conditional revoke (`WHERE revoked_at IS NULL`) whose row count is verified.
 * Combined, these guarantee single-use: two concurrent refresh requests with
 * the same token cannot both succeed.
 *
 * If a previously-revoked token is re-presented, all sibling tokens for that
 * user are revoked as a precaution against token theft.
 */
export async function rotateRefreshToken(
  presentedRaw: string,
  req: Request,
): Promise<{
  userId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresInSecs: number;
}> {
  const tokenHash = hashRefreshToken(presentedRaw);
  const userAgent = getClientUserAgent(req);
  const ip = getClientIp(req);

  return await db.transaction(async (tx) => {
    // Row-lock the presented token to serialize concurrent rotations.
    const [row] = await tx
      .select()
      .from(refreshTokensTable)
      .where(eq(refreshTokensTable.tokenHash, tokenHash))
      .for("update")
      .limit(1);

    if (!row) {
      throw new Error("invalid_refresh_token");
    }

    if (row.revokedAt) {
      // Reuse detection — token was already used or revoked. Revoke every
      // active token for the user as a token-theft response.
      await tx
        .update(refreshTokensTable)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokensTable.userId, row.userId), isNull(refreshTokensTable.revokedAt)));
      throw new Error("refresh_token_reused");
    }

    if (row.expiresAt.getTime() <= Date.now()) {
      throw new Error("expired_refresh_token");
    }

    // Conditional revoke: only succeeds if still un-revoked. RETURNING lets
    // us verify exactly one row was claimed by this transaction.
    const claimed = await tx
      .update(refreshTokensTable)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokensTable.id, row.id), isNull(refreshTokensTable.revokedAt)))
      .returning({ id: refreshTokensTable.id });

    if (claimed.length !== 1) {
      // Lost the race against another transaction. Treat as reuse.
      throw new Error("refresh_token_reused");
    }

    // Mint the replacement inside the same transaction.
    const newId = randomUUID();
    const newRaw = `${newId}.${randomBytes(48).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
    await tx.insert(refreshTokensTable).values({
      id: newId,
      userId: row.userId,
      tokenHash: hashRefreshToken(newRaw),
      expiresAt,
      userAgent,
      ip,
      replacedById: null,
    });

    // Link the old row to its replacement for forensic traceability.
    await tx
      .update(refreshTokensTable)
      .set({ replacedById: newId })
      .where(eq(refreshTokensTable.id, row.id));

    return {
      userId: row.userId,
      accessToken: signAccessToken(row.userId),
      refreshToken: newRaw,
      accessTokenExpiresInSecs: ACCESS_TOKEN_TTL_SECONDS,
    };
  });
}

/**
 * Bump the user's `sessions_valid_after` to "now". All access tokens issued
 * before this moment will be rejected by `requireAuth` immediately, even
 * before their natural JWT expiry. Used on password change + logout-everywhere.
 */
export async function bumpSessionEpoch(userId: string): Promise<void> {
  await db
    .update(usersTable)
    .set({ sessionsValidAfter: sql`NOW()`, updatedAt: sql`NOW()` })
    .where(eq(usersTable.id, userId));
}

/** Revoke a single refresh token (logout for one device). Idempotent. */
export async function revokeRefreshToken(presentedRaw: string): Promise<void> {
  const tokenHash = hashRefreshToken(presentedRaw);
  await db
    .update(refreshTokensTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokensTable.tokenHash, tokenHash), isNull(refreshTokensTable.revokedAt)));
}

/** Revoke every active refresh token for a user (logout everywhere). */
export async function revokeAllRefreshTokensForUser(userId: string): Promise<void> {
  await db
    .update(refreshTokensTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokensTable.userId, userId), isNull(refreshTokensTable.revokedAt)));
}
