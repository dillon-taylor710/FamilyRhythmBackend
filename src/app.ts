import path from 'node:path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './utils/logger';
import { errorHandler } from './middleware/errorHandler';
import { getRequestLocale, translate } from './i18n';
import { authRouter } from './modules/auth/auth.routes';
import { authPagesRouter } from './modules/auth/auth.pages.routes';
import { subscriptionsRouter } from './modules/subscriptions/subscriptions.routes';
import { adminApiRouter, adminPagesRouter } from './modules/admin/admin.routes';

export const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Default CSP blocks the inline <style>/<form> the EJS admin pages use —
// fine for an internal read-only admin tool with no user-generated
// content; revisit if the admin UI ever grows external assets or scripts.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: env.corsOrigins.length > 0 ? env.corsOrigins : false,
    credentials: true,
  }),
);
app.use(express.json());
// The admin login page (`src/views/admin/login.ejs`) is a plain HTML
// <form method="post">, not a fetch/JSON call — the browser submits that
// as `application/x-www-form-urlencoded`, which `express.json()` above
// doesn't parse. Without this, `req.body` was empty for that one request,
// so Zod validation failed before the real email/password check ever ran
// — the login form looked like it always rejected valid credentials.
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(pinoHttp({ logger }));

// General API limiter — auth routes layer a tighter one on top of this.
// JSON `handler` matters here too, same reasoning as `authLimiter` in
// `auth.routes.ts`: the default 429 body is plain text, which breaks the
// Flutter client's `jsonDecode(response.body)` for *any* endpoint under
// `/api`, not just auth.
app.use(
  '/api',
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: 'Too many requests. Please try again later.' });
    },
  }),
);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth', authRouter);
// Not `/api` — reached by tapping the link in the reset email, not a
// fetch/JSON call, same as the admin login form below.
app.use('/', authPagesRouter);
app.use('/api/subscriptions', subscriptionsRouter);
app.use('/api/admin', adminApiRouter);
app.use('/admin', adminPagesRouter);

app.use((req, res) => res.status(404).json({ error: translate('errors.notFound', getRequestLocale(req)) }));
app.use(errorHandler);
