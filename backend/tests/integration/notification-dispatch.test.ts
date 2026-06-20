/**
 * End-to-end integration test for the notification dispatcher.
 *
 * WHY THIS EXISTS
 * ---------------
 * `notifierMatrix.test.ts` exercises `notifier.sendToUser` in isolation with
 * the channel senders mocked at the *service* boundary and prefs hand-fed.
 * `notificationPrefsDnd.test.ts` covers the pure `isInDndWindow` helper. What
 * neither covers is the WHOLE dispatch path running over real data: the hourly
 * reminder scan (`reminders.remindHousehold`) reading real prefs rows out of
 * DynamoDB, fanning out through the real `notifier.sendToUser`, and hitting the
 * real `emailNotifier` / `smsNotifier` / web-push code — with only the outbound
 * AWS SDK / web-push boundary faked (exactly how the channel unit tests stub
 * `@aws-sdk/client-ses` / `client-sns`).
 *
 * This closes the gap flagged in the test strategy doc: "no real end-to-end
 * test of the full notification dispatcher running over varied user prefs"
 * (DND windows, per-channel opt-in, timezones, failure isolation).
 *
 * SETUP
 * -----
 * - DynamoDB is faked at the SDK level (./support/inMemoryDynamo.ts), so the
 *   real services run their real single-table queries against an in-memory
 *   table — same seam as real-handler.test.ts.
 * - SES / SNS / web-push are mocked at the SDK boundary and *configured on*
 *   (SES_FROM_EMAIL, SMS_NOTIFICATIONS_ENABLED=1, VAPID keys) so the channel
 *   code takes its real send path into the mocked client instead of dry-run
 *   logging. The mocks are what let us assert "which sends happened with which
 *   payloads".
 * - The clock is frozen with fake timers AND `now` is threaded into
 *   `remindHousehold`, so DND/timezone math is fully deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDynamo } from './support/inMemoryDynamo.js';
import { seedHousehold, seedPlant } from './support/seed.js';
import type { NotificationPreferences } from '../../src/services/notificationPrefs.js';

// --- Outbound boundary mocks ------------------------------------------------
// SES: capture every SendEmailCommand the real emailNotifier issues.
const sesSendMock = vi.fn();
vi.mock('@aws-sdk/client-ses', () => ({
  SESClient: vi.fn(function () {
    return { send: sesSendMock };
  }),
  SendEmailCommand: vi.fn(function (input) {
    return { input, kind: 'SendEmail' };
  }),
}));
// SNS: capture every PublishCommand the real smsNotifier issues.
const snsSendMock = vi.fn();
vi.mock('@aws-sdk/client-sns', () => ({
  SNSClient: vi.fn(function () {
    return { send: snsSendMock };
  }),
  PublishCommand: vi.fn(function (input) {
    return { input, kind: 'Publish' };
  }),
}));
// web-push: capture every browser push the real notifier issues. setVapidDetails
// is a no-op; sendNotification is the spy we assert on.
const webpushSendMock = vi.fn();
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: (...args: unknown[]) => webpushSendMock(...args),
  },
}));

// In-memory DynamoDB, shared across the run and cleared in beforeEach. The mock
// factory closes over `store` so every service import resolves to it.
const store = createInMemoryDynamo();
vi.mock('../../src/utils/dynamodb.js', () => ({
  dynamodb: store.client,
  TABLE_NAME: 'test-table',
}));

const ADMIN = { userId: 'user-admin', email: 'admin@example.com', name: 'Ada Admin' };

/**
 * Write a prefs row directly in the production row shape. We bypass
 * `setPreferences` deliberately: it rejects enabling SMS on an unverified
 * number, but the dispatcher path we're testing reads back `phoneVerified`, so
 * seeding the verified row is the realistic state for a user who already
 * completed verification. All other fields mirror what `setPreferences` writes.
 */
