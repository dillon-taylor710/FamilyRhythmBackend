import type { DATE_RANGE_PRESETS } from './admin.schemas';

export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number];

export interface DateRangeInput {
  preset?: DateRangePreset;
  from?: string;
  to?: string;
}

export interface ResolvedDateRange {
  from?: Date;
  to?: Date;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
// Monday-start week, matching the Flutter app's own week-start convention
// (see `meal_controller.dart`'s `weekPlanProvider`).
const startOfWeek = (d: Date) => {
  const s = startOfDay(d);
  const daysSinceMonday = (s.getDay() + 6) % 7;
  s.setDate(s.getDate() - daysSinceMonday);
  return s;
};
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const startOfYear = (d: Date) => new Date(d.getFullYear(), 0, 1);

/**
 * Turns a preset button (Today/Yesterday/This Week/…) or an explicit
 * `from`/`to` pair into concrete `Date` bounds — shared by every admin list
 * page's date-range filter and by the Overview dashboard's chart range.
 * `preset` always wins over `from`/`to` if both are somehow present (the
 * date-range partial only ever submits one or the other).
 */
export function resolveDateRange(input: DateRangeInput): ResolvedDateRange {
  const now = new Date();

  switch (input.preset) {
    case 'today':
      return { from: startOfDay(now), to: endOfDay(now) };
    case 'yesterday': {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return { from: startOfDay(y), to: endOfDay(y) };
    }
    case 'this_week':
      return { from: startOfWeek(now), to: endOfDay(now) };
    case 'previous_week': {
      const thisStart = startOfWeek(now);
      const prevStart = new Date(thisStart);
      prevStart.setDate(prevStart.getDate() - 7);
      const prevEnd = new Date(thisStart);
      prevEnd.setDate(prevEnd.getDate() - 1);
      return { from: prevStart, to: endOfDay(prevEnd) };
    }
    case 'this_month':
      return { from: startOfMonth(now), to: endOfDay(now) };
    case 'previous_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return { from: start, to: end };
    }
    case 'this_year':
      return { from: startOfYear(now), to: endOfDay(now) };
    case 'previous_year':
      return {
        from: new Date(now.getFullYear() - 1, 0, 1),
        to: new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999),
      };
    default: {
      const from = input.from ? startOfDay(new Date(input.from)) : undefined;
      const to = input.to ? endOfDay(new Date(input.to)) : undefined;
      return { from, to };
    }
  }
}

const toDateInputValue = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Same resolution as `resolveDateRange`, but formatted as `<input
 * type="date">` values — so a preset button (Today/This Year/…) fills in
 * the From/To fields with the dates it actually applied, instead of
 * leaving them blank.
 */
export function resolveDateRangeForInputs(input: DateRangeInput): { from: string; to: string } {
  const { from, to } = resolveDateRange(input);
  return { from: from ? toDateInputValue(from) : '', to: to ? toDateInputValue(to) : '' };
}

export { startOfDay, endOfDay, startOfWeek, startOfMonth, startOfYear };
