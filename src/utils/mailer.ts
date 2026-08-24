import nodemailer from 'nodemailer';
import { env } from '../config/env';
import { logger } from './logger';

// Lazily built so a missing SMTP config doesn't crash the app at import
// time — most routes never need this.
let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (!env.SMTP_HOST || !env.SMTP_PORT) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      // Without these, a wrong host/port/blocked port hangs for the OS
      // TCP timeout (can be a minute+) before nodemailer even reports an
      // error — 10s is generous for a real SMTP provider and fails fast
      // on a misconfiguration instead of holding the request open.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });
  }
  return transporter;
}

/// No SMTP configured (`SMTP_HOST`/`SMTP_PORT` unset, the default in dev)
/// logs the email instead of sending it — lets `POST /api/auth/forgot-
/// password` work end-to-end without requiring a mail provider on hand;
/// swap in real SMTP credentials via `.env` any time to start sending for
/// real, no code changes needed.
export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  const client = getTransporter();
  const subject = 'Reset your Family Rhythm password';
  const text = `We received a request to reset your Family Rhythm password.\n\nReset it here (expires in 1 hour):\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email.`;

  if (!client) {
    logger.info({ to, resetUrl }, '[DEV] SMTP not configured — password reset link logged instead of emailed');
    return;
  }

  await client.sendMail({ from: env.SMTP_FROM, to, subject, text });
}

export async function sendVerificationCodeEmail(to: string, code: string): Promise<void> {
  const client = getTransporter();
  const subject = 'Verify your Family Rhythm email';
  const text = `Your verification code is: ${code}\n\nThis code expires in 15 minutes. If you didn't create a Family Rhythm account, you can safely ignore this email.`;

  if (!client) {
    logger.info({ to, code }, '[DEV] SMTP not configured — verification code logged instead of emailed');
    return;
  }

  await client.sendMail({ from: env.SMTP_FROM, to, subject, text });
}
