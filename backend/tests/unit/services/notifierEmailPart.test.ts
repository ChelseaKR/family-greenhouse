/**
 * A payload's `email` part (subject + both MIME parts) is for the email leg
 * only. The email leg must send exactly it; the push leg serializes its whole
 * payload to the push service, and tens of kilobytes of HTML would break
 * every web-push send, so it must never see it.
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
vi.mock('../../../src/services/smsNotifier.js', () => ({ sendSms: vi.fn(async () => true) }));
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
import * as smsNotifier from '../../../src/services/smsNotifier.js';
import type { NotificationPreferences } from '../../../src/services/notificationPrefs.js';

const ORIGINAL_ENV = process.env;

const prefs = {
  userId: 'u1',
  browser: true,
  email: true,
  sms: true,
  phone: '+15551234567',
  phoneVerified: true,
  dndStart: '',
  dndEnd: '',
  timezone: 'UTC',
  pestAlerts: false,
  weeklyDigest: true,
  updatedAt: '',
} as NotificationPreferences;

const HTML = `<!DOCTYPE html><html><body>${'x'.repeat(20_000)}</body></html>`;

const payload = {
  title: 'Plant care reminder: 2 overdue',
  body: '1. Monstera — water, 6 days overdue',
  shortBody: '2 overdue',
  url: 'https://familygreenhouse.net/tasks?filter=due',
  email: { subject: 'Water Monstera and 1 more', text: 'the text part', html: HTML },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    WEB_PUSH_VAPID_PUBLIC_KEY: 'pub',
    WEB_PUSH_VAPID_PRIVATE_KEY: 'priv',
  };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('notifier with a structured email part', () => {
  it('sends exactly the email part on the email leg and keeps it off push and SMS', async () => {
    const { sendToUser } = await import('../../../src/services/notifier.js');
    const result = await sendToUser({ userId: 'u1', email: 'ada@x.com' }, payload, {
      preferences: prefs,
    });

    expect(result.channels).toEqual({ browser: 'delivered', email: 'delivered', sms: 'delivered' });
    expect(vi.mocked(emailNotifier.sendEmailAccepted)).toHaveBeenCalledWith({
      to: 'ada@x.com',
      subject: 'Water Monstera and 1 more',
      text: 'the text part',
      html: HTML,
    });

    // Push: the compact body, the title, and nothing of the email rendering.
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const pushed = JSON.parse((sendNotification.mock.calls[0] as unknown[])[1] as string) as Record<
      string,
      unknown
    >;
    expect(pushed.title).toBe('Plant care reminder: 2 overdue');
    expect(pushed.body).toBe('2 overdue');
    expect(pushed).not.toHaveProperty('email');
    expect(JSON.stringify(pushed).length).toBeLessThan(1_000);

    // SMS: title + compact body, as before.
    expect(vi.mocked(smsNotifier.sendSms)).toHaveBeenCalledWith({
      to: '+15551234567',
      text: 'Plant care reminder: 2 overdue: 2 overdue',
    });
  });

  it('keeps the text-only email built from title, body and url when there is no email part', async () => {
    const { sendToUser } = await import('../../../src/services/notifier.js');
    const { email: _email, ...plain } = payload;
    await sendToUser({ userId: 'u1', email: 'ada@x.com' }, plain, { preferences: prefs });
    expect(vi.mocked(emailNotifier.sendEmailAccepted)).toHaveBeenCalledWith({
      to: 'ada@x.com',
      subject: 'Plant care reminder: 2 overdue',
      text: '1. Monstera — water, 6 days overdue\n\nhttps://familygreenhouse.net/tasks?filter=due',
    });
  });

  it('never logs the email part on a push dry run', async () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
    delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    const { sendToUser } = await import('../../../src/services/notifier.js');
    await sendToUser({ userId: 'u1', email: 'ada@x.com' }, payload, { preferences: prefs });
    const dryRun = loggerInfo.mock.calls.find(
      (c) => (c[0] as { msg?: string })?.msg === 'push_dry_run'
    );
    expect(dryRun).toBeDefined();
    expect(JSON.stringify(dryRun)).not.toContain('the text part');
    expect(JSON.stringify(dryRun)).not.toContain('<html>');
  });
});
