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
/**
 * Computes the appropriate security headers for a response.
 *
 * - In production: strict HSTS, CSP, CORP, Referrer-Policy
 * - In development: relaxed CSP to allow live reload
 * - Media routes: cross-origin exceptions for streaming
 */
export declare function computeSecurityHeaders(req: FastifyRequest, contentType: string): Record<string, string>;
/**
 * Logs all ADMIN_API_TOKEN usage for audit trails.
 * Called from attachPrincipal() when a static token is used.
 */
export declare function logAdminTokenUsage(req: FastifyRequest, source: 'bearer' | 'cookie'): void;
