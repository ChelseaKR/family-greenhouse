/**
 * The care guides' "your next watering" tool: which guides can give a date,
 * and what that date is.
 *
 * Only a guide whose own "At a glance" water line states a number of days
 * gets a date. On 2026-11-03 every guide was checked against the extension
 * and RHS pages it cites, and most of those sources give a soil-moisture rule
 * ("when the top inch is dry"), not a calendar. For those guides the tool
 * says so in words and gives no date; it never borrows a number from another
 * plant or from a default.
 *
 * `stated` is copied word for word from that guide's `quickFacts.water`, and
 * `nextWatering.test.ts` fails if the guide stops saying it, so an edit to a
 * guide's watering advice cannot leave the tool counting from a number the
 * page no longer prints. `days` is the low end of what `stated` says ("about
 * twice a week" is every 3 to 4 days, so 3): the date is a day to check the
 * soil, and checking early is the safe side.
 *
 * This file deliberately does not import `CARE_GUIDES`: the guide prose is
 * kept out of the bundle (#1087).
 */
export interface StatedInterval {
  /** Days between soil checks: the low end of `stated`. */
  days: number;
  /** The guide's own words for that interval, copied from `quickFacts.water`. */
  stated: string;
}

export const STATED_INTERVALS: Readonly<Record<string, StatedInterval>> = {
  'zz-plant': { days: 14, stated: 'About every 2 weeks in summer' },
  orchid: { days: 7, stated: 'About once a week' },
  'nerve-plant': { days: 3, stated: 'About twice a week' },
  haworthia: { days: 7, stated: 'Weekly in summer' },
  'blue-echeveria': { days: 7, stated: 'about weekly or less' },
};

export function statedInterval(slug: string): StatedInterval | undefined {
  return Object.hasOwn(STATED_INTERVALS, slug) ? STATED_INTERVALS[slug] : undefined;
}

/**
 * The tool's one question, "When did you last water it?". The same values
 * ride to sign-up as `?last=` (guidePlantHandoff), so the first run can
 * pre-select the answer.
 */
export const LAST_WATERED_BUCKETS = ['today', 'week', 'two_weeks', 'unsure'] as const;
export type LastWateredBucket = (typeof LAST_WATERED_BUCKETS)[number];

export const LAST_WATERED_LABELS: Record<LastWateredBucket, string> = {
  today: 'Today',
  week: 'About a week ago',
  two_weeks: 'Two weeks or more',
  unsure: 'Not sure',
};

export function isLastWateredBucket(value: unknown): value is LastWateredBucket {
  return typeof value === 'string' && (LAST_WATERED_BUCKETS as readonly string[]).includes(value);
}

/** Days since the last watering for each answer; "Not sure" has none. */
const DAYS_AGO: Record<Exclude<LastWateredBucket, 'unsure'>, number> = {
  today: 0,
  week: 7,
  two_weeks: 14,
};

export interface CalendarDay {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
}

/** The visitor's local calendar date for `now`. */
export function localDay(now: Date): CalendarDay {
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

function addDays(from: CalendarDay, days: number): CalendarDay {
  const date = new Date(from.year, from.month - 1, from.day + days);
  return localDay(date);
}

/**
 * When to check the soil next: `today` is true when the answer means the
 * check is due now ("Not sure" always is, since we do not know). `date` is
 * the day itself, which is today in that case.
 */
export function nextCheck(
  intervalDays: number,
  last: LastWateredBucket,
  now: Date
): { today: boolean; date: CalendarDay } {
  const today = localDay(now);
  if (last === 'unsure') return { today: true, date: today };
  const inDays = intervalDays - DAYS_AGO[last];
  if (inDays <= 0) return { today: true, date: today };
  return { today: false, date: addDays(today, inDays) };
}

/** "Wednesday, December 16", in the page's language (English). */
export function formatCheckDay(day: CalendarDay): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(day.year, day.month - 1, day.day));
}
