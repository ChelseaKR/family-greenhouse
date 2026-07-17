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
vi.mock('../../../src/services/notificationPrefs.js', () => ({
  getPreferences: vi.fn(),
  setPreferences: vi.fn(),
  startPhoneVerification: vi.fn(async () => undefined),
  confirmPhoneVerification: vi.fn(async () => ({
    userId: 'user-1',
    phone: '+15551234567',
    phoneVerified: true,
  })),
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
