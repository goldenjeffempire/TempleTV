import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import type { Role } from "../shared/types.js";
/**
 * Call this after a password change or logout-everywhere so the next request
 * from any session re-fetches sessions_valid_after rather than serving a
 * stale cached value.
 */
export declare function invalidateSessionsValidAfterCache(userId: string): void;
/**
 * Constant-time string comparison. Length difference is leaked
 * (unavoidable without padding) but byte content is not.
 */
export declare function safeStringEqual(a: string, b: string): boolean;
declare module "fastify" {
    interface FastifyRequest {
        principal?: {
            id: string;
            email: string;
            role: Role;
        };
    }
}
/**
 * Attach the principal to req if a valid credential is present (Bearer
 * header or admin_session cookie). Does NOT reject anonymous requests —
 * use requireAuth() for that.
 */
export declare function attachPrincipal(): preHandlerHookHandler;
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
export declare function requireAuth(minRole?: Role): preHandlerHookHandler;
/**
 * Exported helper: extract and validate the admin_session cookie token
 * using the same logic as requireAuth(). Returns the token string if
 * valid, or null if the cookie is absent or fails validation.
 *
 * Used by SSE endpoints that must perform inline auth because they cannot
 * use requireAuth() as a preHandler (they stream the response directly).
 */
export declare function extractAndValidateCookieToken(req: FastifyRequest): Promise<{
    token: string;
} | null>;
