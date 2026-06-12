import { describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn((i) => ({ input: i, kind: 'Put' })),
  GetCommand: vi.fn((i) => ({ input: i, kind: 'Get' })),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test',
}));

describe('isInDndWindow', () => {
  it('returns false when the window is empty', async () => {
    const { isInDndWindow } = await import('../../../src/services/notificationPrefs.js');
    expect(
      isInDndWindow(
        {
          userId: 'u',
          browser: false,
          email: true,
          sms: false,
          phone: '',
          dndStart: '',
          dndEnd: '',
          timezone: 'UTC',
          updatedAt: '',
        },
        new Date('2026-04-25T03:00:00Z')
      )
    ).toBe(false);
  });

  it('treats a same-day window correctly', async () => {
    const { isInDndWindow } = await import('../../../src/services/notificationPrefs.js');
    const prefs = {
      userId: 'u',
      browser: false,
      email: true,
      sms: false,
      phone: '',
      dndStart: '13:00',
      dndEnd: '15:00',
      timezone: 'UTC',
      updatedAt: '',
    };
    expect(isInDndWindow(prefs, new Date('2026-04-25T14:30:00Z'))).toBe(true);
    expect(isInDndWindow(prefs, new Date('2026-04-25T15:00:00Z'))).toBe(false);
    expect(isInDndWindow(prefs, new Date('2026-04-25T12:59:00Z'))).toBe(false);
  });

  it('handles wrap-past-midnight windows', async () => {
    const { isInDndWindow } = await import('../../../src/services/notificationPrefs.js');
    const prefs = {
      userId: 'u',
      browser: false,
      email: true,
      sms: false,
      phone: '',
      dndStart: '22:00',
      dndEnd: '07:00',
      timezone: 'UTC',
      updatedAt: '',
    };
    expect(isInDndWindow(prefs, new Date('2026-04-25T23:30:00Z'))).toBe(true);
    expect(isInDndWindow(prefs, new Date('2026-04-26T03:00:00Z'))).toBe(true);
    expect(isInDndWindow(prefs, new Date('2026-04-26T07:00:00Z'))).toBe(false);
    expect(isInDndWindow(prefs, new Date('2026-04-25T15:00:00Z'))).toBe(false);
  });

  it('respects the user timezone', async () => {
    const { isInDndWindow } = await import('../../../src/services/notificationPrefs.js');
    // 22:00–07:00 New York time. UTC 03:00 = NY 23:00 in EDT.
    const prefs = {
      userId: 'u',
      browser: false,
      email: true,
      sms: false,
      phone: '',
      dndStart: '22:00',
      dndEnd: '07:00',
      timezone: 'America/New_York',
      updatedAt: '',
    };
    expect(isInDndWindow(prefs, new Date('2026-04-25T03:00:00Z'))).toBe(true);
    // UTC 18:00 = NY 14:00 EDT — well outside DND.
    expect(isInDndWindow(prefs, new Date('2026-04-25T18:00:00Z'))).toBe(false);
  });

  it('falls back to "not in DND" instead of throwing on a corrupt timezone', async () => {
    const { isInDndWindow } = await import('../../../src/services/notificationPrefs.js');
    // Legacy rows could hold any string; Intl throws on unknown zones, which
    // used to abort the household's whole reminder run.
    const prefs = {
      userId: 'u',
      browser: false,
      email: true,
      sms: false,
      phone: '',
      dndStart: '22:00',
      dndEnd: '07:00',
      timezone: 'Not/A_Zone',
      updatedAt: '',
    };
    expect(isInDndWindow(prefs, new Date('2026-04-26T03:00:00Z'))).toBe(false);
  });
});
