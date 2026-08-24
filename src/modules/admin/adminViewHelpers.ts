/**
 * Builds a query string for a list page's own filters merged with an
 * override (e.g. "same search, but page 3" or "same search, but preset
 * changed to Today") — shared by the pagination and date-range-preset
 * partials so every list page (Users/Subscriptions/Purchases) can link
 * between pages/presets without hand-building query strings per view.
 */
export function buildQueryString(
  base: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): string {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && value !== null && value !== '') merged[key] = String(value);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null || value === '') delete merged[key];
    else merged[key] = String(value);
  }
  const qs = new URLSearchParams(merged).toString();
  return qs ? `?${qs}` : '';
}
