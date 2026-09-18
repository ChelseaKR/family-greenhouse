/**
 * The reminder's reply address (#667) is a bearer credential for the EMAIL
 * leg only. The browser leg serializes its whole payload to the push service
 * and logs it on a dry run, so the address must be stripped before either.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendNotification = vi.fn(async () => ({}));
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: (...a: unknown[]) => sendNotification(...(a as [])),
  },
}));
vi.mock('../../../src/services/pushSubscriptions.js', () => ({
  getUserSubscriptions: vi.fn(async () => [
    { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'k', auth: 'a' } },
  ]),
  isAllowedPushEndpoint: vi.fn(() => true),
  deleteSubscription: vi.fn(),
}));
vi.mock('../../../src/services/deviceTokens.js', () => ({
  getUserDeviceTokens: vi.fn(async () => []),
  deleteDeviceToken: vi.fn(),
}));
vi.mock('../../../src/services/fcmNotifier.js', () => ({ sendDevicePushMessages: vi.fn() }));
vi.mock('../../../src/services/smsNotifier.js', () => ({ sendSms: vi.fn() }));
vi.mock('../../../src/services/emailNotifier.js', () => ({
  sendEmailAccepted: vi.fn(async () => ({ accepted: true, reason: 'sent' })),
}));
const loggerInfo = vi.fn();
vi.mock('../../../src/utils/logger.js', () => ({
  logger: {
    info: (...a: unknown[]) => loggerInfo(...a),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import * as emailNotifier from '../../../src/services/emailNotifier.js';
import type { NotificationPreferences } from '../../../src/services/notificationPrefs.js';

const REPLY_TO = `care+${'a'.repeat(40)}@familygreenhouse.net`;
const ORIGINAL_ENV = process.env;

const prefs = {
  userId: 'u1',
  browser: true,
  email: true,
  sms: false,
  phone: '',
  dndStart: '',
  dndEnd: '',
  timezone: 'UTC',
  pestAlerts: false,
  weeklyDigest: true,
  phoneVerified: false,
  updatedAt: '',
} as NotificationPreferences;

const payload = {
  title: 'Plant care reminder',
  body: 'long body',
  shortBody: 'short',
  emailReplyTo: REPLY_TO,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('notifier with a reply address', () => {
  it('hands the address to the email leg and keeps it out of the push payload', async () => {
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = 'pub';
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = 'priv';
    const { sendToUser } = await import('../../../src/services/notifier.js');
    const result = await sendToUser({ userId: 'u1', email: 'ada@x.com' }, payload, {
      preferences: prefs,
    });

    expect(result.channels.email).toBe('delivered');
    expect(vi.mocked(emailNotifier.sendEmailAccepted)).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ada@x.com', replyTo: REPLY_TO })
    );
    // Control: the push leg really ran, so the absence below is meaningful.
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const pushed = JSON.parse((sendNotification.mock.calls[0] as unknown[])[1] as string);
    expect(pushed.body).toBe('short');
    expect(pushed).not.toHaveProperty('emailReplyTo');
    expect(JSON.stringify(pushed)).not.toContain(REPLY_TO);
  });

  it('never logs the address on a push dry run', async () => {
    delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
    delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    const { sendToUser } = await import('../../../src/services/notifier.js');
    await sendToUser({ userId: 'u1', email: 'ada@x.com' }, payload, { preferences: prefs });

    const dryRun = loggerInfo.mock.calls.find((c) => c[1] === 'push_dry_run');
    expect(dryRun).toBeDefined();
    expect(JSON.stringify(dryRun)).not.toContain(REPLY_TO);
  });

  it('sends no replyTo at all when the payload carries none', async () => {
    const { sendToUser } = await import('../../../src/services/notifier.js');
    await sendToUser(
      { userId: 'u1', email: 'ada@x.com' },
      { title: 't', body: 'b' },
      { preferences: { ...prefs, browser: false } }
    );
    const [message] = vi.mocked(emailNotifier.sendEmailAccepted).mock.calls[0];
    expect(message).not.toHaveProperty('replyTo');
  });
});
