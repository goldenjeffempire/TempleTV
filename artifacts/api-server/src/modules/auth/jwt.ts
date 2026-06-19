import { SignJWT, jwtVerify } from "jose";
import { env } from "../../config/env.js";
import type { Role } from "../../shared/types.js";
import { UnauthorizedError } from "../../shared/errors.js";

// F28: migrated from jsonwebtoken (CommonJS-only) to jose (native ESM, Web Crypto API).
// Only HS256 is supported — JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are plain
// UTF-8 strings. RS256 requires PEM key-import; configure JWT_ALGORITHM=HS256
// (the default) unless you have set up asymmetric keys separately.
const ALG = env.JWT_ALGORITHM;
if (ALG !== "HS256") {
  throw new Error(
    `JWT_ALGORITHM="${ALG}" is not supported after the jose migration (F28). ` +
      `Only HS256 is supported. Set JWT_ALGORITHM=HS256 in your environment.`,
  );
}

// Pre-encode secrets as Uint8Array once at module load — TextEncoder is part of
// the Web Crypto baseline available in all Node.js ≥ 18 and browser runtimes.
const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const refreshSecret = new TextEncoder().encode(env.JWT_REFRESH_SECRET);

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: Role;
  type: "access";
  /** Standard JWT "issued at" claim — seconds since epoch. Present on all
   *  tokens we issue (SignJWT sets it automatically) but typed optional so
   *  the interface stays forward-compatible if a token omits it. */
  iat?: number;
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  type: "refresh";
  /** Standard JWT "issued at" claim — seconds since epoch. Set automatically
   *  by SignJWT. Present on all tokens we issue; optional so the interface
   *  stays forward-compatible if a legacy token omits it. */
  iat?: number;
}

export async function signAccessToken(p: Omit<AccessTokenPayload, "type">): Promise<string> {
  return new SignJWT({ ...p, type: "access" } satisfies AccessTokenPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + env.JWT_ACCESS_TTL_SECONDS)
    .sign(accessSecret);
}

export async function signRefreshToken(p: Omit<RefreshTokenPayload, "type">): Promise<string> {
  return new SignJWT({ ...p, type: "refresh" } satisfies RefreshTokenPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + env.JWT_REFRESH_TTL_SECONDS)
    .sign(refreshSecret);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  try {
    const { payload } = await jwtVerify<AccessTokenPayload>(token, accessSecret, {
      algorithms: ["HS256"],
      // 30-second tolerance absorbs minor NTP drift between the token issuer
      // and validator when running across multiple replicas or after a clock
      // adjustment. Tokens are still bounded by JWT_ACCESS_TTL_SECONDS.
      clockTolerance: 30,
    });
    if (payload.type !== "access") throw new UnauthorizedError("Wrong token type");
    return payload;
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError("Invalid or expired access token");
  }
}

export async function verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
  try {
    const { payload } = await jwtVerify<RefreshTokenPayload>(token, refreshSecret, {
      algorithms: ["HS256"],
      clockTolerance: 30,
    });
    if (payload.type !== "refresh") throw new UnauthorizedError("Wrong token type");
    return payload;
  } catch {
    throw new UnauthorizedError("Invalid or expired refresh token");
  }
}
