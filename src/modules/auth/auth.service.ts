import crypto from 'node:crypto';
import { prisma } from '../../db/prisma';
import { env } from '../../config/env';
import { hashPassword, verifyPassword } from '../../utils/password';
import { signUserToken } from '../../utils/jwt';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../utils/httpError';
import { sendPasswordResetEmail, sendVerificationCodeEmail } from '../../utils/mailer';
import { logger } from '../../utils/logger';
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  ResetPasswordInput,
  SignupInput,
  VerifyEmailInput,
} from './auth.schemas';

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const VERIFICATION_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const VERIFICATION_MAX_ATTEMPTS = 5;

// The raw token/code only ever exists in the emailed message — the DB
// stores just this hash, so a leaked row can't be replayed (same
// reasoning as `passwordHash` never storing the plaintext password).
const hashResetToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const hashVerificationCode = (code: string) => crypto.createHash('sha256').update(code).digest('hex');

function generateVerificationCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

async function issueVerificationCode(userId: string, email: string): Promise<void> {
  const code = generateVerificationCode();
  await prisma.emailVerificationCode.create({
    data: {
      userId,
      codeHash: hashVerificationCode(code),
      expiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
    },
  });
  try {
    await sendVerificationCodeEmail(email, code);
  } catch (err) {
    // Same reasoning as `requestPasswordReset`'s mailer try/catch — a
    // broken SMTP provider shouldn't fail signup itself; the code row
    // still exists so "Resend code" (once SMTP is fixed) still works.
    logger.error({ err, userId }, 'Failed to send verification code email');
  }
}

// Matches the "30-Day Free Trial" copy already shown in the Flutter app
// (lib/l10n `subscriptionTrialTitle`) — the mock controller used an
// arbitrary 18-days-remaining placeholder; this is the real trial length
// a new account actually gets.
const TRIAL_LENGTH_DAYS = 30;

export async function signup(input: SignupInput) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw conflict('auth.emailExists');

  const passwordHash = await hashPassword(input.password);
  const now = new Date();
  const trialEnd = new Date(now.getTime() + TRIAL_LENGTH_DAYS * 24 * 60 * 60 * 1000);

  const user = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      displayName: input.displayName,
      emailVerified: true,
      subscription: {
        create: {
          status: 'active_trial',
          trialStartAt: now,
          currentPeriodStart: now,
          currentPeriodEnd: trialEnd,
        },
      },
    },
  });

  // For now, email verify disable
  //await issueVerificationCode(user.id, user.email);

  return { userId: user.id, token: signUserToken(user.id), emailVerified: true/*false*/ };
}

export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('auth.userNotFound');
  return { id: user.id, email: user.email, displayName: user.displayName, emailVerified: user.emailVerified };
}

// Admin "login count" is distinct calendar days, not raw login count — so
// only the first login of the day actually inserts a row; subsequent
// same-day logins are a no-op.
async function recordLoginEvent(userId: string): Promise<void> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const existingToday = await prisma.loginEvent.findFirst({
    where: { userId, createdAt: { gte: startOfToday } },
  });
  if (existingToday) return;

  await prisma.loginEvent.create({ data: { userId } });
}

export async function login(input: LoginInput) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user) throw unauthorized('auth.invalidCredentials');

  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) throw unauthorized('auth.invalidCredentials');

  await recordLoginEvent(user.id);

  return { userId: user.id, token: signUserToken(user.id) };
}

/// Always resolves the same way whether or not `input.email` has an
/// account — the route (and this function) must never let a caller learn
/// which emails are registered by observing a difference in response.
export async function requestPasswordReset(input: ForgotPasswordInput): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user) return;

  const rawToken = crypto.randomBytes(32).toString('hex');
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashResetToken(rawToken),
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  });

  const resetUrl = `${env.APP_BASE_URL}/reset-password?token=${rawToken}`;
  try {
    await sendPasswordResetEmail(user.email, resetUrl);
  } catch (err) {
    // A broken/misconfigured SMTP provider is an operational problem, not
    // something this endpoint should ever surface to the caller — letting
    // it throw would both break the "always resolves the same way" contract
    // above (a real registered email now 500s, a fake one still 200s,
    // which itself leaks which emails are registered) and needlessly fail
    // signup/reset flows over a transient mail-provider hiccup. The token
    // row above still exists, so a fixed SMTP config (or a manually
    // resent link) still works retroactively within the 1-hour TTL.
    logger.error({ err, userId: user.id }, 'Failed to send password reset email');
  }
}

/// Used by the reset-password page's GET to decide whether to show the
/// "set a new password" form vs. an "expired link" message — doesn't
/// consume the token (only `resetPassword`'s actual submit does that).
export async function isResetTokenValid(token: string): Promise<boolean> {
  const resetToken = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashResetToken(token) } });
  return !!resetToken && !resetToken.usedAt && resetToken.expiresAt > new Date();
}

export async function resetPassword(input: ResetPasswordInput): Promise<void> {
  const tokenHash = hashResetToken(input.token);
  const resetToken = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });

  if (!resetToken || resetToken.usedAt || resetToken.expiresAt < new Date()) {
    throw badRequest('auth.resetLinkInvalid');
  }

  const passwordHash = await hashPassword(input.password);
  await prisma.$transaction([
    prisma.user.update({ where: { id: resetToken.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: resetToken.id }, data: { usedAt: new Date() } }),
  ]);
}

/// Checks `input.code` against the most recent unused, unexpired code for
/// `userId` — wrong guesses count against `VERIFICATION_MAX_ATTEMPTS`
/// (a 6-digit code is only 1e6 possibilities, unlike the password-reset
/// token, so it needs its own brute-force cap independent of the general
/// per-IP rate limiter in `auth.routes.ts`). Marks the user verified on
/// success; throws `auth.verificationCodeInvalid` on a wrong/expired/
/// exhausted code either way, so a caller can't tell which of those it was.
export async function verifyEmail(userId: string, input: VerifyEmailInput): Promise<void> {
  const codeRow = await prisma.emailVerificationCode.findFirst({
    where: { userId, usedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (!codeRow || codeRow.expiresAt < new Date() || codeRow.attempts >= VERIFICATION_MAX_ATTEMPTS) {
    throw badRequest('auth.verificationCodeInvalid');
  }

  if (codeRow.codeHash !== hashVerificationCode(input.code)) {
    await prisma.emailVerificationCode.update({
      where: { id: codeRow.id },
      data: { attempts: { increment: 1 } },
    });
    throw badRequest('auth.verificationCodeInvalid');
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { emailVerified: true } }),
    prisma.emailVerificationCode.update({ where: { id: codeRow.id }, data: { usedAt: new Date() } }),
  ]);
}

export async function resendVerificationCode(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('auth.userNotFound');
  if (user.emailVerified) return;
  await issueVerificationCode(user.id, user.email);
}

export async function changePassword(userId: string, input: ChangePasswordInput): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('auth.userNotFound');

  const valid = await verifyPassword(input.currentPassword, user.passwordHash);
  if (!valid) throw forbidden('auth.currentPasswordIncorrect');

  const passwordHash = await hashPassword(input.newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
}
