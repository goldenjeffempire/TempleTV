/**
 * High-level transactional email service.
 *
 * All methods are fire-and-forget by default (sendMailSilent) so a mail
 * failure never propagates an HTTP 500 to the end user. Use the `await`
 * variants only when the caller needs to confirm delivery (e.g. admin
 * test-send).
 */

import { sendMail, sendMailSilent } from "../../infrastructure/mailer.js";
import {
  welcomeTemplate,
  passwordResetTemplate,
  emailVerificationTemplate,
  adminAlertTemplate,
  type AdminAlertParams,
} from "./templates.js";
import { env } from "../../config/env.js";
import { logger } from "../../infrastructure/logger.js";

/**
 * Returns the best available base URL for clickable links in emails.
 *
 * Resolution order:
 *   1. APP_BASE_URL — explicit operator override (e.g. https://templetv.org.ng)
 *   2. API_ORIGIN   — if set and not api.*, use it directly; if api.*, derive
 *                     the root domain (api.templetv.org.ng → templetv.org.ng)
 *   3. RENDER_EXTERNAL_URL — Render-assigned <service>.onrender.com URL
 *   4. Empty string — links will be relative paths; functional but ugly
 *
 * This prevents the APP_BASE_URL default="" from breaking email reset links
 * when the env var is not explicitly set in production.
 */
function resolveAppBaseUrl(): string {
  const raw = env.APP_BASE_URL?.trim();
  if (raw && !raw.includes("localhost") && !raw.includes("127.0.0.1")) {
    return raw.replace(/\/$/, "");
  }

  // Derive root domain from API_ORIGIN (api.foo.bar → https://foo.bar)
  if (env.API_ORIGIN) {
    try {
      const parsed = new URL(env.API_ORIGIN);
      const h = parsed.hostname;
      if (h.startsWith("api.")) {
        return `https://${h.slice("api.".length)}`;
      }
      return `https://${h}`;
    } catch {
      // malformed — fall through
    }
  }

  // Render external URL as last resort
  const renderUrl = process.env["RENDER_EXTERNAL_URL"];
  if (renderUrl) return renderUrl.replace(/\/$/, "");

  return "";
}

interface UserInfo {
  email: string;
  displayName: string;
}

// ── Welcome ────────────────────────────────────────────────────────────────

export function sendWelcomeEmail(user: UserInfo): void {
  const tpl = welcomeTemplate({
    displayName: user.displayName,
    email: user.email,
    appBaseUrl: resolveAppBaseUrl(),
  });
  sendMailSilent({
    to: user.email,
    subject: "Welcome to Temple TV | JCTM",
    ...tpl,
  });
}

// ── Password reset ─────────────────────────────────────────────────────────

const PASSWORD_RESET_TTL_MINUTES = 30;

export function sendPasswordResetEmail(user: UserInfo, token: string): void {
  const resetUrl = `${resolveAppBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  const tpl = passwordResetTemplate({
    displayName: user.displayName,
    resetUrl,
    expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
  });
  sendMailSilent({
    to: user.email,
    subject: "Reset Your Temple TV Password",
    ...tpl,
  });
}

export const PASSWORD_RESET_TTL_MS = PASSWORD_RESET_TTL_MINUTES * 60 * 1_000;

// ── Email verification ─────────────────────────────────────────────────────

const EMAIL_VERIFY_TTL_MINUTES = 60;

export function sendEmailVerification(user: UserInfo, token: string): void {
  const verifyUrl = `${resolveAppBaseUrl()}/verify-email?token=${encodeURIComponent(token)}`;
  const tpl = emailVerificationTemplate({
    displayName: user.displayName,
    verifyUrl,
    expiresInMinutes: EMAIL_VERIFY_TTL_MINUTES,
  });
  sendMailSilent({
    to: user.email,
    subject: "Verify Your Temple TV Email Address",
    ...tpl,
  });
}

// ── Admin alert ────────────────────────────────────────────────────────────

/**
 * Send an alert to the configured admin inbox (SMTP_USER).
 * Awaitable — admin tooling may want to confirm delivery.
 */
export async function sendAdminAlert(params: AdminAlertParams): Promise<void> {
  if (!env.SMTP_USER) {
    logger.warn("[mail.service] admin alert skipped — SMTP not configured");
    return;
  }
  const tpl = adminAlertTemplate(params);
  try {
    await sendMail({
      to: env.SMTP_USER,
      subject: `[Temple TV] ${params.severity?.toUpperCase() ?? "INFO"}: ${params.subject}`,
      ...tpl,
    });
  } catch (err) {
    logger.error({ err }, "[mail.service] admin alert send failed");
  }
}
