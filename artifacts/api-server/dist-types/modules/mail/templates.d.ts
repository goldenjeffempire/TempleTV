/**
 * Branded HTML + plain-text email templates for Temple TV | JCTM.
 *
 * Design:
 *  • Each template returns { html, text } so callers have both a rich and
 *    a fallback representation — nodemailer sends both as a multipart/alternative.
 *  • Inline styles only — email clients strip <style> blocks.
 *  • Temple TV purple (#6a0dad) brand colour used consistently.
 *  • Each template is a pure function of its parameters so it is trivially testable.
 */
export interface WelcomeParams {
    displayName: string;
    email: string;
    appBaseUrl: string;
}
export declare function welcomeTemplate({ displayName, appBaseUrl }: WelcomeParams): {
    html: string;
    text: string;
};
export interface PasswordResetParams {
    displayName: string;
    resetUrl: string;
    expiresInMinutes: number;
}
export declare function passwordResetTemplate({ displayName, resetUrl, expiresInMinutes }: PasswordResetParams): {
    html: string;
    text: string;
};
export interface EmailVerificationParams {
    displayName: string;
    verifyUrl: string;
    expiresInMinutes: number;
}
export declare function emailVerificationTemplate({ displayName, verifyUrl, expiresInMinutes }: EmailVerificationParams): {
    html: string;
    text: string;
};
export interface AdminAlertParams {
    subject: string;
    body: string;
    severity?: "info" | "warning" | "critical";
}
export declare function adminAlertTemplate({ subject, body, severity }: AdminAlertParams): {
    html: string;
    text: string;
};
