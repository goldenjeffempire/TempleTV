import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { verifyAccessToken } from "../modules/auth/jwt.js";
import { requireRole } from "../modules/auth/rbac.js";
import type { Role } from "../shared/types.js";
import { env } from "../config/env.js";
import { UnauthorizedError } from "../shared/errors.js";

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

/**
 * Attach the principal to req if a valid bearer token is present.
 * Does NOT reject anonymous requests — use requireAuth() for that.
 */
export function attachPrincipal(): preHandlerHookHandler {
  return async (req, _reply) => {
    const token = extractBearer(req);
    if (!token) return;
    try {
      const decoded = verifyAccessToken(token);
      req.principal = { id: decoded.sub, email: decoded.email, role: decoded.role };
    } catch {
      /* swallow — anonymous fallthrough; routes that need auth call requireAuth() */
    }
  };
}

/**
 * Reject unauthenticated requests. Optionally enforce a minimum role.
 *
 * The legacy ADMIN_API_TOKEN bearer is also accepted as a `system`
 * principal to keep operator scripts working during the migration.
 */
export function requireAuth(minRole: Role = "user"): preHandlerHookHandler {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const token = extractBearer(req);
    if (!token) throw new UnauthorizedError();

    if (env.ADMIN_API_TOKEN && token === env.ADMIN_API_TOKEN) {
      req.principal = { id: "system:admin-token", email: "system@temple.tv", role: "system" };
    } else {
      const decoded = verifyAccessToken(token);
      req.principal = { id: decoded.sub, email: decoded.email, role: decoded.role };
    }
    requireRole(req.principal.role, minRole);
  };
}
