import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/reminders.js', () => ({
  remindHousehold: vi.fn(async () => 3),
}));
vi.mock('../../../src/services/digest.js', () => ({
  digestHousehold: vi.fn(async () => 2),
  recapHousehold: vi.fn(async () => 4),
  defaultRecapYear: vi.fn(() => 2025),
}));
vi.mock('../../../src/services/pushSubscriptions.js', () => ({
  isAllowedPushEndpoint: vi.fn((endpoint: string) => {
    try {
      const url = new URL(endpoint);
      return url.protocol === 'https:' && url.hostname === 'fcm.googleapis.com';
    } catch {
      return false;
    }
  }),
  saveSubscription: vi.fn(async () => undefined),
  deleteSubscription: vi.fn(async () => 0),
}));
vi.mock('../../../src/services/notificationPrefs.js', () => ({
  getPreferences: vi.fn(),
  setPreferences: vi.fn(),
  isValidTimeZone: vi.fn((timezone: string) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
      return true;
    } catch {
      return false;
    }
  }),
  startPhoneVerification: vi.fn(async () => undefined),
  confirmPhoneVerification: vi.fn(async () => ({
    userId: 'user-1',
    phone: '+15551234567',
    phoneVerified: true,
  })),
}));
vi.mock('../../../src/services/emailSuppression.js', () => ({
  checkAddress: vi.fn(async () => ({ status: 'sendable' })),
  clearSuppression: vi.fn(async () => undefined),
}));
vi.mock('../../../src/services/householdService.js', () => ({
  getMemberByUserId: vi.fn(async () => ({
    householdId: 'hh-1',
    userId: 'user-1',
    name: 'Tester',
    email: 'a@b.com',
    role: 'admin',
    joinedAt: '',
  })),
}));

function buildEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/notifications/run-reminders',
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      authorizer: {
        claims: {
          sub: 'user-1',
          email: 'a@b.com',
          'custom:household_id': 'hh-1',
          'custom:household_role': 'admin',
        },
      },
      identity: { sourceIp: '127.0.0.1' },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

const ctx = {} as Context;

