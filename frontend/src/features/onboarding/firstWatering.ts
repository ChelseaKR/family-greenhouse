/**
 * When the first "check the soil" reminder for a one-tap plant lands.
 *
 * Before 2026-11-05 every tapped plant got its first reminder one full
 * interval out. For the ZZ plant, snake plant, aloe and jade (14 days) that
 * put the first reminder on the day the no-card trial ends, so the visitors
 * from the two most-searched care guides never saw the product's one proof
 * (a reminder arrives and someone acts on it) inside the trial.
 *
 * So the picker asks one question, "When did you last water it?", and the
 * answer moves only the FIRST reminder. The repeat interval is still the
 * plant's own (`waterEveryDays`).
 *
 *  - `recent` ("In the last few days"): the plant was just watered, so the
 *    next check is one interval from today, as before.
 *  - `while_ago` ("A week or more ago"): the soil may already be dry, so
 *    check it in 2 days.
 *  - `unsure` ("Not sure"): we do not know, so we do not compute a date as
 *    though we did. The reminder is a soil check tomorrow, and the copy says
 *    that is why.
 *
 * Every reminder is worded as a reminder to CHECK THE SOIL, which is what
 * every one of these care guides says to do first.
 */
export const LAST_WATERED_ANSWERS = ['recent', 'while_ago', 'unsure'] as const;
export type LastWatered = (typeof LAST_WATERED_ANSWERS)[number];

/** Days until the soil check when the plant was watered a week or more ago. */
export const CHECK_SOON_DAYS = 2;
/** Days until the soil check when the visitor is not sure. */
export const CHECK_UNSURE_DAYS = 1;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Days from now until the first soil check, never more than one interval. */
export function firstCheckInDays(waterEveryDays: number, last: LastWatered): number {
  switch (last) {
    case 'recent':
      return waterEveryDays;
    case 'while_ago':
      return Math.min(CHECK_SOON_DAYS, waterEveryDays);
    case 'unsure':
      return Math.min(CHECK_UNSURE_DAYS, waterEveryDays);
  }
}

/** The first reminder's `nextDue`, as the ISO string `POST /tasks` takes. */
export function firstCheckDue(waterEveryDays: number, last: LastWatered, now = Date.now()): string {
  return new Date(now + firstCheckInDays(waterEveryDays, last) * MS_PER_DAY).toISOString();
}
