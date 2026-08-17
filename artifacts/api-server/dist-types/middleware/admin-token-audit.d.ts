/**
 * Admin token usage audit middleware.
 *
 * Logs every request authenticated via ADMIN_API_TOKEN for security audit
 * trails. This helps detect token leaks or misuse if credentials appear in
 * logs, error reports, or monitoring tools.
 */
import type { preHandlerHookHandler } from 'fastify';
/**
 * Check if an ADMIN_API_TOKEN request is allowed from this IP.
 *
 * If ADMIN_API_TOKEN_IP_ALLOWLIST is configured, only IPs on the list
 * can authenticate using the static token.
 */
export declare function isAdminTokenIpAllowed(requestIp: string | undefined): boolean;
/**
 * Audit hook for ADMIN_API_TOKEN usage.
 * Logs every request using the static token with IP, method, URL, and timestamp.
 */
export declare function adminTokenAuditHook(): preHandlerHookHandler;
