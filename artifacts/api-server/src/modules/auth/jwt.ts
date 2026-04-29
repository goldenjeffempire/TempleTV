import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import type { Role } from "../../shared/types.js";
import { UnauthorizedError } from "../../shared/errors.js";

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: Role;
  type: "access";
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  type: "refresh";
}

export function signAccessToken(p: Omit<AccessTokenPayload, "type">): string {
  return jwt.sign({ ...p, type: "access" } satisfies AccessTokenPayload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL_SECONDS,
    algorithm: "HS256",
  });
}

export function signRefreshToken(p: Omit<RefreshTokenPayload, "type">): string {
  return jwt.sign({ ...p, type: "refresh" } satisfies RefreshTokenPayload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL_SECONDS,
    algorithm: "HS256",
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ["HS256"],
    }) as AccessTokenPayload;
    if (decoded.type !== "access") throw new UnauthorizedError("Wrong token type");
    return decoded;
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError("Invalid or expired access token");
  }
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET, {
      algorithms: ["HS256"],
    }) as RefreshTokenPayload;
    if (decoded.type !== "refresh") throw new UnauthorizedError("Wrong token type");
    return decoded;
  } catch {
    throw new UnauthorizedError("Invalid or expired refresh token");
  }
}
