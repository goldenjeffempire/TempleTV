import type { Role } from "../../shared/types.js";
import type { AuthTokens, LoginBody, RegisterBody, ForgotPasswordBody, ResetPasswordBody } from "./auth.schemas.js";
export declare const authService: {
    register(body: RegisterBody): Promise<AuthTokens>;
    login(body: LoginBody): Promise<AuthTokens>;
    refresh(refreshToken: string, ctx?: {
        ip?: string;
        userAgent?: string;
    }): Promise<AuthTokens>;
    logout(refreshToken: string): Promise<void>;
    getProfile(userId: string): Promise<{
        id: string;
        email: string;
        role: Role;
        displayName: string;
        createdAt: string;
    }>;
    /**
     * Change the authenticated user's password.
     * Verifies the current password before applying the new one, then
     * invalidates all active sessions for security (same as reset-password).
     */
    changePassword(userId: string, body: {
        currentPassword: string;
        newPassword: string;
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
    }>;
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
