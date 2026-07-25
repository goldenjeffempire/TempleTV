/**
 * Security configuration constants and helpers.
 */

import { env } from './env.js';

/**
 * Production-only security features that should be enabled.
 */
export const isProd = (): boolean => env.NODE_ENV === 'production';
export const isDev = (): boolean => env.NODE_ENV === 'development';

/**
 * Rate limiting configuration per route group.
 * Values are [requests per minute, timeWindow in minutes].
 */
export const rateLimitConfig = {
  // Auth: signup/login are high-value attack targets
  auth: { max: 20, timeWindow: '1 minute' },

  // General admin API: protect against brute-force iteration
  admin: { max: 240, timeWindow: '1 minute' },

  // Media delivery: high-volume streaming shouldn't be rate-limited
  media: { max: 400, timeWindow: '1 minute' },

  // YouTube API: respect their quota limits
  youtube: { max: 120, timeWindow: '1 minute' },

  // Global default: 600 req/min per IP
  default: { max: 600, timeWindow: '1 minute' },
};

/**
 * Security headers configuration.
 */
export const securityHeaders = {
  // HSTS: force HTTPS for 2 years (63072000 seconds)
  hsts: {
    maxAge: 63_072_000,
    includeSubDomains: true,
    preload: true,
  },

  // CORS: explicit origin allowlist (no wildcards in production)
  cors: {
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Admin-CSRF',
      'X-Chunk-Index',
      'X-Chunk-Checksum',
      'X-Byte-Offset',
      'Range',
    ],
    exposedHeaders: [
      'Content-Range',
      'Content-Disposition',
      'X-Total-Count',
    ],
    maxAge: 600, // 10 minutes
  },

  // CSRF: double-check with custom header on cookie-authenticated requests
  csrf: {
    headerName: 'x-admin-csrf',
    headerValue: '1',
  },
};

/**
 * ADMIN_API_TOKEN security configuration.
 */
export const adminTokenConfig = {
  // Default role for static ADMIN_API_TOKEN
  defaultRole: 'editor' as const,

  // Minimum length for random tokens (32 chars = 256 bits when hex-encoded)
  minLength: 32,

  // Should log every usage (helps detect token leaks)
  auditLogging: true,
};
