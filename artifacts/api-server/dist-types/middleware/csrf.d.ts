/**
 * CSRF protection for cookie-authenticated admin routes (SEC-05).
 *
 * Technique: "custom request header" double-proof
 * ──────────────────────────────────────────────
 * The browser's CORS preflight policy means cross-site requests cannot
 * set arbitrary headers. Requiring `X-Admin-CSRF: 1` on state-mutating
 * admin requests therefore proves the request originated from same-site
 * JavaScript — not a CSRF-forged form or cross-origin fetch.
 *
 * Combined with `SameSite=Strict` on the `admin_session` cookie (which
 * already prevents the cookie from being sent on cross-site requests),
 * this provides two independent layers of CSRF defence:
 *
 *   Layer 1 (SameSite=Strict): attacker's page cannot make the browser
 *     include the admin_session cookie at all.
 *   Layer 2 (custom header): even if Layer 1 is somehow bypassed (e.g.
 *     a same-site subdomain is compromised), the missing custom header
 *     causes a 403 before any business logic executes.
 *
 * Exemptions (applied in order):
 *   1. Safe HTTP methods (GET, HEAD, OPTIONS) — read-only, no side-effects.
 *   2. Requests with a valid `Authorization: Bearer` header — token auth
 *      is inherently CSRF-safe (attacker cannot read the token from storage).
 *   3. Requests without the `admin_session` cookie — unauthenticated
 *      requests fail `requireAuth()` already; no extra check needed.
 *
 * The `POST /admin/session` (login) and `DELETE /admin/session` (logout)
 * endpoints are naturally safe:
 *   - Login: no session cookie exists yet → exemption 3 applies.
 *   - Logout: SameSite=Strict prevents cookie delivery from attacker pages;
 *     the custom header check protects against same-site subdomain attacks.
 */
import type { FastifyRequest, FastifyReply } from "fastify";
export declare function adminCsrfHook(req: FastifyRequest, reply: FastifyReply): Promise<void>;
