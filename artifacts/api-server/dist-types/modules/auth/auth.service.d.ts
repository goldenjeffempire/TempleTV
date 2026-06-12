import type { ExtendResponse } from "./auth.schemas.js";
import type { Role } from "../../shared/types.js";
import type { AuthTokens, LoginBody, RegisterBody, ForgotPasswordBody, ResetPasswordBody } from "./auth.schemas.js";
/**
 * Delete all refresh token rows (across ALL users) that are either:
 *   - past their expiresAt, or
 *   - revoked and whose revokedAt is older than PRUNE_AFTER_DAYS days.
 *
 * Returns the number of rows deleted (for telemetry). Non-fatal — any DB
 * error is logged and re-thrown so the worker supervisor can track failures.
 */
export declare function pruneAllExpiredRefreshTokens(): Promise<number>;
export declare const authService: {
    register(body: RegisterBody): Promise<AuthTokens>;
    login(body: LoginBody): Promise<AuthTokens | {
        mfaRequired: true;
        mfaToken: string;
    }>;
    refresh(refreshToken: string, ctx?: {
        ip?: string;
        userAgent?: string;
    }): Promise<AuthTokens>;
    logout(refreshToken?: string): Promise<void>;
    /**
     * Non-rotating token extension — issues a new access token WITHOUT revoking
     * the refresh token. Used by the client keep-alive so session maintenance
     * never creates a rotation race between concurrent admin tabs.
     *
     * Rotation is still performed when the refresh token has < 7 days remaining,
     * ensuring long-lived sessions are silently extended before the refresh token
     * could expire.
     */
    extend(refreshToken: string): Promise<ExtendResponse>;
    getProfile(userId: string): Promise<{
        id: string;
        email: string;
        role: Role;
        displayName: string;
        createdAt: string;
        mfaEnabled: boolean;
    }>;
    /**
     * Change the authenticated user's password.
     * Verifies the current password before applying the new one, then
     * invalidates all active sessions for security (same as reset-password).
     */
    changePassword(userId: string, body: {
        currentPassword: string;
        newPassword: string;
        totpCode?: string;
    }): Promise<void>;
    /**
     * Update the authenticated user's profile fields.
     * Only displayName is currently mutable via this endpoint.
     */
    updateProfile(userId: string, body: {
        displayName?: string;
    }): Promise<{
        id: string;
        email: string;
        role: Role;
        displayName: string;
        createdAt: string;
        mfaEnabled: boolean;
    }>;
    /**
     * Permanently delete the authenticated user's account.
     * Requires re-entering the current password as a confirmation step
     * (Apple App Store Review Guideline 5.1.1(v) — "If your app supports
     * account creation, you must also offer account deletion within the app").
     *
     * Cascade FKs on refresh_tokens / favorites / history / password_reset_tokens
     * / device_link_codes clean up dependent rows automatically.
     */
    deleteAccount(userId: string, body: {
        currentPassword: string;
    }): Promise<void>;
    /**
     * Initiate a password reset flow.
     *
     * Always returns success (even for unknown emails) to prevent email
     * enumeration — callers cannot distinguish "email not found" from "email
     * sent" via this endpoint.
     */
    forgotPassword(body: ForgotPasswordBody): Promise<void>;
    /**
     * Complete a password reset using the token from the email link.
     * Throws BadRequestError when the token is invalid, expired, or already used.
     */
    resetPassword(body: ResetPasswordBody): Promise<void>;
};
