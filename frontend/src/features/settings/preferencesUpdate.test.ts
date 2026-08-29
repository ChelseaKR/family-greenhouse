import { describe, it, expect } from 'vitest';
import { buildPreferencesUpdate } from './preferencesUpdate';
import type { NotificationPreferences } from '@/services/notificationService';

function prefs(overrides: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return {
    userId: 'u1',
    browser: false,
    email: true,
    sms: false,
    smsAvailable: true,
    phone: '',
    dndStart: '',
    dndEnd: '',
    timezone: 'UTC',
    timezoneSet: false,
    pestAlerts: false,
    weeklyDigest: true,
    phoneVerified: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as NotificationPreferences;
}

describe('buildPreferencesUpdate', () => {
  it('adopts the browser zone when the server has never recorded one (#342)', () => {
    // The whole point: before this, every save that was not the quiet-hours
    // Save passed `current.timezone` — i.e. 'UTC' — straight back, so a user
    // who never opened quiet hours could never acquire a real zone no matter
    // how many other preferences they changed.
    const update = buildPreferencesUpdate(
      prefs({ timezone: 'UTC', timezoneSet: false }),
      { email: false },
      'America/Los_Angeles'
    );
    expect(update.timezone).toBe('America/Los_Angeles');
    expect(update.email).toBe(false);
  });

  it('never overwrites a zone the user actually chose', () => {
    const update = buildPreferencesUpdate(
      prefs({ timezone: 'Europe/Madrid', timezoneSet: true }),
      { email: false },
      'America/Los_Angeles'
    );
    expect(update.timezone).toBe('Europe/Madrid');
  });

  it('never overwrites a deliberately chosen UTC', () => {
    // The ambiguity that made this bug invisible: 'UTC' is both the default
    // nobody picked and a legitimate choice. `timezoneSet` is the only thing
    // that tells them apart.
    const update = buildPreferencesUpdate(
      prefs({ timezone: 'UTC', timezoneSet: true }),
      { pestAlerts: true },
      'America/Los_Angeles'
    );
    expect(update.timezone).toBe('UTC');
  });

  it('lets an explicit override win over both', () => {
    // The quiet-hours panel sends the zone the user picked in its dropdown.
    const update = buildPreferencesUpdate(
      prefs({ timezone: 'UTC', timezoneSet: false }),
      { timezone: 'Asia/Tokyo', dndStart: '22:00', dndEnd: '07:00' },
      'America/Los_Angeles'
    );
    expect(update.timezone).toBe('Asia/Tokyo');
  });

  it('still sends every field so a partial save cannot re-enable a channel', () => {
    const update = buildPreferencesUpdate(
      prefs({ sms: false, phone: '+15551234567', pestAlerts: true }),
      { email: false },
      'UTC'
    );
    expect(update).toMatchObject({
      browser: false,
      email: false,
      sms: false,
      phone: '+15551234567',
      pestAlerts: true,
      weeklyDigest: true,
    });
  });
});
