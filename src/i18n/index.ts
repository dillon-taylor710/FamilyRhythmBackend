import { Request } from 'express';
import { LocaleCode, MESSAGES, SUPPORTED_LOCALES } from './messages';

const SUPPORTED_SET = new Set<string>(SUPPORTED_LOCALES);

/// `Accept-Language` tags use dashes (`zh-Hant`, `pt-BR`) while our locale
/// codes use underscores for the one script-qualified one (`zh_Hant`) —
/// normalize before matching. Only the primary tag is read; the Flutter
/// client (`ApiClient`) sends exactly one, not a weighted list.
function normalizeLocale(tag: string): LocaleCode | null {
  const normalized = tag.trim().replace('-', '_');
  if (SUPPORTED_SET.has(normalized)) return normalized as LocaleCode;

  const base = normalized.split('_')[0] ?? normalized;
  if (SUPPORTED_SET.has(base)) return base as LocaleCode;

  return null;
}

export function getRequestLocale(req: Request): LocaleCode {
  const header = req.headers['accept-language'];
  const tag = Array.isArray(header) ? header[0] : header;
  if (!tag) return 'en';
  return normalizeLocale(tag.split(',')[0]) ?? 'en';
}

/// Translates a message *key* (e.g. `'auth.invalidCredentials'`) into the
/// given locale, substituting any `{{param}}` placeholders. A string
/// that isn't a known key — including any literal English text a call
/// site hasn't been migrated to a key yet — passes through unchanged, so
/// this is always safe to call even on partially-localized messages.
export function translate(key: string, locale: LocaleCode, params?: Record<string, string>): string {
  const entry = MESSAGES[key];
  let message = entry ? entry[locale] ?? entry.en : key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      message = message.replace(`{{${name}}}`, value);
    }
  }
  return message;
}
