/**
 * Which language an email is written in, and — always — why.
 *
 * ## THE ACCESSOR OTHER SERVICES SHOULD CALL
 *
 *     import { resolveEmailLocaleForUser } from './email/locale.js';
 *     const { locale, source } = await resolveEmailLocaleForUser(userId, householdId);
 *
 * That is the whole integration. Any composer that needs to know what
 * language to write in calls this rather than reading a preference inline, so
 * the fallback chain lives in one place and changing it changes every email
 * at once. Pass `householdId` when you have it and the household's prevailing
 * language becomes the second step; omit it and the chain is user → English.
 *
 * Log the `source` alongside the send. It is the difference between "this
 * person asked for English" and "nobody has ever told us, so English is a
 * guess", and a product that silently mails a Spanish-speaking household in
 * English should at least be able to count how often it does it.
 *
 * ## What the codebase actually had
 *
 * Nothing. Before this change there was no locale field anywhere the backend
 * could read: `NotificationPreferences` carried no language, Cognito's schema
 * adds only `household_id` and `household_role`, and the i18n catalogs are
 * frontend-only. A Spanish speaker could run the whole UI in Spanish and
 * receive every single email in English. So `emailLocale` is a new field on
 * the preferences row (see `services/notificationPrefs.ts`), and this module
 * is the one place that decides what to do when it is unset.
 *
 * ## The chain
 *
 *   1. the recipient's own `emailLocale`
 *   2. the household's — the most common locale its members have chosen,
 *      ties broken by the earliest joiner, so a household that has settled on
 *      Spanish does not mail its newest member in English
 *   3. `en`
 *
 * ## Why it returns a source
 *
 * Falling back silently to English is the failure this exists to prevent.
 * Every resolution carries the step that produced it: `'user'`, `'household'`,
 * `'default'` (nobody has chosen), or `'unavailable'` (the preference read
 * failed, so English is what we could manage, not what we know).
 *
 * The `''` sentinel on the stored field matters too. `timezone` has no "never
 * chosen" state — it reads `'UTC'` both for a row nobody ever wrote and for a
 * user who genuinely chose UTC, which is the documented sharp edge behind
 * quiet hours being evaluated in the wrong zone. `emailLocale` defaults to the
 * empty string precisely so "not chosen" stays distinguishable from "chose
 * English", and the settings page back-fills it rather than waiting for a Save
 * the user may never press.
 */
import { logger } from '../../utils/logger.js';
import * as householdService from '../householdService.js';
import * as notificationPrefs from '../notificationPrefs.js';
import { isEmailLocale, type EmailLocale } from './catalog.js';

export type LocaleSource = 'user' | 'household' | 'default' | 'unavailable';

export interface ResolvedLocale {
  locale: EmailLocale;
  source: LocaleSource;
}

/**
 * The household's prevailing email locale from an ordered list of its
 * members' stored choices (oldest joiner first), or null when no member has
 * chosen one. Null is "we do not know", never a stand-in English.
 *
 * Pure, so a caller that already holds every member's preferences — the
 * weekly digest reads them all anyway — can use it with no extra reads.
 */
export function householdLocaleFrom(
  memberLocales: Array<string | null | undefined>
): EmailLocale | null {
  const counts = new Map<EmailLocale, number>();
  const firstSeen = new Map<EmailLocale, number>();
  memberLocales.forEach((raw, index) => {
    if (!isEmailLocale(raw)) return;
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
    if (!firstSeen.has(raw)) firstSeen.set(raw, index);
  });
  if (counts.size === 0) return null;
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || (firstSeen.get(a[0]) ?? 0) - (firstSeen.get(b[0]) ?? 0)
  )[0][0];
}

/**
 * Pure resolution, for callers that already hold both inputs.
 */
export function resolveEmailLocale(
  userLocale: string | null | undefined,
  household: EmailLocale | null
): ResolvedLocale {
  if (isEmailLocale(userLocale)) return { locale: userLocale, source: 'user' };
  if (household) return { locale: household, source: 'household' };
  return { locale: 'en', source: 'default' };
}

/**
 * The household's prevailing locale, reading each member's preferences.
 *
 * Costs one member query plus one point read per member, so call it once per
 * household run and reuse the answer — do not call it per recipient. A failed
 * read returns null ("we could not tell"), which the caller must not confuse
 * with "the household has no preference": both fall back to English, but only
 * one of them is a fact.
 */
export async function resolveHouseholdEmailLocale(
  householdId: string
): Promise<EmailLocale | null> {
  try {
    const members = await householdService.getHouseholdMembers(householdId);
    const ordered = [...members].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
    const locales = await Promise.all(
      ordered.map(async (member) => {
        try {
          return (await notificationPrefs.getPreferences(member.userId)).emailLocale;
        } catch {
          return null;
        }
      })
    );
    return householdLocaleFrom(locales);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, householdId, msg: 'email_locale.household_read_failed' },
      'email_locale.household_read_failed'
    );
    return null;
  }
}

/**
 * Resolve the language ONE email to ONE recipient should be written in.
 *
 * This is the accessor other services should use. Pass `householdId` to
 * enable the household fallback; it costs a member fan-out, so a bulk sender
 * that already knows the household's language should pass it via
 * `resolveEmailLocale` instead.
 */
export async function resolveEmailLocaleForUser(
  userId: string,
  householdId?: string | null
): Promise<ResolvedLocale> {
  let userLocale: string | null;
  try {
    userLocale = (await notificationPrefs.getPreferences(userId)).emailLocale;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, userId, msg: 'email_locale.prefs_read_failed' },
      'email_locale.prefs_read_failed'
    );
    // English because it is all we can manage, and the source says so.
    return { locale: 'en', source: 'unavailable' };
  }
  if (isEmailLocale(userLocale)) return { locale: userLocale, source: 'user' };
  if (!householdId) return { locale: 'en', source: 'default' };
  return resolveEmailLocale(null, await resolveHouseholdEmailLocale(householdId));
}
