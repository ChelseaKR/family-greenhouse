/**
 * Matrix test for the notification dispatcher (`services/notifier.sendToUser`).
 *
 * Why this exists separately from `notificationPrefsDnd.test.ts`: the DND
 * helper is pure and well-covered. The risky thing is the *dispatcher* —
 * the part that decides which channels fire for a given (prefs × DND × time)
 * combination. A bug here is the kind that wakes a user at 3am with an SMS
 * and earns a one-star App Store review.
 *
 * Strategy: mock the three downstream senders (browser push, email, SMS)
 * with spies, run `sendToUser` over a matrix of cases, assert the right
 * spies fired the right number of times. Each case is a single line in a
 * table so adding a regression check is cheap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn((i) => ({ input: i, kind: 'Put' })),
  GetCommand: vi.fn((i) => ({ input: i, kind: 'Get' })),
  UpdateCommand: vi.fn((i) => ({ input: i, kind: 'Update' })),
  QueryCommand: vi.fn((i) => ({ input: i, kind: 'Query' })),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test',
}));

vi.mock('../../../src/services/emailNotifier.js', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/services/smsNotifier.js', () => ({
  sendSms: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/services/notificationPrefs.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/notificationPrefs.js')>(
    '../../../src/services/notificationPrefs.js'
  );
  return {
    ...actual,
    getPreferences: vi.fn(),
  };
});
// Browser push goes through the web-push library which we don't want to
// configure in tests. Stub the function on the notifier module itself
// so we can assert it without faking VAPID keys.

const RECIPIENT = { userId: 'u-1', email: 'a@example.com' };
const PAYLOAD = { title: 'Time to water', body: 'Your monstera is due.' };

interface PrefsOverride {
  browser?: boolean;
  email?: boolean;
  sms?: boolean;
  phone?: string;
  dndStart?: string;
  dndEnd?: string;
  timezone?: string;
  pestAlerts?: boolean;
}

function prefs(
  over: PrefsOverride = {}
): import('../../../src/services/notificationPrefs.js').NotificationPreferences {
  return {
    userId: 'u-1',
    browser: false,
    email: true,
    sms: false,
    phone: '',
    dndStart: '',
    dndEnd: '',
    timezone: 'UTC',
    pestAlerts: false,
    updatedAt: '',
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // `clearAllMocks` resets call history without nuking the
  // `mockResolvedValue` configuration on the email/sms/dynamo mocks.
  // `restoreAllMocks` would over-clear and break the next test.
  vi.clearAllMocks();
  vi.useRealTimers();
});

interface Row {
  name: string;
  prefs: PrefsOverride;
  /** Wall-clock the dispatcher will see (UTC ISO). */
  now: string;
  expect: { email: boolean; sms: boolean; browser: boolean };
}

