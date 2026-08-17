/**
 * Production security headers middleware.
 * 
 * Ensures all responses include proper security headers to prevent common
 * attack vectors (clickjacking, XSS, MIME sniffing, etc.).
 * 
 * Applied globally in app.ts onSend hook to cover every response including
 * API, media, and streaming endpoints.
 */

import type { FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { logger } from '../infrastructure/logger.js';

/**
 * Computes the appropriate security headers for a response.
 * 
 * - In production: strict HSTS, CSP, CORP, Referrer-Policy
 * - In development: relaxed CSP to allow live reload
 * - Media routes: cross-origin exceptions for streaming
 */
export function computeSecurityHeaders(
  req: FastifyRequest,
  contentType: string,
): Record<string, string> {
  const headers: Record<string, string> = {};

  const isProd = env.NODE_ENV === 'production';
  const isHtml = contentType.includes('text/html');
  const isMediaPath = isMediaRoute(req.url ?? '');

  // ── HSTS (HTTP Strict Transport Security) ──────────────────────────────
  // Force HTTPS for 2 years; include subdomains so *.templetv.org.ng and
  // api.templetv.org.ng are all locked to HTTPS. Preload directive allows
  // browser vendors to hardcode the domain in their HSTS preload list.
  if (isProd) {
    headers['Strict-Transport-Security'] =
      'max-age=63072000; includeSubDomains; preload';
  }

  // ── CSP (Content-Security-Policy) ──────────────────────────────────────
  // Applied only to HTML responses; JSON API doesn't need it (browsers don't
  // parse CSP on JSON). Stripped in app.ts onSend hook for non-HTML.
  if (isHtml) {
    headers['Content-Security-Policy'] =
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com; " +
      "style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; " +
      "img-src 'self' data: https:; " +
      "media-src 'self' https: blob:; " +
      "connect-src 'self' https: wss: ws:; " +
      "frame-ancestors 'self'; " +
      "base-uri 'none'; " +
      "form-action 'none'; " +
      "upgrade-insecure-requests";
  }

  // ── CORP (Cross-Origin-Resource-Policy) ───────────────────────────────
  // Default: same-origin (strict). Media routes override to cross-origin
  // in app.ts onSend hook so video can stream cross-subdomain.
  if (!isMediaPath) {
    headers['Cross-Origin-Resource-Policy'] = 'same-origin';
  }

  // ── Referrer-Policy ────────────────────────────────────────────────────
  // Send full referrer only to same-origin; strip path/query for cross-origin.
  headers['Referrer-Policy'] = 'strict-origin-when-cross-origin';

  // ── Permissions-Policy ────────────────────────────────────────────────────
  // Block potentially-abusive browser APIs on this domain.
  // The API server doesn't need camera, microphone, geolocation, or payment APIs.
  headers['Permissions-Policy'] =
    'camera=(), microphone=(), geolocation=(), payment=()';

  // ── X-DNS-Prefetch-Control ────────────────────────────────────────────────
  // Disable DNS prefetch to prevent information leakage about which domains
  // the user may visit next (based on DNS prefetch requests).
  headers['X-DNS-Prefetch-Control'] = 'off';

  // ── X-Content-Type-Options ────────────────────────────────────────────────
  // Prevent MIME-sniffing attacks; browser must respect Content-Type header.
  headers['X-Content-Type-Options'] = 'nosniff';

  // ── X-Frame-Options ────────────────────────────────────────────────────────
  // Prevent clickjacking; disallow embedding this site in iframes on
  // different origins.
  headers['X-Frame-Options'] = 'SAMEORIGIN';

  return headers;
}

/**
 * Checks if a request path is a media delivery route.
 * These routes are exempt from strict CORP to enable cross-origin streaming.
 */
function isMediaRoute(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return (
    path.includes('/uploads/') ||
    path.includes('/hls/') ||
    path.includes('/hls-token/') ||
    path.includes('/media-proxy') ||
    (path.includes('/videos/') && path.endsWith('/source'))
  );
}

/**
 * Logs all ADMIN_API_TOKEN usage for audit trails.
 * Called from attachPrincipal() when a static token is used.
 */
export function logAdminTokenUsage(
  req: FastifyRequest,
  source: 'bearer' | 'cookie',
): void {
  logger.warn(
    {
      ip: req.ip,
      method: req.method,
      url: req.url,
      tokenSource: source,
      timestamp: new Date().toISOString(),
    },
    '[SEC] ADMIN_API_TOKEN used - audit trail',
  );
}
