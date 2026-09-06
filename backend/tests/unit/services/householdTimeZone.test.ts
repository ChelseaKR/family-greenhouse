import { describe, it, expect } from 'vitest';
import {
  HOUSEHOLD_TIMEZONE_UNSET,
  hasHouseholdTimeZone,
  normalizeHouseholdTimeZone,
} from '../../../src/services/householdTimeZone.js';
import { isValidTimeZone } from '../../../src/utils/timeZone.js';

describe('householdTimeZone', () => {
  describe('normalizeHouseholdTimeZone', () => {
    it.each([
      'America/New_York',
      'Europe/London',
      'Asia/Kolkata',
      'Australia/Lord_Howe',
      'Pacific/Chatham',
      'UTC',
    ])('passes through the valid IANA name %s unchanged', (tz) => {
      expect(normalizeHouseholdTimeZone(tz)).toBe(tz);
    });

    it.each([
      // Absent: what every household in the table looks like today.
      [undefined, 'absent'],
      [null, 'null'],
      ['', 'empty string'],
      // Wrong type: a hand-edited or mis-migrated row.
      [0, 'a number'],
      [42, 'a non-zero number'],
      [true, 'a boolean'],
      [{ timezone: 'America/New_York' }, 'an object'],
      [['America/New_York'], 'an array'],
      // Plausible-looking but not a zone the runtime resolves. A regex over
      // `Area/Location` would accept all of these.
      ['America/Nowhere', 'a fake Area/Location name'],
      ['EST5EDT4', 'a malformed POSIX-looking name'],
      ['America/New York', 'a space where the underscore belongs'],
      ['not a timezone', 'free text'],
    ])('reads %o (%s) as unset', (raw) => {
      expect(normalizeHouseholdTimeZone(raw)).toBe(HOUSEHOLD_TIMEZONE_UNSET);
    });

    it('never invents a zone: unset is the empty string, not UTC', () => {
      // The whole point of the field. `NotificationPreferences.timezone`
      // defaults to 'UTC', which is why a user who never opened quiet hours
      // was indistinguishable from one who chose UTC (#342). Collapsing the
      // two here would destroy the only signal ADR 0025's cutover has.
      expect(normalizeHouseholdTimeZone(undefined)).toBe('');
      expect(normalizeHouseholdTimeZone(undefined)).not.toBe('UTC');
    });

    it('keeps a household that chose UTC distinguishable from one never asked', () => {
      expect(hasHouseholdTimeZone('UTC')).toBe(true);
      expect(hasHouseholdTimeZone(undefined)).toBe(false);
      expect(normalizeHouseholdTimeZone('UTC')).not.toBe(normalizeHouseholdTimeZone(undefined));
    });

    it('is idempotent, so a value can be normalised on read and on write', () => {
      for (const raw of ['America/New_York', '', 'America/Nowhere', undefined]) {
        const once = normalizeHouseholdTimeZone(raw);
        expect(normalizeHouseholdTimeZone(once)).toBe(once);
      }
    });

    it('validates on READ, not only on write — a retired name degrades to unset', () => {
      // Zone names get retired upstream, so a value that was valid when saved
      // can stop resolving without anyone touching the row. `Intl` THROWS on
      // the bad name rather than returning something falsy, which is how a bad
      // stored prefs zone used to abort a whole household's reminder run.
      // Normalising on the read path means the due-date math ADR 0025
      // describes never has to catch that.
      expect(isValidTimeZone('America/Nowhere')).toBe(false);
      expect(() => normalizeHouseholdTimeZone('America/Nowhere')).not.toThrow();
      expect(normalizeHouseholdTimeZone('America/Nowhere')).toBe(HOUSEHOLD_TIMEZONE_UNSET);
    });
  });

  describe('isValidTimeZone (moved to utils/timeZone.ts, re-exported unchanged)', () => {
    it('still answers under its old name on notificationPrefs', async () => {
      // The move must be invisible to `handlers/notifications/handler.ts` and
      // `services/billingEmails.ts`, which both call it by that name.
      const notificationPrefs = await import('../../../src/services/notificationPrefs.js');
      expect(notificationPrefs.isValidTimeZone).toBe(isValidTimeZone);
      expect(notificationPrefs.isValidTimeZone('America/New_York')).toBe(true);
      expect(notificationPrefs.isValidTimeZone('America/Nowhere')).toBe(false);
    });

    it('accepts link names that Intl.supportedValuesOf omits', () => {
      // The fallback branch is load-bearing, not defensive padding: these
      // resolve but are not in the canonical list on most runtimes.
      expect(isValidTimeZone('Etc/GMT+5')).toBe(true);
      expect(isValidTimeZone('US/Pacific')).toBe(true);
    });
  });
});
