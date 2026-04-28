import { createHash } from "node:crypto";
import { eq, and, gt, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../../infrastructure/db.js";
import { hashPassword, verifyPassword } from "./password.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "./jwt.js";
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from "../../shared/errors.js";
import { env } from "../../config/env.js";
import type { Role } from "../../shared/types.js";
import type { AuthTokens, LoginBody, RegisterBody } from "./auth.schemas.js";

const usersTable = schema.usersTable;
const refreshTokensTable = schema.refreshTokensTable;

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

async function issueTokens(user: {
  id: string;
  email: string;
  role: Role;
  displayName: string;
}): Promise<IssuedTokens> {
  const jti = nanoid(32);
  const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  const refreshToken = signRefreshToken({ sub: user.id, jti });

  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);
  await db.insert(refreshTokensTable).values({
    id: jti,
    userId: user.id,
    tokenHash: sha256(refreshToken),
    expiresAt,
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

    const { tokens } = await issueTokens({
      id: user.id,
      email: user.email,
      role: coerceRole(user.role),
      displayName: user.displayName,
    });
    return tokens;
  },

  async login(body: LoginBody): Promise<AuthTokens> {
    const email = body.email.toLowerCase();
    const rows = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    const user = rows[0];
    if (!user) throw new UnauthorizedError("Invalid credentials");
    const ok = await verifyPassword(body.password, user.passwordHash);
    if (!ok) throw new UnauthorizedError("Invalid credentials");

    const { tokens } = await issueTokens({
      id: user.id,
      email: user.email,
      role: coerceRole(user.role),
      displayName: user.displayName,
    });
    return tokens;
  },

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const decoded = verifyRefreshToken(refreshToken);
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

    const { tokens } = await issueTokens({
      id: user.id,
      email: user.email,
      role: coerceRole(user.role),
      displayName: user.displayName,
    });
    return tokens;
  },

  async logout(refreshToken: string): Promise<void> {
    try {
      const decoded = verifyRefreshToken(refreshToken);
      await db
        .update(refreshTokensTable)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokensTable.id, decoded.jti));
    } catch {
      /* idempotent */
    }
  },

  async getProfile(userId: string) {
    if (userId.startsWith("system:")) {
      return {
        id: userId,
        email: "system@temple.tv",
        role: "system" as Role,
        displayName: "System",
        createdAt: new Date(0).toISOString(),
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
    };
  },
};
