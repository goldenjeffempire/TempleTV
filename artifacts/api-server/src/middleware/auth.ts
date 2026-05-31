import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { eq } from "drizzle-orm";
import { verifyAccessToken } from "../modules/auth/jwt.js";
import { requireRole } from "../modules/auth/rbac.js";
import type { Role } from "../shared/types.js";
import { env } from "../config/env.js";
import { UnauthorizedError, ForbiddenError } from "../shared/errors.js";
import { db, schema } from "../infrastructure/db.js";
import { logger } from "../infrastructure/logger.js";

/**
 * Short-lived in-process cache for users.sessions_valid_after.
 * Keyed by userId → { validAfter: Date | null, cachedAt: ms }.
 * TTL: 30 s — short enough to detect password-change / logout-all within
 * a single request cadence, long enough to keep DB round-trips minimal.
 */
const _svaCache = new Map<string, { validAfter: Date | null; cachedAt: number }>();
const _SVA_TTL_MS = 30_000;
// Periodic GC: entries expire after _SVA_TTL_MS but are only evicted from the
// Map on the next read for that user. On a 24/7 server with many unique users,
// the Map would otherwise grow to O(distinct authenticated users) indefinitely.
// A 5-minute sweep keeps memory tightly bounded with negligible CPU cost.
setInterval(() => {
  const cutoff = Date.now() - _SVA_TTL_MS;
  for (const [uid, entry] of _svaCache) {
    if (entry.cachedAt < cutoff) _svaCache.delete(uid);
  }
}, 5 * 60_000).unref?.();

/**
 * Return the sessions_valid_after timestamp for a user, using the in-process
 * cache. Falls back to null (= allow all tokens) on any DB error so that a
 * transient PG failure never causes an auth lockout.
 */
async function getCachedSessionsValidAfter(userId: string): Promise<Date | null> {
  const cached = _svaCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < _SVA_TTL_MS) return cached.validAfter;
  try {
    const [row] = await db
      .select({ sessionsValidAfter: schema.usersTable.sessionsValidAfter })
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, userId))
      .limit(1);
    const validAfter = row?.sessionsValidAfter ?? null;
    _svaCache.set(userId, { validAfter, cachedAt: Date.now() });
    return validAfter;
  } catch {
    // DB is transiently unavailable. Prefer the stale cached entry over
    // failing open (null) — stale data still enforces the last-known
    // revocation fence and is always better than a wide-open null return.
    // Only fall back to null on a cold start (no prior cache entry), where
    // failing open is the only option that avoids locking out all users
    // during a transient PG blip at startup.
    if (cached) return cached.validAfter;
    // No stale cache entry — cold-start DB failure. Fail open (allow all
    // tokens) to avoid locking every user out during a transient PG blip
    // at startup. Log a WARN so this is visible in production monitoring.
    logger.warn(
      { userId },
      "[auth] sessions_valid_after: DB unavailable and no cache entry — failing open until DB recovers",
    );
    return null;
  }
}

/**
 * Call this after a password change or logout-everywhere so the next request
 * from any session re-fetches sessions_valid_after rather than serving a
 * stale cached value.
 */
export function invalidateSessionsValidAfterCache(userId: string): void {
  _svaCache.delete(userId);
}

/**
 * Parse ADMIN_API_TOKEN_IP_ALLOWLIST into a Set of trimmed IP strings.
 * Evaluated once at module load so there is no per-request parsing cost.
 */
const ADMIN_TOKEN_IP_ALLOWLIST: Set<string> | null = (() => {
  const raw = env.ADMIN_API_TOKEN_IP_ALLOWLIST;
  if (!raw) return null; // empty = allow any IP
  const ips = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return ips.length > 0 ? new Set(ips) : null;
})();

/**
 * Check whether ADMIN_API_TOKEN matches the given bearer string. If it matches
 * but the request IP is not in ADMIN_API_TOKEN_IP_ALLOWLIST, throws 403.
 * Returns the granted principal if valid, or null if the token does not match.
 */
