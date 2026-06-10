/**
 * Production-grade nodemailer transport.
 *
 * Design decisions:
 *  • Connection pool (maxConnections=5) — reuses SMTP connections across
 *    messages to avoid per-message TCP+TLS handshake overhead.
 *  • STARTTLS on port 587 (secure=false); change SMTP_SECURE=true for
 *    implicit TLS on port 465.
 *  • Graceful no-op when SMTP_HOST is absent — development environments
 *    without mail credentials get a console.warn rather than a crash.
 *  • verify() is called at startup so misconfigurations surface immediately
 *    in logs rather than at the first email send.
 *  • All errors are caught and re-thrown with context so callers can decide
 *    whether to surface them to the user or swallow them.
 */
import { type Transporter } from "nodemailer";
import type { SentMessageInfo } from "nodemailer";
export declare function getTransport(): Transporter | null;
/**
 * Forcibly reset the transport singleton.
 *
 * Call this after rotating SMTP credentials, or from the admin test-email
 * endpoint after a failed send, so the next getTransport() call builds a
 * fresh connection pool with the updated credentials. Without this, a bad
 * password will keep every subsequent sendMail() failing until the process
 * is restarted.
 */
export declare function resetTransport(): void;
/**
 * Verify SMTP connectivity. Called on server startup.
 * Logs a warning (not a crash) when SMTP is unconfigured.
 */
export declare function verifyMailer(): Promise<void>;
export interface MailMessage {
    to: string | string[];
    subject: string;
    html: string;
    text: string;
    replyTo?: string;
}
/**
 * Send a single transactional email.
 * Returns the nodemailer info object on success, or null when SMTP is unconfigured.
 * Throws on send failure so callers can handle/retry.
 */
export declare function sendMail(msg: MailMessage): Promise<SentMessageInfo | null>;
/**
 * Fire-and-forget email dispatch with error isolation.
 * Use for non-critical emails (welcome, notifications) where a send failure
 * must not surface an error to the end user.
 */
export declare function sendMailSilent(msg: MailMessage): void;
