import 'dotenv/config';
import { z } from 'zod';

// Fails fast at boot with a clear message instead of undefined-secret bugs
// showing up later at request time (e.g. `jwt.sign(payload, undefined)`).
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  CORS_ORIGINS: z.string().default(''),

  JWT_USER_SECRET: z.string().min(16, 'JWT_USER_SECRET must be set to a long random value'),
  JWT_USER_EXPIRES_IN: z.string().default('30d'),

  JWT_ADMIN_SECRET: z.string().min(16, 'JWT_ADMIN_SECRET must be set to a long random value'),
  JWT_ADMIN_EXPIRES_IN: z.string().default('10m'),
  ADMIN_COOKIE_NAME: z.string().default('family_rhythm_admin'),

  GOOGLE_SERVICE_ACCOUNT_KEY_FILE: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_PLAY_PACKAGE_NAME: z.string().optional(),

  APPLE_ISSUER_ID: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  APPLE_PRIVATE_KEY: z.string().optional(),
  APPLE_BUNDLE_ID: z.string().optional(),
  APPLE_USE_SANDBOX: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  // Used to build the reset-password link mailed out by
  // `POST /api/auth/forgot-password` — see `src/utils/mailer.ts`.
  APP_BASE_URL: z.string().default('http://localhost:4000'),
  // All optional — if unset, `mailer.ts` logs the reset link to the
  // console instead of sending a real email, so this works out of the box
  // in dev without an SMTP provider on hand.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('Family Rhythm <no-reply@familyrhythm.app>'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