function resolveAdminApiToken(
  token: string,
  req: FastifyRequest,
): { id: string; email: string; role: Role } | null {
  if (!env.ADMIN_API_TOKEN) return null;
  if (!safeStringEqual(token, env.ADMIN_API_TOKEN)) return null;

  // F11: IP allowlist check — reject before logging the successful match to
  // avoid a log entry that implies the request was allowed.
  if (ADMIN_TOKEN_IP_ALLOWLIST !== null && !ADMIN_TOKEN_IP_ALLOWLIST.has(req.ip)) {
    req.log.warn(
      { method: req.method, url: req.url, ip: req.ip },
      "[auth] ADMIN_API_TOKEN rejected — IP not in ADMIN_API_TOKEN_IP_ALLOWLIST",
    );
    throw new ForbiddenError("ADMIN_API_TOKEN not allowed from this IP address");
  }

  // F01: role is configurable (default: editor, not system) so a leaked static
  // token cannot escalate to system-level RBAC unconditionally. Set
  // ADMIN_API_TOKEN_ROLE=system only for internal machine-to-machine scripts.
  const role = env.ADMIN_API_TOKEN_ROLE as Role;
  req.log.warn(
    { method: req.method, url: req.url, ip: req.ip, grantedRole: role },
    "[auth] ADMIN_API_TOKEN used — consider rotating to short-lived JWT session",
  );
  return { id: "system:admin-token", email: "system@temple.tv", role };
}

/**
 * Constant-time string comparison. Length difference is leaked
 * (unavoidable without padding) but byte content is not.
 */
export function safeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: {
      id: string;
      email: string;
      role: Role;
    };
  }
}

function extractBearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] ?? null;
}

function extractCookie(req: FastifyRequest): string | null {
  const cookie = (req.cookies as Record<string, string | undefined> | undefined)?.admin_session;
  if (typeof cookie === "string" && cookie.length > 0) return cookie;
  return null;
}

/**
 * Extract a credential token from the request.
 * Priority order:
 *   1. `Authorization: Bearer <token>` header — used by external tools,
 *      scripts, and the legacy admin SPA localStorage flow.
 *   2. `admin_session` HttpOnly cookie — set by `POST /admin/session` after
 *      the operator pastes their admin key into the key dialog. The cookie
 *      is never readable by JavaScript on the client, making it immune to
 *      XSS exfiltration (SEC-02).
 */
function extractToken(req: FastifyRequest): { token: string; source: "bearer" | "cookie" } | null {
  const bearer = extractBearer(req);
  if (bearer) return { token: bearer, source: "bearer" };
  const cookie = extractCookie(req);
  if (cookie) return { token: cookie, source: "cookie" };
  return null;
}

/**
 * Attach the principal to req if a valid credential is present (Bearer
 * header or admin_session cookie). Does NOT reject anonymous requests —
 * use requireAuth() for that.
 */
export function attachPrincipal(): preHandlerHookHandler {
  return async (req, _reply) => {
    const extracted = extractToken(req);
    if (!extracted) return;
    const { token } = extracted;
    try {
      const adminPrincipal = resolveAdminApiToken(token, req);
      if (adminPrincipal) {
        req.principal = adminPrincipal;
      } else {
        const decoded = await verifyAccessToken(token);
        req.principal = { id: decoded.sub, email: decoded.email, role: decoded.role };
      }
    } catch {
      /* swallow — anonymous fallthrough; routes that need auth call requireAuth() */
    }
  };
}

/**
 * Reject unauthenticated requests. Optionally enforce a minimum role.
 *
 * Accepts credentials via (in priority order):
 *   1. `Authorization: Bearer <token>` header
 *   2. `admin_session` HttpOnly cookie (set by POST /admin/session)
 *
 * The legacy ADMIN_API_TOKEN bearer is accepted as a principal with the role
 * configured by `ADMIN_API_TOKEN_ROLE` (default: `editor`) to keep operator
 * scripts working alongside the new cookie-based flow without granting
 * unconditional system-level access (F01).
 *
 * SEC-05 (CSRF): When the request is authenticated via the cookie path
 * only (no Authorization header), state-mutating methods (POST, PUT, PATCH,
 * DELETE) MUST carry the `X-Admin-CSRF: 1` header. A cross-site attacker's
 * browser will automatically send the admin_session cookie but cannot set
 * custom headers from a cross-origin request — the CORS preflight blocks
 * them — so the presence of this header proves same-origin JavaScript origin.
 * Bearer-authenticated calls are exempt because the Authorization header
 * already constitutes proof of same-origin initiation.
 */
