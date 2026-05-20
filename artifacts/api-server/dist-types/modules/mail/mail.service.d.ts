/**
 * High-level transactional email service.
 *
 * All methods are fire-and-forget by default (sendMailSilent) so a mail
 * failure never propagates an HTTP 500 to the end user. Use the `await`
 * variants only when the caller needs to confirm delivery (e.g. admin
 * test-send).
 */
import { type AdminAlertParams } from "./templates.js";
interface UserInfo {
    email: string;
    displayName: string;
}
export declare function sendWelcomeEmail(user: UserInfo): void;
export declare function sendPasswordResetEmail(user: UserInfo, token: string): void;
export declare const PASSWORD_RESET_TTL_MS: number;
export declare function sendEmailVerification(user: UserInfo, token: string): void;
/**
 * Send an alert to the configured admin inbox (SMTP_USER).
 * Awaitable — admin tooling may want to confirm delivery.
 */
export declare function sendAdminAlert(params: AdminAlertParams): Promise<void>;
export {};
