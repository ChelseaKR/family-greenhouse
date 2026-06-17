import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
  DeleteCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
  }),
}));

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

vi.mock('../../../src/services/smsNotifier.js', () => ({
  sendSms: vi.fn().mockResolvedValue(undefined),
}));

/** Route every Get to `storedItem` and record Puts; lets setPreferences do its
 *  read-then-write without scripting mockResolvedValueOnce sequences. */
async function mockStore(storedItem: Record<string, unknown> | undefined) {
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  const puts: Array<Record<string, unknown>> = [];
  vi.mocked(dynamodb.send).mockImplementation(async (cmd: unknown) => {
    const { kind, input } = cmd as { kind: string; input: Record<string, unknown> };
    if (kind === 'Get') return { Item: storedItem } as never;
    if (kind === 'Put') puts.push(input.Item as Record<string, unknown>);
    return {} as never;
  });
  return puts;
}

const BASE_INPUT = {
  userId: 'user-1',
  browser: false,
  email: true,
  sms: false,
  phone: '',
  dndStart: '',
  dndEnd: '',
  timezone: 'UTC',
  pestAlerts: false,
};

const STORED_VERIFIED = {
  userId: 'user-1',
  browser: false,
  email: true,
  sms: false,
  phone: '+15551234567',
  dndStart: '',
  dndEnd: '',
  timezone: 'UTC',
  pestAlerts: false,
  weeklyDigest: true,
  phoneVerified: true,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('notificationPrefs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getPreferences returns defaults when no row exists (weeklyDigest on, phone unverified)', async () => {
    await mockStore(undefined);
    const { getPreferences } = await import('../../../src/services/notificationPrefs.js');
    const result = await getPreferences('user-1');
    expect(result.userId).toBe('user-1');
    expect(result.email).toBe(true);
    expect(result.sms).toBe(false);
    expect(result.phone).toBe('');
    // weeklyDigest defaults ON because email defaults ON.
    expect(result.weeklyDigest).toBe(true);
    expect(result.phoneVerified).toBe(false);
  });

  it('getPreferences defaults weeklyDigest from the email channel for legacy rows', async () => {
    const { getPreferences } = await import('../../../src/services/notificationPrefs.js');

    // Legacy row (no weeklyDigest attribute), email ON → digest defaults ON.
    await mockStore({ ...STORED_VERIFIED, weeklyDigest: undefined, email: true });
    expect((await getPreferences('user-1')).weeklyDigest).toBe(true);

    // Legacy row, email OFF → digest defaults OFF (no email channel consent).
    await mockStore({ ...STORED_VERIFIED, weeklyDigest: undefined, email: false });
    expect((await getPreferences('user-1')).weeklyDigest).toBe(false);

    // Explicit opt-out wins even with email ON.
    await mockStore({ ...STORED_VERIFIED, weeklyDigest: false, email: true });
    expect((await getPreferences('user-1')).weeklyDigest).toBe(false);
  });

  it('setPreferences keeps the phone number when SMS is toggled off (verification lifecycle)', async () => {
    const puts = await mockStore(STORED_VERIFIED);
    const { setPreferences } = await import('../../../src/services/notificationPrefs.js');
    const updated = await setPreferences({ ...BASE_INPUT, sms: false, phone: '+15551234567' });
    expect(updated.phone).toBe('+15551234567');
    expect(updated.phoneVerified).toBe(true); // unchanged number stays verified
    expect(puts[0].phone).toBe('+15551234567');
  });

  it('setPreferences clears phoneVerified when the phone number changes', async () => {
    await mockStore(STORED_VERIFIED);
    const { setPreferences } = await import('../../../src/services/notificationPrefs.js');
    const updated = await setPreferences({ ...BASE_INPUT, phone: '+15559876543' });
    expect(updated.phoneVerified).toBe(false);
  });

  it('setPreferences clears phoneVerified when the phone is removed', async () => {
    await mockStore(STORED_VERIFIED);
    const { setPreferences } = await import('../../../src/services/notificationPrefs.js');
    const updated = await setPreferences({ ...BASE_INPUT, phone: '' });
    expect(updated.phoneVerified).toBe(false);
    expect(updated.phone).toBe('');
  });

  it('setPreferences rejects enabling SMS on an unverified number', async () => {
    await mockStore({ ...STORED_VERIFIED, phoneVerified: false, sms: false });
    const { setPreferences } = await import('../../../src/services/notificationPrefs.js');
    await expect(
      setPreferences({ ...BASE_INPUT, sms: true, phone: '+15551234567' })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('setPreferences allows enabling SMS once the number is verified', async () => {
    await mockStore(STORED_VERIFIED);
    const { setPreferences } = await import('../../../src/services/notificationPrefs.js');
    const updated = await setPreferences({ ...BASE_INPUT, sms: true, phone: '+15551234567' });
    expect(updated.sms).toBe(true);
    expect(updated.phoneVerified).toBe(true);
  });

  it('setPreferences grandfathers pre-verification rows that already had SMS on', async () => {
    // Stored row predates verification: sms on, same phone, never verified.
    await mockStore({ ...STORED_VERIFIED, phoneVerified: false, sms: true });
    const { setPreferences } = await import('../../../src/services/notificationPrefs.js');
    // Saving unrelated pref changes with sms still on must not 400…
    const updated = await setPreferences({
      ...BASE_INPUT,
      sms: true,
      phone: '+15551234567',
      pestAlerts: true,
    });
    expect(updated.sms).toBe(true);
    // …but the number remains unverified (delivery still skips it).
    expect(updated.phoneVerified).toBe(false);
  });

  it('setPreferences preserves the stored weeklyDigest when the client omits it', async () => {
    await mockStore({ ...STORED_VERIFIED, weeklyDigest: false });
    const { setPreferences } = await import('../../../src/services/notificationPrefs.js');
    const omitted = await setPreferences({ ...BASE_INPUT, phone: '+15551234567' });
    expect(omitted.weeklyDigest).toBe(false);
    const explicit = await setPreferences({
      ...BASE_INPUT,
      phone: '+15551234567',
      weeklyDigest: true,
    });
    expect(explicit.weeklyDigest).toBe(true);
  });

  it('setPreferences rejects an invalid IANA timezone with a 400', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { setPreferences } = await import('../../../src/services/notificationPrefs.js');
    await expect(
      setPreferences({ ...BASE_INPUT, timezone: 'Mars/Olympus_Mons' })
    ).rejects.toMatchObject({ statusCode: 400 });
    // Nothing written — the bad tz used to make reminder-time Intl throw.
    expect(dynamodb.send).not.toHaveBeenCalled();
  });

  it('setPreferences accepts a valid timezone and defaults empty to UTC', async () => {
    await mockStore(undefined);
    const { setPreferences } = await import('../../../src/services/notificationPrefs.js');
    const ny = await setPreferences({ ...BASE_INPUT, timezone: 'America/New_York' });
    expect(ny.timezone).toBe('America/New_York');
    const empty = await setPreferences({ ...BASE_INPUT, timezone: '' });
    expect(empty.timezone).toBe('UTC');
  });
});