export function requireAuth(minRole: Role = "user"): preHandlerHookHandler {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const extracted = extractToken(req);
    if (!extracted) throw new UnauthorizedError();

    const { token, source } = extracted;

    // ── CSRF enforcement for cookie-only sessions (SEC-05) ─────────────────
    if (source === "cookie") {
      const method = req.method.toUpperCase();
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        const csrfHeader = req.headers["x-admin-csrf"];
        if (csrfHeader !== "1") {
          req.log.warn(
            { method: req.method, url: req.url, ip: req.ip },
            "[auth] CSRF check failed — X-Admin-CSRF header missing on cookie-authenticated mutation",
          );
          throw new UnauthorizedError("CSRF check failed");
        }
      }
    }

    const adminPrincipal = resolveAdminApiToken(token, req);
    if (adminPrincipal) {
      req.principal = adminPrincipal;
    } else {
      const decoded = await verifyAccessToken(token);

      // SEC-REVOKE: check that the token was issued AFTER the user's global
      // session-invalidation timestamp (bumped on password change / logout-all).
      // `decoded.iat` is in seconds; sessionsValidAfter is a Date (milliseconds).
      if (decoded.iat !== undefined) {
        const validAfter = await getCachedSessionsValidAfter(decoded.sub);
        if (validAfter && decoded.iat * 1000 < validAfter.getTime()) {
          req.log.warn(
            { principalId: decoded.sub, tokenIatMs: decoded.iat * 1000, validAfterMs: validAfter.getTime() },
            "[auth] token predates sessionsValidAfter — rejecting (password changed or logout-all)",
          );
          throw new UnauthorizedError("Session expired — please sign in again");
        }
      }

      req.principal = { id: decoded.sub, email: decoded.email, role: decoded.role };
      req.log.info(
        {
          method: req.method,
          url: req.url,
          ip: req.ip,
          principalId: decoded.sub,
          role: decoded.role,
          authSource: source,
        },
        "[auth] admin access granted",
      );
    }
    requireRole(req.principal.role, minRole);
  };
}

/**
 * Exported helper: extract and validate the admin_session cookie token
 * using the same logic as requireAuth(). Returns the token string if
 * valid, or null if the cookie is absent or fails validation.
 *
 * Used by SSE endpoints that must perform inline auth because they cannot
 * use requireAuth() as a preHandler (they stream the response directly).
 */
export async function extractAndValidateCookieToken(
  req: FastifyRequest,
): Promise<{ token: string } | null> {
  const cookie = extractCookie(req);
  if (!cookie) return null;
  if (env.ADMIN_API_TOKEN && safeStringEqual(cookie, env.ADMIN_API_TOKEN)) {
    // IP check is not enforced here — this path is called by SSE inline-auth
    // which is read-only; the full check runs in requireAuth() for mutations.
    return { token: cookie };
  }
  try {
    const decoded = await verifyAccessToken(cookie);
    // Apply the same session-revocation check as requireAuth() so that a
    // password change or logout-all also stops SSE streams on the next
    // reconnect attempt. Read-only path — fail open on any DB error so a
    // transient PG blip never silently disconnects all event listeners.
    if (decoded.iat !== undefined) {
      const validAfter = await getCachedSessionsValidAfter(decoded.sub);
      if (validAfter && decoded.iat * 1000 < validAfter.getTime()) {
        req.log?.warn(
          { principalId: decoded.sub, tokenIatMs: decoded.iat * 1000, validAfterMs: validAfter.getTime() },
          "[auth] SSE inline-auth: token predates sessionsValidAfter — denying stream access",
        );
        return null;
      }
    }
    return { token: cookie };
  } catch {
    return null;
  }
}
