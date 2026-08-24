import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../utils/httpError';
import { logger } from '../utils/logger';
import { getRequestLocale, translate } from '../i18n';

// Centralized so every route can just `throw` — no per-route try/catch
// boilerplate needed as long as async handlers are wrapped (see
// utils/asyncHandler.ts).
//
// `HttpError.message` and zod schema `message`s (see auth.schemas.ts) are
// translation *keys* (e.g. `'auth.invalidCredentials'`), not literal
// English text — `translate()` resolves them against the caller's
// `Accept-Language` header, sent by the Flutter app's `ApiClient` based on
// the user's in-app language setting. A message that isn't a known key
// (not yet migrated to one, or a raw zod built-in like the default
// "Required") passes through as-is, so this never breaks on partial
// coverage.
function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const locale = getRequestLocale(req);

  if (err instanceof ZodError) {
    const flattened = err.flatten();
    const details = {
      formErrors: flattened.formErrors.map((m) => translate(m, locale)),
      fieldErrors: Object.fromEntries(
        Object.entries(flattened.fieldErrors).map(([field, messages]) => [
          field,
          (messages ?? []).map((m) => translate(m, locale)),
        ]),
      ),
    };
    return res.status(400).json({ error: translate('errors.validationFailed', locale), details });
  }

  if (err instanceof HttpError) {
    if (err.status >= 500) logger.error({ err }, 'Request failed');
    const params = isStringRecord(err.details) ? err.details : undefined;
    return res.status(err.status).json({ error: translate(err.message, locale, params), details: err.details });
  }

  logger.error({ err, path: req.path }, 'Unhandled error');
  return res.status(500).json({ error: translate('errors.internalServerError', locale) });
}