describe('notification browser subscription routes', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    __resetMembershipCacheForTests();
  });

  it('accepts a browser-issued HTTPS endpoint and persists it for this user', async () => {
    const push = await import('../../../src/services/pushSubscriptions.js');
    const { subscribe } = await import('../../../src/handlers/notifications/handler.js');
    const endpoint = 'https://fcm.googleapis.com/fcm/send/device-1';
    const res = (await subscribe(
      buildEvent({
        path: '/notifications/subscribe',
        body: JSON.stringify({
          endpoint,
          keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
        }),
      }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(push.saveSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', householdId: 'hh-1', endpoint })
    );
  });

  it('rejects internal or arbitrary push endpoints before any outbound credential is stored', async () => {
    const push = await import('../../../src/services/pushSubscriptions.js');
    const { subscribe } = await import('../../../src/handlers/notifications/handler.js');

    for (const endpoint of [
      'https://169.254.169.254/latest/meta-data',
      'http://fcm.googleapis.com/fcm/send/no-tls',
      'https://attacker.example/slow',
    ]) {
      const res = (await subscribe(
        buildEvent({
          path: '/notifications/subscribe',
          body: JSON.stringify({
            endpoint,
            keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
          }),
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(400);
    }
    expect(push.saveSubscription).not.toHaveBeenCalled();
  });

  it('returns the remaining device count after unsubscribing this endpoint', async () => {
    const push = await import('../../../src/services/pushSubscriptions.js');
    const { unsubscribe } = await import('../../../src/handlers/notifications/handler.js');
    const endpoint = 'https://fcm.googleapis.com/fcm/send/device-1';
    vi.mocked(push.deleteSubscription).mockResolvedValueOnce(2);

    const res = (await unsubscribe(
      buildEvent({
        path: '/notifications/unsubscribe',
        body: JSON.stringify({ endpoint }),
      }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, remainingSubscriptions: 2 });
    expect(push.deleteSubscription).toHaveBeenCalledWith('user-1', endpoint);
  });
});

describe('notifications runReminders', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SMS_NOTIFICATIONS_ENABLED = '1';
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    __resetMembershipCacheForTests();
    const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
    __resetRateLimitForTests();
  });

  it('lets an admin trigger reminders, then rate limits at 2/hour', async () => {
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    const { runReminders } = await import('../../../src/handlers/notifications/handler.js');

    for (let i = 0; i < 2; i++) {
      const res = (await runReminders(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ sent: 3 });
    }
    const res = (await runReminders(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(429);
    // The third call must not fan out notifications.
    expect(remindHousehold).toHaveBeenCalledTimes(2);
  });

  it('still rejects non-admin members with 403', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    const { runReminders } = await import('../../../src/handlers/notifications/handler.js');
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce({
      householdId: 'hh-1',
      userId: 'user-1',
      name: 'Tester',
      email: 'a@b.com',
      role: 'member',
      joinedAt: '',
    });

    const res = (await runReminders(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(403);
    expect(remindHousehold).not.toHaveBeenCalled();
  });
});

describe('notifications runDigests', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    __resetMembershipCacheForTests();
    const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
    __resetRateLimitForTests();
  });

  it('lets an admin trigger the weekly digest, then rate limits at 2/hour', async () => {
    const { digestHousehold } = await import('../../../src/services/digest.js');
    const { runDigests } = await import('../../../src/handlers/notifications/handler.js');
    const event = () => buildEvent({ path: '/notifications/run-digests' });

    for (let i = 0; i < 2; i++) {
      const res = (await runDigests(event(), ctx, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ sent: 2 });
    }
    const res = (await runDigests(event(), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(429);
    expect(digestHousehold).toHaveBeenCalledTimes(2);
    expect(vi.mocked(digestHousehold).mock.calls[0][0]).toBe('hh-1');
  });

  it('rejects non-admin members with 403', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    const { runDigests } = await import('../../../src/handlers/notifications/handler.js');
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce({
      householdId: 'hh-1',
      userId: 'user-1',
      name: 'Tester',
      email: 'a@b.com',
      role: 'member',
      joinedAt: '',
    });

    const res = (await runDigests(
      buildEvent({ path: '/notifications/run-digests' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(403);
    expect(digestHousehold).not.toHaveBeenCalled();
  });
});

describe('notifications runYearRecap', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    __resetMembershipCacheForTests();
    const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
    __resetRateLimitForTests();
  });

  it('recaps an explicit year for the admin household', async () => {
    const { recapHousehold } = await import('../../../src/services/digest.js');
    const { runYearRecap } = await import('../../../src/handlers/notifications/handler.js');

    const res = (await runYearRecap(
      buildEvent({ path: '/notifications/run-year-recap', body: JSON.stringify({ year: 2024 }) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ sent: 4, year: 2024 });
    expect(recapHousehold).toHaveBeenCalledWith('hh-1', 2024);
  });

  it('defaults to the previous calendar year when no body is sent', async () => {
    const { recapHousehold } = await import('../../../src/services/digest.js');
    const { runYearRecap } = await import('../../../src/handlers/notifications/handler.js');

    const res = (await runYearRecap(
      buildEvent({ path: '/notifications/run-year-recap', body: null }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ sent: 4, year: 2025 });
    expect(recapHousehold).toHaveBeenCalledWith('hh-1', 2025);
  });

  it('rate limits at 2/hour per admin', async () => {
    const { recapHousehold } = await import('../../../src/services/digest.js');
    const { runYearRecap } = await import('../../../src/handlers/notifications/handler.js');
    const event = () => buildEvent({ path: '/notifications/run-year-recap', body: null });

    for (let i = 0; i < 2; i++) {
      const res = (await runYearRecap(event(), ctx, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
    }
    const res = (await runYearRecap(event(), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(429);
    expect(recapHousehold).toHaveBeenCalledTimes(2);
  });
});

describe('notifications phone verification routes', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SMS_NOTIFICATIONS_ENABLED = '1';
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    __resetMembershipCacheForTests();
    const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
    __resetRateLimitForTests();
  });

  it('start-verification kicks off the flow, then rate limits at 3/hour per user', async () => {
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const { startPhoneVerification } =
      await import('../../../src/handlers/notifications/handler.js');
    const event = () =>
      buildEvent({
        path: '/notifications/phone/start-verification',
        body: JSON.stringify({ phone: '+15551234567' }),
      });

    for (let i = 0; i < 3; i++) {
      const res = (await startPhoneVerification(event(), ctx, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ sent: true });
    }
    const res = (await startPhoneVerification(event(), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(429);
    // The fourth call must not burn another SMS.
    expect(prefs.startPhoneVerification).toHaveBeenCalledTimes(3);
    expect(vi.mocked(prefs.startPhoneVerification).mock.calls[0].slice(0, 2)).toEqual([
      'user-1',
      '+15551234567',
    ]);
  });

  it('start-verification rejects non-E.164 phones with a 400 validation error', async () => {
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const { startPhoneVerification } =
      await import('../../../src/handlers/notifications/handler.js');
    const res = (await startPhoneVerification(
      buildEvent({
        path: '/notifications/phone/start-verification',
        body: JSON.stringify({ phone: '555-1234' }),
      }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toBe('Validation failed');
    expect(prefs.startPhoneVerification).not.toHaveBeenCalled();
  });

  it('fails fast without writing verification state when SMS delivery is unavailable', async () => {
    process.env.SMS_NOTIFICATIONS_ENABLED = '';
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const { startPhoneVerification } =
      await import('../../../src/handlers/notifications/handler.js');
    const res = (await startPhoneVerification(
      buildEvent({
        path: '/notifications/phone/start-verification',
        body: JSON.stringify({ phone: '+15551234567' }),
      }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).message).toMatch(/not available/i);
    expect(prefs.startPhoneVerification).not.toHaveBeenCalled();
  });

  it('publishes SMS capability and blocks a new opt-in while delivery is disabled', async () => {
    process.env.SMS_NOTIFICATIONS_ENABLED = '';
    const prefs = await import('../../../src/services/notificationPrefs.js');
    vi.mocked(prefs.getPreferences).mockResolvedValue({
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
      updatedAt: '2026-07-16T00:00:00.000Z',
    });
    const { getPrefs, updatePrefs } =
      await import('../../../src/handlers/notifications/handler.js');

    const read = (await getPrefs(
      buildEvent({ httpMethod: 'GET', path: '/notifications/prefs' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(JSON.parse(read.body).smsAvailable).toBe(false);

    const update = (await updatePrefs(
      buildEvent({
        httpMethod: 'PUT',
        path: '/notifications/prefs',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          browser: false,
          email: true,
          sms: true,
          phone: '+15551234567',
          dndStart: '',
          dndEnd: '',
          timezone: 'UTC',
          pestAlerts: false,
          weeklyDigest: true,
        }),
      }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(update.statusCode).toBe(503);
    expect(prefs.setPreferences).not.toHaveBeenCalled();
  });

  it('rejects half-configured quiet hours before persisting preferences', async () => {
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const { updatePrefs } = await import('../../../src/handlers/notifications/handler.js');
    const res = (await updatePrefs(
      buildEvent({
        httpMethod: 'PUT',
        path: '/notifications/prefs',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          browser: false,
          email: true,
          sms: false,
          phone: '',
          dndStart: '22:00',
          dndEnd: '',
          timezone: 'UTC',
          pestAlerts: false,
          weeklyDigest: true,
        }),
      }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(400);
    expect(prefs.setPreferences).not.toHaveBeenCalled();
  });

  it('rejects an unknown IANA timezone before persisting preferences', async () => {
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const { updatePrefs } = await import('../../../src/handlers/notifications/handler.js');
    const res = (await updatePrefs(
      buildEvent({
        httpMethod: 'PUT',
        path: '/notifications/prefs',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          browser: false,
          email: true,
          sms: false,
          phone: '',
          dndStart: '22:00',
          dndEnd: '07:00',
          timezone: 'Not/A_Timezone',
          pestAlerts: false,
          weeklyDigest: true,
        }),
      }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toBe('Validation failed');
    expect(prefs.setPreferences).not.toHaveBeenCalled();
  });

  it('confirm-verification returns the updated (verified) prefs', async () => {
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const { confirmPhoneVerification } =
      await import('../../../src/handlers/notifications/handler.js');
    const res = (await confirmPhoneVerification(
      buildEvent({
        path: '/notifications/phone/confirm-verification',
        body: JSON.stringify({ code: '123456' }),
      }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      phoneVerified: true,
      phone: '+15551234567',
      smsAvailable: true,
    });
    expect(prefs.confirmPhoneVerification).toHaveBeenCalledWith('user-1', '123456');
  });

  it('confirm-verification rejects malformed codes before hitting the service', async () => {
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const { confirmPhoneVerification } =
      await import('../../../src/handlers/notifications/handler.js');
    const res = (await confirmPhoneVerification(
      buildEvent({
        path: '/notifications/phone/confirm-verification',
        body: JSON.stringify({ code: 'abc123' }),
      }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
    expect(prefs.confirmPhoneVerification).not.toHaveBeenCalled();
  });
});

describe('notifications email deliverability', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    __resetMembershipCacheForTests();
    const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
    __resetRateLimitForTests();
    // clearAllMocks wipes the module factory's default; restore the healthy
    // baseline so each test opts INTO the failure it is about.
    const suppression = await import('../../../src/services/emailSuppression.js');
    vi.mocked(suppression.checkAddress).mockResolvedValue({ status: 'sendable' });
  });

  async function readPrefs() {
    const { getPrefs } = await import('../../../src/handlers/notifications/handler.js');
    return (await getPrefs(
      buildEvent({ httpMethod: 'GET', path: '/notifications/prefs' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
  }

  it("reports the caller's own suppression, with the reason, alongside their prefs", async () => {
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const suppression = await import('../../../src/services/emailSuppression.js');
    vi.mocked(prefs.getPreferences).mockResolvedValue({ userId: 'user-1', email: true } as never);
    vi.mocked(suppression.checkAddress).mockResolvedValue({
      status: 'suppressed',
      state: { email: 'a@b.com', state: 'suppressed', reason: 'complaint' },
    } as never);

    const res = await readPrefs();
    const body = JSON.parse(res.body);
    // The `email` toggle still reads true — that is exactly the state these
    // two fields exist to make visible.
    expect(body.email).toBe(true);
    expect(body.emailStatus).toBe('undeliverable');
    expect(body.emailSuppressionReason).toBe('complaint');
    expect(suppression.checkAddress).toHaveBeenCalledWith('a@b.com');
  });

  it('reports `unknown` — not `ok` — when the suppression store cannot be read', async () => {
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const suppression = await import('../../../src/services/emailSuppression.js');
    vi.mocked(prefs.getPreferences).mockResolvedValue({ userId: 'user-1', email: true } as never);
    vi.mocked(suppression.checkAddress).mockResolvedValue({
      status: 'unknown',
      reason: 'lookup_failed',
    } as never);

    const body = JSON.parse((await readPrefs()).body);
    expect(body.emailStatus).toBe('unknown');
    expect(body.emailSuppressionReason).toBeNull();
  });

  it("clears the suppression for the CALLER'S address, taken from the session", async () => {
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const suppression = await import('../../../src/services/emailSuppression.js');
    const { clearEmailSuppression } =
      await import('../../../src/handlers/notifications/handler.js');
    vi.mocked(prefs.getPreferences).mockResolvedValue({ userId: 'user-1', email: true } as never);

    const res = (await clearEmailSuppression(
      buildEvent({
        httpMethod: 'DELETE',
        path: '/notifications/email-suppression',
        // A body naming somebody else's address must be irrelevant: the
        // handler reads the address from the verified claims, never the body.
        body: JSON.stringify({ email: 'victim@elsewhere.com' }),
      }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(suppression.clearSuppression).toHaveBeenCalledWith('a@b.com', 'user-1');
    expect(JSON.parse(res.body).emailStatus).toBe('ok');
  });

  it('rate limits un-suppression at 5/hour so a bounce loop cannot be driven', async () => {
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const { clearEmailSuppression } =
      await import('../../../src/handlers/notifications/handler.js');
    vi.mocked(prefs.getPreferences).mockResolvedValue({ userId: 'user-1', email: true } as never);

    const call = () =>
      clearEmailSuppression(
        buildEvent({ httpMethod: 'DELETE', path: '/notifications/email-suppression' }),
        ctx,
        () => {}
      ) as Promise<APIGatewayProxyResult>;

    for (let i = 0; i < 5; i++) expect((await call()).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(429);
  });
});
