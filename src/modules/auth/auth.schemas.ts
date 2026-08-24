import { z } from 'zod';

// `email(...)`/`min(...)` custom messages are translation *keys* (see
// `i18n/index.ts`'s doc comment), not literal English — `errorHandler.ts`
// resolves them against the caller's locale before they reach the client.
export const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email('auth.emailInvalid'),
  password: z.string().min(8, 'auth.passwordTooShort'),
  displayName: z.string().trim().min(1, 'auth.displayNameRequired').max(120),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('auth.emailInvalid'),
  password: z.string().min(1),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email('auth.emailInvalid'),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, 'auth.passwordTooShort'),
});

export const verifyEmailSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'auth.verificationCodeInvalid'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'auth.passwordTooShort'),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