function seedPrefs(userId: string, over: Partial<NotificationPreferences>): void {
  const prefs: NotificationPreferences = {
    userId,
    browser: false,
    email: false,
    sms: false,
    phone: '',
    dndStart: '',
    dndEnd: '',
    timezone: 'UTC',
    pestAlerts: false,
    weeklyDigest: false,
    phoneVerified: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
  store.put({
    PK: `USER#${userId}`,
    SK: 'PREFS',
    entityType: 'NotificationPreferences',
    ...prefs,
  });
}

/** A browser-push subscription row in the shape pushSubscriptions writes. */
function seedPushSub(userId: string, householdId: string, endpoint: string): void {
  store.put({
    PK: `USER#${userId}`,
    SK: `PUSH#${endpoint}`, // SK uniqueness is all that matters for the query
    entityType: 'PushSubscription',
    userId,
    householdId,
    endpoint,
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

/**
 * Seed a household with the given members, one active plant, and one task due
 * now (unassigned, so it rolls up into EVERY member's reminder — which lets
 * each member's own prefs decide their channels independently). Returns the
 * household id.
 */
async function seedDueReminderHousehold(
  members: Array<{ userId: string; email: string; name: string }>,
  /** Explicit due time so the task is in-window regardless of the seed clock. */
  nextDue = '2026-04-25T00:00:00.000Z'
): Promise<string> {
  const { householdId } = await seedHousehold(store, { admin: ADMIN, members });
  const plant = await seedPlant(store, householdId, ADMIN.userId, { name: 'Monstera' });
  const taskService = await import('../../src/services/taskService.js');
  // Due at `nextDue`; every run uses a cutoff of now+24h, so the task is due.
  await taskService.createTask(
    { plantId: plant.id, type: 'water', frequency: 7, nextDue },
    householdId,
    ADMIN.userId,
    'Monstera'
  );
  return householdId;
}

/**
 * Wipe the per-user daily dedupe markers so a later same-UTC-day run isn't
 * skipped by `alreadyRemindedToday`. We issue a real DeleteCommand through the
 * store's client (which deletes by PK+SK) rather than re-keying the row — the
 * store keys rows by PK\0SK, so re-putting under a renamed key would leave the
 * original REMINDED# row in place and the marker would NOT actually clear.
 */
async function clearReminderMarkers(): Promise<void> {
  const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
  for (const row of store.all()) {
    if (typeof row.SK === 'string' && row.SK.startsWith('REMINDED#')) {
      await store.client.send(
        new DeleteCommand({
          TableName: 'test-table',
          Key: { PK: row.PK, SK: row.SK },
        }) as never
      );
    }
  }
}

/** The recipients that actually received an email / SMS / push this run. */
function emailRecipients(): string[] {
  return sesSendMock.mock.calls.map(
    (c) =>
      (c[0] as { input: { Destination: { ToAddresses: string[] } } }).input.Destination
        .ToAddresses[0]
  );
}
function smsRecipients(): string[] {
  return snsSendMock.mock.calls.map(
    (c) => (c[0] as { input: { PhoneNumber: string } }).input.PhoneNumber
  );
}
function pushRecipientEndpoints(): string[] {
  return webpushSendMock.mock.calls.map((c) => (c[0] as { endpoint: string }).endpoint);
}

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
  vi.useFakeTimers();
  // Configure all three channels ON so the real channel code takes its real
  // send path into the mocked SDK clients (rather than the dry-run log path).
  process.env = {
    ...ORIGINAL_ENV,
    SES_FROM_EMAIL: 'noreply@family-greenhouse.example',
    SMS_NOTIFICATIONS_ENABLED: '1',
    WEB_PUSH_VAPID_PUBLIC_KEY: 'test-public-key',
    WEB_PUSH_VAPID_PRIVATE_KEY: 'test-private-key',
    WEB_PUSH_VAPID_SUBJECT: 'mailto:test@family-greenhouse.example',
  };
  sesSendMock.mockResolvedValue({});
  snsSendMock.mockResolvedValue({});
  webpushSendMock.mockResolvedValue({});
});

afterEach(async () => {
  process.env = ORIGINAL_ENV;
  vi.useRealTimers();
  // The membership cache is keyed by user/household; reset so it can't bleed.
  const { __resetMembershipCacheForTests } = await import('../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
});

// Silence the pino logger noise from the dispatcher's structured-log lines.
const originalLog = console.log;
beforeEach(() => {
  console.log = () => {};
});
afterEach(() => {
  console.log = originalLog;
});

describe('notification dispatch (end-to-end) — channel opt-in matrix', () => {
  it('delivers on exactly the channels each user enabled, and none of the disabled ones', async () => {
    const emailOnly = { userId: 'u-email', email: 'email@x.com', name: 'Email Only' };
    const smsOnly = { userId: 'u-sms', email: 'sms@x.com', name: 'Sms Only' };
    const pushOnly = { userId: 'u-push', email: 'push@x.com', name: 'Push Only' };
    const allOn = { userId: 'u-all', email: 'all@x.com', name: 'All On' };
    const noneOn = { userId: 'u-none', email: 'none@x.com', name: 'None On' };

    const householdId = await seedDueReminderHousehold([
      emailOnly,
      smsOnly,
      pushOnly,
      allOn,
      noneOn,
    ]);

    seedPrefs(emailOnly.userId, { email: true });
    seedPrefs(smsOnly.userId, { sms: true, phone: '+15550000001', phoneVerified: true });
    seedPrefs(pushOnly.userId, { browser: true });
    seedPushSub(pushOnly.userId, householdId, 'https://push.example/push-only');
    seedPrefs(allOn.userId, {
      email: true,
      sms: true,
      phone: '+15550000002',
      phoneVerified: true,
      browser: true,
    });
    seedPushSub(allOn.userId, householdId, 'https://push.example/all-on');
    seedPrefs(noneOn.userId, { email: false, sms: false, browser: false });
    // The admin is the household creator and also a recipient of the
    // unassigned task; give it an explicit email-only pref row.
    seedPrefs(ADMIN.userId, { email: true });

    const reminders = await import('../../src/services/reminders.js');
    vi.setSystemTime(new Date('2026-04-25T14:00:00Z'));
    const sent = await reminders.remindHousehold(householdId, new Date('2026-04-25T14:00:00Z'));

    // Email goes to the email-only user, the all-channels user, and the admin.
    expect(emailRecipients().sort()).toEqual(
      ['admin@example.com', 'all@x.com', 'email@x.com'].sort()
    );
    // SMS goes to the SMS-only user and the all-channels user.
    expect(smsRecipients().sort()).toEqual(['+15550000001', '+15550000002'].sort());
    // Push goes to the push-only user and the all-channels user.
    expect(pushRecipientEndpoints().sort()).toEqual(
      ['https://push.example/all-on', 'https://push.example/push-only'].sort()
    );
    // The "none" user received nothing on any channel.
    expect(emailRecipients()).not.toContain('none@x.com');
    // Five reachable members got a reminder (everyone but `noneOn`).
    expect(sent).toBe(5);
  });

  it('skips SMS to an unverified phone but still emails the same user', async () => {
    const user = { userId: 'u-unverified', email: 'unverified@x.com', name: 'Unverified' };
    const householdId = await seedDueReminderHousehold([user]);
    seedPrefs(ADMIN.userId, { email: false }); // keep the assertion focused on `user`
    seedPrefs(user.userId, {
      email: true,
      sms: true,
      phone: '+15550000003',
      phoneVerified: false, // unverified → SMS suppressed, email still sends
    });

    const reminders = await import('../../src/services/reminders.js');
    vi.setSystemTime(new Date('2026-04-25T14:00:00Z'));
    await reminders.remindHousehold(householdId, new Date('2026-04-25T14:00:00Z'));

    expect(emailRecipients()).toContain('unverified@x.com');
    expect(smsRecipients()).toHaveLength(0);
  });
});

describe('notification dispatch (end-to-end) — DND windows', () => {
  it('suppresses email inside a same-day DND window, delivers just outside it', async () => {
    const a = { userId: 'u-dnd-a', email: 'a@x.com', name: 'Aaa' };
    const b = { userId: 'u-dnd-b', email: 'b@x.com', name: 'Bbb' };
    const householdId = await seedDueReminderHousehold([a, b]);
    seedPrefs(ADMIN.userId, { email: false });
    // Both users: email on, DND 13:00→15:00 UTC.
    seedPrefs(a.userId, { email: true, dndStart: '13:00', dndEnd: '15:00', timezone: 'UTC' });
    seedPrefs(b.userId, { email: true, dndStart: '13:00', dndEnd: '15:00', timezone: 'UTC' });

    const reminders = await import('../../src/services/reminders.js');

    // 14:00 UTC: both inside the window → suppressed.
    vi.setSystemTime(new Date('2026-04-25T14:00:00Z'));
    await reminders.remindHousehold(householdId, new Date('2026-04-25T14:00:00Z'));
    expect(emailRecipients()).toHaveLength(0);

    // 15:00 UTC == exactly DND end → half-open window means OUTSIDE → delivered.
    sesSendMock.mockClear();
    await clearReminderMarkers();
    vi.setSystemTime(new Date('2026-04-25T15:00:00Z'));
    await reminders.remindHousehold(householdId, new Date('2026-04-25T15:00:00Z'));
    expect(emailRecipients().sort()).toEqual(['a@x.com', 'b@x.com'].sort());
  });

  it('handles a DND window that wraps past midnight', async () => {
    const user = { userId: 'u-wrap', email: 'wrap@x.com', name: 'Wrap' };
    const householdId = await seedDueReminderHousehold([user]);
    seedPrefs(ADMIN.userId, { email: false });
    // 22:00 → 07:00 wraps midnight.
    seedPrefs(user.userId, { email: true, dndStart: '22:00', dndEnd: '07:00', timezone: 'UTC' });

    const reminders = await import('../../src/services/reminders.js');

    // 23:30 UTC is INSIDE the wrap window → suppressed.
    vi.setSystemTime(new Date('2026-04-25T23:30:00Z'));
    await reminders.remindHousehold(householdId, new Date('2026-04-25T23:30:00Z'));
    expect(emailRecipients()).toHaveLength(0);

    // 03:00 UTC (next day) is still INSIDE the wrap window → suppressed.
    sesSendMock.mockClear();
    await clearReminderMarkers();
    vi.setSystemTime(new Date('2026-04-26T03:00:00Z'));
    await reminders.remindHousehold(householdId, new Date('2026-04-26T03:00:00Z'));
    expect(emailRecipients()).toHaveLength(0);

    // 12:00 UTC is OUTSIDE the wrap window → delivered.
    sesSendMock.mockClear();
    await clearReminderMarkers();
    vi.setSystemTime(new Date('2026-04-26T12:00:00Z'));
    await reminders.remindHousehold(householdId, new Date('2026-04-26T12:00:00Z'));
    expect(emailRecipients()).toEqual(['wrap@x.com']);
  });
});

describe('notification dispatch (end-to-end) — timezone-aware DND', () => {
  it('the SAME UTC due-time lands inside DND for one tz and outside for another', async () => {
    // This is the "3am SMS because timezone math went wrong" failure mode.
    // Both users share an identical DND window (22:00 → 07:00 LOCAL) but live
    // in different timezones, so the same UTC instant resolves differently.
    const ny = { userId: 'u-ny', email: 'ny@x.com', name: 'New Yorker' };
    const tokyo = { userId: 'u-tokyo', email: 'tokyo@x.com', name: 'Tokyoite' };
    const householdId = await seedDueReminderHousehold([ny, tokyo]);
    seedPrefs(ADMIN.userId, { email: false });
    seedPrefs(ny.userId, {
      email: true,
      dndStart: '22:00',
      dndEnd: '07:00',
      timezone: 'America/New_York',
    });
    seedPrefs(tokyo.userId, {
      email: true,
      dndStart: '22:00',
      dndEnd: '07:00',
      timezone: 'Asia/Tokyo',
    });

    const reminders = await import('../../src/services/reminders.js');
    // 14:00 UTC == 10:00 New York (OUTSIDE window → deliver)
    //          == 23:00 Tokyo    (INSIDE  window → suppress)
    vi.setSystemTime(new Date('2026-04-25T14:00:00Z'));
    await reminders.remindHousehold(householdId, new Date('2026-04-25T14:00:00Z'));

    expect(emailRecipients()).toContain('ny@x.com'); // New York: daytime, delivered
    expect(emailRecipients()).not.toContain('tokyo@x.com'); // Tokyo: 11pm, suppressed
    expect(emailRecipients()).toEqual(['ny@x.com']);
  });
});

describe('notification dispatch (end-to-end) — failure injection / chaos', () => {
  it('keeps delivering other recipients/channels when one SES send throws mid-batch', async () => {
    // SES is rate-limited for the first recipient but fine afterwards. The
    // dispatcher must not abort the whole household's batch.
    const a = { userId: 'u-a', email: 'a@x.com', name: 'Alpha' };
    const b = { userId: 'u-b', email: 'b@x.com', name: 'Bravo' };
    const c = { userId: 'u-c', email: 'c@x.com', name: 'Charlie' };
    const householdId = await seedDueReminderHousehold([a, b, c]);
    seedPrefs(ADMIN.userId, { email: false });
    seedPrefs(a.userId, { email: true });
    seedPrefs(b.userId, { email: true });
    // Charlie also has SMS + push, so we can assert the OTHER channels still
    // fire even when their email leg fails.
    seedPrefs(c.userId, {
      email: true,
      sms: true,
      phone: '+15550000004',
      phoneVerified: true,
      browser: true,
    });
    seedPushSub(c.userId, householdId, 'https://push.example/charlie');

    // First SES send throws (Throttling); every later send succeeds.
    sesSendMock.mockReset();
    sesSendMock
      .mockRejectedValueOnce(
        Object.assign(new Error('Maximum sending rate exceeded'), { name: 'Throttling' })
      )
      .mockResolvedValue({});

    const reminders = await import('../../src/services/reminders.js');
    vi.setSystemTime(new Date('2026-04-25T14:00:00Z'));
    // Must not throw despite the injected SES failure.
    const sent = await reminders.remindHousehold(householdId, new Date('2026-04-25T14:00:00Z'));

    // SES was attempted for all three email-enabled members (one threw, two ok).
    expect(sesSendMock).toHaveBeenCalledTimes(3);
    // Charlie's OTHER channels are unaffected by his failed email leg.
    expect(smsRecipients()).toEqual(['+15550000004']);
    expect(pushRecipientEndpoints()).toEqual(['https://push.example/charlie']);
    // All three members are still counted as delivered: notifier.sendToUser
    // marks `delivered` when it *attempts* a send (the catch only logs), so a
    // throttled email does not roll the recipient back to undelivered.
    expect(sent).toBe(3);
  });

  it('isolates a thrown SMS send so the email of the same batch still goes out', async () => {
    const a = { userId: 'u-sms-fail', email: 'smsfail@x.com', name: 'SmsFail' };
    const b = { userId: 'u-email-ok', email: 'emailok@x.com', name: 'EmailOk' };
    const householdId = await seedDueReminderHousehold([a, b]);
    seedPrefs(ADMIN.userId, { email: false });
    seedPrefs(a.userId, { sms: true, phone: '+15550000005', phoneVerified: true });
    seedPrefs(b.userId, { email: true });

    snsSendMock.mockReset();
    snsSendMock.mockRejectedValue(
      Object.assign(new Error('SNS unavailable'), { name: 'InternalError' })
    );

    const reminders = await import('../../src/services/reminders.js');
    vi.setSystemTime(new Date('2026-04-25T14:00:00Z'));
    await expect(
      reminders.remindHousehold(householdId, new Date('2026-04-25T14:00:00Z'))
    ).resolves.toBeTypeOf('number');

    // SMS leg threw but was caught; the other member's email still delivered.
    expect(snsSendMock).toHaveBeenCalledTimes(1);
    expect(emailRecipients()).toEqual(['emailok@x.com']);
  });
});
