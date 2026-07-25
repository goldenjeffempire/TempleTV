/**
 * Admin token usage audit middleware.
 * 
 * Logs every request authenticated via ADMIN_API_TOKEN for security audit
 * trails. This helps detect token leaks or misuse if credentials appear in
 * logs, error reports, or monitoring tools.
 */

import type { preHandlerHookHandler } from 'fastify';
import { logger } from '../infrastructure/logger.js';
import { env } from '../config/env.js';

/**
 * Check if an ADMIN_API_TOKEN request is allowed from this IP.
 * 
 * If ADMIN_API_TOKEN_IP_ALLOWLIST is configured, only IPs on the list
 * can authenticate using the static token.
 */
export function isAdminTokenIpAllowed(requestIp: string | undefined): boolean {
  const allowlist = env.ADMIN_API_TOKEN_IP_ALLOWLIST;
  if (!allowlist) return true; // No allowlist = all IPs allowed

  const allowed = allowlist.split(',').map((ip) => ip.trim()).filter(Boolean);
  return allowed.includes(requestIp ?? '');
}

/**
 * Audit hook for ADMIN_API_TOKEN usage.
 * Logs every request using the static token with IP, method, URL, and timestamp.
 */
export function adminTokenAuditHook(): preHandlerHookHandler {
  return async (req, _reply) => {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

    if (token && env.ADMIN_API_TOKEN && token === env.ADMIN_API_TOKEN) {
      logger.info(
        {
          event: 'admin_token_used',
          ip: req.ip,
          method: req.method,
          path: req.url,
          userAgent: req.headers['user-agent'],
          timestamp: new Date().toISOString(),
        },
        'ADMIN_API_TOKEN request',
      );

      // Check IP allowlist
      if (!isAdminTokenIpAllowed(req.ip)) {
        logger.warn(
          {
            event: 'admin_token_ip_rejected',
            ip: req.ip,
            allowlist: env.ADMIN_API_TOKEN_IP_ALLOWLIST,
          },
          'ADMIN_API_TOKEN request from unauthorized IP',
        );
      }
    }
  };
}
