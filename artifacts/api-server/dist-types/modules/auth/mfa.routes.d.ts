/**
 * MFA / TOTP routes — POST /auth/mfa/*
 *
 * Setup flow (requires existing auth):
 *   POST /auth/mfa/setup   — generate secret + backup codes (stored, not yet active)
 *   POST /auth/mfa/enable  — verify first TOTP code → activate MFA on the account
 *   POST /auth/mfa/disable — verify TOTP or password → deactivate MFA
 *   GET  /auth/mfa/status  — whether MFA is configured for the current user
 *
 * Login flow (no existing auth):
 *   POST /auth/mfa/verify  — exchange mfaToken + TOTP code for real access+refresh tokens
 */
import type { FastifyInstance } from "fastify";
declare function signMfaPendingToken(userId: string): Promise<string>;
export declare function mfaRoutes(app: FastifyInstance): Promise<void>;
export { signMfaPendingToken };
