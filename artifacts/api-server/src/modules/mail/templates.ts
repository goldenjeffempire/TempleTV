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

const BRAND_COLOR = "#6a0dad";
const BRAND_BG = "#0a000f";
const FONT = "Arial, Helvetica, sans-serif";

function wrap(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:${FONT};">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
          <!-- Header -->
          <tr>
            <td style="background:${BRAND_BG};padding:32px 40px;text-align:center;">
              <img src="https://templetv.org.ng/icon.png" alt="Temple TV" width="56" height="56" style="border-radius:10px;display:block;margin:0 auto;" />
              <p style="margin:10px 0 0;font-size:9px;font-weight:600;letter-spacing:0.14em;color:rgba(255,255,255,0.5);text-transform:uppercase;">JCTM Broadcasting</p>
              <div style="margin-top:12px;width:40px;height:3px;background:${BRAND_COLOR};border-radius:2px;display:inline-block;"></div>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              ${bodyHtml}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f9f9f9;padding:24px 40px;border-top:1px solid #eeeeee;text-align:center;">
              <p style="margin:0;font-size:12px;color:#999999;line-height:1.6;">
                JCTM Broadcasting<br/>
                Spirit-filled teachings &amp; worship — broadcasting 24/7<br/>
                <span style="font-size:11px;color:#cccccc;">This is an automated message. Do not reply directly to this email.</span>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function btn(href: string, label: string, color = BRAND_COLOR): string {
  return `<a href="${href}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:14px 32px;border-radius:8px;letter-spacing:0.01em;">${label}</a>`;
}

function h1(text: string): string {
  return `<h1 style="margin:0 0 16px;font-size:26px;font-weight:800;color:#111111;line-height:1.2;">${text}</h1>`;
}

function p(text: string, style = ""): string {
  return `<p style="margin:0 0 16px;font-size:15px;color:#444444;line-height:1.7;${style}">${text}</p>`;
}

function divider(): string {
  return `<div style="border-top:1px solid #eeeeee;margin:24px 0;"></div>`;
}

// ── Welcome email ──────────────────────────────────────────────────────────

export interface WelcomeParams {
  displayName: string;
  email: string;
  appBaseUrl: string;
}

export function welcomeTemplate({ displayName, appBaseUrl }: WelcomeParams): { html: string; text: string } {
  const safeName = displayName.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));
  const html = wrap("Welcome to Temple TV", `
    ${h1(`Welcome, ${safeName}!`)}
    ${p("Your Temple TV account has been created. You now have access to a library of spirit-filled teachings, worship sessions, and live broadcasts — available 24/7 from any device.")}
    ${divider()}
    ${p("Ready to tune in?")}
    <div style="text-align:center;margin:28px 0;">
      ${btn(`${appBaseUrl}/tv`, "Watch Temple TV")}
    </div>
    ${divider()}
    ${p(`If you didn't create this account, you can safely ignore this email.`, "font-size:13px;color:#999999;")}
  `);
  const text = `Welcome to Temple TV, ${displayName}!\n\nYour account has been created. Watch live broadcasts and on-demand content at: ${appBaseUrl}/tv\n\nIf you did not create this account, please ignore this email.\n\n— Temple TV | JCTM Broadcasting`;
  return { html, text };
}

// ── Password reset ─────────────────────────────────────────────────────────

export interface PasswordResetParams {
  displayName: string;
  resetUrl: string;
  expiresInMinutes: number;
}

export function passwordResetTemplate({ displayName, resetUrl, expiresInMinutes }: PasswordResetParams): { html: string; text: string } {
  const safeName = displayName.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));
  const html = wrap("Reset Your Password — Temple TV", `
    ${h1("Password Reset Request")}
    ${p(`Hi ${safeName},`)}
    ${p("We received a request to reset the password for your Temple TV account. Click the button below to choose a new password.")}
    <div style="text-align:center;margin:28px 0;">
      ${btn(resetUrl, "Reset My Password")}
    </div>
    ${p(`This link expires in <strong>${expiresInMinutes} minutes</strong>.`)}
    ${divider()}
    ${p("If you didn't request a password reset, you can safely ignore this email — your password will not change.", "font-size:13px;color:#999999;")}
    ${p(`If the button doesn't work, copy and paste this URL into your browser:<br/><a href="${resetUrl}" style="color:${BRAND_COLOR};word-break:break-all;">${resetUrl}</a>`, "font-size:12px;color:#999999;")}
  `);
  const text = `Hi ${displayName},\n\nWe received a request to reset your Temple TV account password.\n\nReset your password here (expires in ${expiresInMinutes} minutes):\n${resetUrl}\n\nIf you didn't request this, ignore this email.\n\n— Temple TV | JCTM Broadcasting`;
  return { html, text };
}

// ── Email verification ─────────────────────────────────────────────────────

export interface EmailVerificationParams {
  displayName: string;
  verifyUrl: string;
  expiresInMinutes: number;
}

export function emailVerificationTemplate({ displayName, verifyUrl, expiresInMinutes }: EmailVerificationParams): { html: string; text: string } {
  const safeName = displayName.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));
  const html = wrap("Verify Your Email — Temple TV", `
    ${h1("Verify Your Email Address")}
    ${p(`Hi ${safeName},`)}
    ${p("Please verify your email address to complete your Temple TV account setup.")}
    <div style="text-align:center;margin:28px 0;">
      ${btn(verifyUrl, "Verify Email Address")}
    </div>
    ${p(`This link expires in <strong>${expiresInMinutes} minutes</strong>.`)}
    ${divider()}
    ${p("If you didn't create a Temple TV account, please ignore this email.", "font-size:13px;color:#999999;")}
  `);
  const text = `Hi ${displayName},\n\nPlease verify your email address:\n${verifyUrl}\n\nThis link expires in ${expiresInMinutes} minutes.\n\n— Temple TV | JCTM Broadcasting`;
  return { html, text };
}

// ── Admin alert ────────────────────────────────────────────────────────────

export interface AdminAlertParams {
  subject: string;
  body: string;
  severity?: "info" | "warning" | "critical";
}

export function adminAlertTemplate({ subject, body, severity = "info" }: AdminAlertParams): { html: string; text: string } {
  const severityColor = severity === "critical" ? "#dc2626" : severity === "warning" ? "#d97706" : BRAND_COLOR;
  const severityLabel = severity.toUpperCase();
  const html = wrap(`[${severityLabel}] ${subject}`, `
    <div style="background:${severityColor}10;border-left:4px solid ${severityColor};padding:12px 16px;margin-bottom:20px;border-radius:0 6px 6px 0;">
      <span style="font-size:11px;font-weight:800;color:${severityColor};letter-spacing:0.1em;">${severityLabel}</span>
    </div>
    ${h1(subject)}
    <pre style="background:#f8f8f8;border:1px solid #eeeeee;border-radius:6px;padding:16px;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:#333333;font-family:monospace;">${body.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c))}</pre>
    ${divider()}
    ${p("This is an automated alert from the Temple TV platform.", "font-size:12px;color:#999999;")}
  `);
  const text = `[${severityLabel}] ${subject}\n\n${body}\n\n— Temple TV Platform Alert`;
  return { html, text };
}
