import type { preHandlerHookHandler } from "fastify";
import type { Role } from "../shared/types.js";
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
 * Attach the principal to req if a valid bearer token is present.
 * Does NOT reject anonymous requests — use requireAuth() for that.
 */
export declare function attachPrincipal(): preHandlerHookHandler;
/**
 * Reject unauthenticated requests. Optionally enforce a minimum role.
 *
 * The legacy ADMIN_API_TOKEN bearer is also accepted as a `system`
 * principal to keep operator scripts working during the migration.
 */
export declare function requireAuth(minRole?: Role): preHandlerHookHandler;
