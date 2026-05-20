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

import nodemailer, { type Transporter } from "nodemailer";
import type { SendMailOptions, SentMessageInfo } from "nodemailer";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

let _transport: Transporter | null = null;

function createTransport(): Transporter | null {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    logger.warn(
      { missingVars: [!env.SMTP_HOST && "SMTP_HOST", !env.SMTP_USER && "SMTP_USER", !env.SMTP_PASS && "SMTP_PASS"].filter(Boolean) },
      "[mailer] SMTP not configured — outbound email is disabled",
    );
    return null;
  }

  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    rateDelta: 1_000,
    rateLimit: 10,
    tls: {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    },
    logger: false,
    debug: false,
  });
}

export function getTransport(): Transporter | null {
  if (_transport === null) {
    _transport = createTransport();
  }
  return _transport;
}

/**
 * Verify SMTP connectivity. Called on server startup.
 * Logs a warning (not a crash) when SMTP is unconfigured.
 */
export async function verifyMailer(): Promise<void> {
  const transport = getTransport();
  if (!transport) return;
  try {
    await transport.verify();
    logger.info(
      { host: env.SMTP_HOST, port: env.SMTP_PORT, user: env.SMTP_USER },
      "[mailer] SMTP connection verified",
    );
  } catch (err) {
    logger.error({ err, host: env.SMTP_HOST }, "[mailer] SMTP verification failed");
  }
}

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
export async function sendMail(msg: MailMessage): Promise<SentMessageInfo | null> {
  const transport = getTransport();
  if (!transport) {
    logger.warn({ to: msg.to, subject: msg.subject }, "[mailer] email not sent — SMTP unconfigured");
    return null;
  }

  const from = `"${env.SMTP_FROM_NAME}" <${env.SMTP_USER}>`;

  const options: SendMailOptions = {
    from,
    to: Array.isArray(msg.to) ? msg.to.join(", ") : msg.to,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    replyTo: msg.replyTo ?? from,
    headers: {
      "X-Mailer": "TempleTV-API/1.0",
      "X-Priority": "3",
    },
  };

  try {
    const info = await transport.sendMail(options);
    logger.info(
      { messageId: info.messageId, to: options.to, subject: msg.subject },
      "[mailer] email sent",
    );
    return info;
  } catch (err) {
    logger.error({ err, to: options.to, subject: msg.subject }, "[mailer] email send failed");
    throw err;
  }
}

/**
 * Fire-and-forget email dispatch with error isolation.
 * Use for non-critical emails (welcome, notifications) where a send failure
 * must not surface an error to the end user.
 */
export function sendMailSilent(msg: MailMessage): void {
  sendMail(msg).catch((err) => {
    logger.error({ err, to: msg.to, subject: msg.subject }, "[mailer] silent send failed");
  });
}