const CASES: Row[] = [
  // — Channel selection —
  {
    name: 'email-only user gets email',
    prefs: { email: true },
    now: '2026-04-25T14:00:00Z',
    expect: { email: true, sms: false, browser: false },
  },
  {
    name: 'all channels off → nothing fires',
    prefs: { email: false, sms: false, browser: false },
    now: '2026-04-25T14:00:00Z',
    expect: { email: false, sms: false, browser: false },
  },
  {
    name: 'sms requires a phone number',
    prefs: { email: false, sms: true, phone: '' },
    now: '2026-04-25T14:00:00Z',
    expect: { email: false, sms: false, browser: false },
  },
  {
    name: 'sms with a phone number fires',
    prefs: { email: false, sms: true, phone: '+15551234567' },
    now: '2026-04-25T14:00:00Z',
    expect: { email: false, sms: true, browser: false },
  },
  // — DND suppresses email + SMS, never browser —
  {
    name: 'inside DND, email is suppressed',
    prefs: { email: true, dndStart: '13:00', dndEnd: '15:00' },
    now: '2026-04-25T14:00:00Z',
    expect: { email: false, sms: false, browser: false },
  },
  {
    name: 'inside DND, SMS is suppressed',
    prefs: { email: false, sms: true, phone: '+15551234567', dndStart: '13:00', dndEnd: '15:00' },
    now: '2026-04-25T14:00:00Z',
    expect: { email: false, sms: false, browser: false },
  },
  {
    name: 'browser fires inside DND (OS handles quiet hours)',
    prefs: { email: false, browser: true, dndStart: '13:00', dndEnd: '15:00' },
    now: '2026-04-25T14:00:00Z',
    expect: { email: false, sms: false, browser: true },
  },
  {
    name: 'just outside DND end → email fires',
    prefs: { email: true, dndStart: '13:00', dndEnd: '15:00' },
    now: '2026-04-25T15:00:00Z',
    expect: { email: true, sms: false, browser: false },
  },
  // — Wrap-past-midnight —
  {
    name: 'wrap-past-midnight: 23:30 is inside 22:00→07:00',
    prefs: { email: true, dndStart: '22:00', dndEnd: '07:00' },
    now: '2026-04-25T23:30:00Z',
    expect: { email: false, sms: false, browser: false },
  },
  {
    name: 'wrap-past-midnight: 03:00 is inside 22:00→07:00',
    prefs: { email: true, dndStart: '22:00', dndEnd: '07:00' },
    now: '2026-04-26T03:00:00Z',
    expect: { email: false, sms: false, browser: false },
  },
  {
    name: 'wrap-past-midnight: 12:00 is OUTSIDE 22:00→07:00',
    prefs: { email: true, dndStart: '22:00', dndEnd: '07:00' },
    now: '2026-04-25T12:00:00Z',
    expect: { email: true, sms: false, browser: false },
  },
  // — Timezone-aware DND. The user's clock is what matters, not UTC. —
  {
    name: 'America/New_York: 03:00 local (07:00 UTC) is inside 22:00→07:00',
    prefs: { email: true, dndStart: '22:00', dndEnd: '07:00', timezone: 'America/New_York' },
    now: '2026-04-25T07:00:00Z',
    expect: { email: false, sms: false, browser: false },
  },
  {
    name: 'America/New_York: 09:00 local (13:00 UTC) is OUTSIDE 22:00→07:00',
    prefs: { email: true, dndStart: '22:00', dndEnd: '07:00', timezone: 'America/New_York' },
    now: '2026-04-25T13:00:00Z',
    expect: { email: true, sms: false, browser: false },
  },
  {
    name: 'Asia/Tokyo: 23:00 local (14:00 UTC) is inside 22:00→07:00',
    prefs: { email: true, dndStart: '22:00', dndEnd: '07:00', timezone: 'Asia/Tokyo' },
    now: '2026-04-25T14:00:00Z',
    expect: { email: false, sms: false, browser: false },
  },
  // — Edge of the DND window —
  {
    name: 'exactly at DND end is OUTSIDE the window (half-open)',
    prefs: { email: true, dndStart: '13:00', dndEnd: '15:00' },
    now: '2026-04-25T15:00:00Z',
    expect: { email: true, sms: false, browser: false },
  },
  {
    name: 'exactly at DND start is INSIDE the window',
    prefs: { email: true, dndStart: '13:00', dndEnd: '15:00' },
    now: '2026-04-25T13:00:00Z',
    expect: { email: false, sms: false, browser: false },
  },
  // — Combined: multi-channel user partially suppressed by DND —
  {
    name: 'browser + email + sms with DND → only browser fires',
    prefs: {
      browser: true,
      email: true,
      sms: true,
      phone: '+15551234567',
      dndStart: '00:00',
      dndEnd: '23:59',
    },
    now: '2026-04-25T12:00:00Z',
    expect: { email: false, sms: false, browser: true },
  },
];

async function loadSendToUser(prefsOverride: PrefsOverride): Promise<{
  sendToUser: (typeof import('../../../src/services/notifier.js'))['sendToUser'];
  emailMock: ReturnType<typeof vi.fn>;
  smsMock: ReturnType<typeof vi.fn>;
  /** Number of attempts made to fan out browser push (proxied via the
   *  underlying DDB query for subscriptions). Zero means the dispatcher
   *  never reached the browser-push branch. */
  pushAttempts: () => number;
}> {
  const notifier = await import('../../../src/services/notifier.js');
  const emailNotifier = await import('../../../src/services/emailNotifier.js');
  const smsNotifier = await import('../../../src/services/smsNotifier.js');
  const prefsModule = await import('../../../src/services/notificationPrefs.js');
  const emailMock = emailNotifier.sendEmail as ReturnType<typeof vi.fn>;
  const smsMock = smsNotifier.sendSms as ReturnType<typeof vi.fn>;

  // Re-establish resolved-value behavior per-call. `vi.clearAllMocks` in
  // afterEach wipes call history; mock factories run once at module load.
  emailMock.mockResolvedValue(undefined);
  smsMock.mockResolvedValue(undefined);

  vi.mocked(prefsModule.getPreferences).mockResolvedValue(prefs(prefsOverride));

  // Browser-push fan-out reads subscriptions from DDB. Stub the query so
  // sendBrowserPush short-circuits cleanly with zero subscriptions; we
  // only need to know whether the dispatcher *reached* the browser branch.
  const dynamo = (await import('../../../src/utils/dynamodb.js')).dynamodb;
  vi.mocked(dynamo.send).mockResolvedValue({ Items: [] } as never);

  return {
    sendToUser: notifier.sendToUser,
    emailMock,
    smsMock,
    pushAttempts: () => vi.mocked(dynamo.send).mock.calls.length,
  };
}

describe('notifier.sendToUser — channel × DND × timezone matrix', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      vi.setSystemTime(new Date(c.now));
      const { sendToUser, emailMock, smsMock, pushAttempts } = await loadSendToUser(c.prefs);
      await sendToUser(RECIPIENT, PAYLOAD);

      expect(emailMock).toHaveBeenCalledTimes(c.expect.email ? 1 : 0);
      expect(smsMock).toHaveBeenCalledTimes(c.expect.sms ? 1 : 0);
      if (c.expect.browser) {
        expect(pushAttempts()).toBeGreaterThan(0);
      } else {
        expect(pushAttempts()).toBe(0);
      }
    });
  }
});
