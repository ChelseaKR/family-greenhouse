/**
 * The household chat-channel routes (#674), through the real middy stack:
 * admin-only, the cross-household guard, the 503 when the environment has no
 * sealing key, and — the load-bearing one — that no response ever carries the
 * webhook address back out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/householdChannelStore.js', () => ({
  getChannel: vi.fn(),
  deleteChannel: vi.fn(),
}));
vi.mock('../../../src/services/householdChannel.js', () => ({
  saveChannel: vi.fn(),
  sendTestPost: vi.fn(),
}));
vi.mock('../../../src/utils/auditLog.js', () => ({ audit: vi.fn() }));

const ctx = {} as Context;
const DISCORD =
  'https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefghijklmnopqrstuvwx';

const RECORD = {
  householdId: 'hh-1',
  platform: 'discord',
  sealedUrl: 'AQICAHh-sealed',
  urlVersion: 'v1',
  host: 'discord.com',
  last4: 'uvwx',
  events: { dailyDue: true, upForGrabs: false },
  quietStart: '',
  quietEnd: '',
  timezone: 'America/New_York',
  locale: 'en',
  status: 'active',
  disabledReason: null,
  consecutiveFailures: 0,
  consecutiveClientErrors: 0,
  nextAttemptAt: null,
  lastFailure: null,
  lastDeliveredAt: null,
  lastTestAt: null,
  connectedBy: 'user-1',
  connectedAt: '2026-09-18T00:00:00.000Z',
  updatedAt: '2026-09-18T00:00:00.000Z',
};

const SAVE_BODY = {
  platform: 'discord',
  url: DISCORD,
  events: { dailyDue: true, upForGrabs: false },
  quietStart: '',
  quietEnd: '',
  timezone: 'America/New_York',
  locale: 'en',
};

function claims(role: 'admin' | 'member') {
  return {
    sub: 'user-1',
    email: 'a@b.com',
    'custom:household_id': 'hh-1',
    'custom:household_role': role,
  };
}

function event(
  overrides: Partial<APIGatewayProxyEvent> = {},
  role: 'admin' | 'member' = 'admin'
): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/households/hh-1/channel',
    pathParameters: { id: 'hh-1' },
    queryStringParameters: null,
    requestContext: {
      identity: { sourceIp: '10.3.0.1' },
      authorizer: { claims: claims(role) },
    } as unknown as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

async function handlers() {
  return import('../../../src/handlers/households/channelNotifier.js');
}

beforeEach(async () => {
  vi.clearAllMocks();
  const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
  __resetRateLimitForTests();
  const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
  const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
  setCachedMembership('user-1', 'hh-1', 'admin');
  process.env.CHANNEL_WEBHOOK_KMS_KEY_ID = 'alias/test';
});

afterEach(() => {
  delete process.env.CHANNEL_WEBHOOK_KMS_KEY_ID;
});

describe('GET /households/{id}/channel', () => {
  it('returns the masked summary, never the address or its ciphertext', async () => {
    const store = await import('../../../src/services/householdChannelStore.js');
    vi.mocked(store.getChannel).mockResolvedValue(RECORD as never);
    const { getHouseholdChannel } = await handlers();
    const res = (await getHouseholdChannel(event(), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.available).toBe(true);
    expect(body.channel.maskedUrl).toBe('discord.com/…uvwx');
    expect(res.body).not.toContain('AQICAHh');
    expect(res.body).not.toContain('123456789012345678');
    expect(res.body).not.toContain('user-1');
  });

  it('says "not available" when the environment has no sealing key', async () => {
    delete process.env.CHANNEL_WEBHOOK_KMS_KEY_ID;
    const store = await import('../../../src/services/householdChannelStore.js');
    vi.mocked(store.getChannel).mockResolvedValue(null);
    const { getHouseholdChannel } = await handlers();
    const res = (await getHouseholdChannel(event(), ctx, () => {})) as APIGatewayProxyResult;
    expect(JSON.parse(res.body)).toEqual({ available: false, channel: null });
  });

  it('a failed read is a 5xx, never "not connected"', async () => {
    const store = await import('../../../src/services/householdChannelStore.js');
    vi.mocked(store.getChannel).mockRejectedValue(new Error('ddb down'));
    const { getHouseholdChannel } = await handlers();
    const res = (await getHouseholdChannel(event(), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(500);
  });

  it('is admin-only', async () => {
    const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
    setCachedMembership('user-1', 'hh-1', 'member');
    const { getHouseholdChannel } = await handlers();
    const res = (await getHouseholdChannel(
      event({}, 'member'),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(403);
  });

  it('refuses another household’s id', async () => {
    const { getHouseholdChannel } = await handlers();
    const res = (await getHouseholdChannel(
      event({ pathParameters: { id: 'hh-other' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(403);
  });
});

describe('PUT /households/{id}/channel', () => {
  it('saves and answers with the masked summary only', async () => {
    const svc = await import('../../../src/services/householdChannel.js');
    vi.mocked(svc.saveChannel).mockResolvedValue({ status: 'saved', record: RECORD } as never);
    const audit = await import('../../../src/utils/auditLog.js');
    const { saveHouseholdChannel } = await handlers();
    const res = (await saveHouseholdChannel(
      event({ httpMethod: 'PUT', body: JSON.stringify(SAVE_BODY) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('AbCdEfGhIjKlMnOp');
    expect(JSON.parse(res.body).channel.maskedUrl).toBe('discord.com/…uvwx');
    // The audit line names the platform and nothing about the address.
    const auditCall = JSON.stringify(vi.mocked(audit.audit).mock.calls[0]);
    expect(auditCall).toContain('discord');
    expect(auditCall).not.toContain('AbCdEfGhIjKlMnOp');
    expect(auditCall).not.toContain('uvwx');
  });

  it('a refused address is a 400 with a code, and does not echo the address', async () => {
    const svc = await import('../../../src/services/householdChannel.js');
    vi.mocked(svc.saveChannel).mockResolvedValue({
      status: 'invalid_url',
      problem: 'private_host',
    } as never);
    const { saveHouseholdChannel } = await handlers();
    const res = (await saveHouseholdChannel(
      event({ httpMethod: 'PUT', body: JSON.stringify(SAVE_BODY) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.details).toEqual({ code: 'private_host' });
    expect(res.body).not.toContain('discord.com/api');
  });

  it('is 503 — and never stores anything — without a sealing key', async () => {
    delete process.env.CHANNEL_WEBHOOK_KMS_KEY_ID;
    const svc = await import('../../../src/services/householdChannel.js');
    const { saveHouseholdChannel } = await handlers();
    const res = (await saveHouseholdChannel(
      event({ httpMethod: 'PUT', body: JSON.stringify(SAVE_BODY) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(503);
    expect(svc.saveChannel).not.toHaveBeenCalled();
  });

  it('rejects an unknown field in the body', async () => {
    const { saveHouseholdChannel } = await handlers();
    const res = (await saveHouseholdChannel(
      event({ httpMethod: 'PUT', body: JSON.stringify({ ...SAVE_BODY, sealedUrl: 'x' }) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
  });

  it('409 on a concurrent save', async () => {
    const svc = await import('../../../src/services/householdChannel.js');
    vi.mocked(svc.saveChannel).mockResolvedValue({ status: 'conflict' } as never);
    const { saveHouseholdChannel } = await handlers();
    const res = (await saveHouseholdChannel(
      event({ httpMethod: 'PUT', body: JSON.stringify(SAVE_BODY) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(409);
  });
});

describe('POST /households/{id}/channel/test', () => {
  it('reports a delivered test', async () => {
    const svc = await import('../../../src/services/householdChannel.js');
    vi.mocked(svc.sendTestPost).mockResolvedValue({ status: 'sent', record: RECORD } as never);
    const { testHouseholdChannel } = await handlers();
    const res = (await testHouseholdChannel(
      event({ httpMethod: 'POST' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).outcome).toBe('delivered');
  });

  it('reports a failed test with its status code and category only', async () => {
    const svc = await import('../../../src/services/householdChannel.js');
    vi.mocked(svc.sendTestPost).mockResolvedValue({
      status: 'failed',
      kind: 'client',
      httpStatus: 404,
      record: RECORD,
    } as never);
    const { testHouseholdChannel } = await handlers();
    const res = (await testHouseholdChannel(
      event({ httpMethod: 'POST' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(JSON.parse(res.body)).toMatchObject({
      outcome: 'failed',
      failure: { kind: 'client', httpStatus: 404 },
    });
  });

  it('429 inside the cooldown, 404 with no channel', async () => {
    const svc = await import('../../../src/services/householdChannel.js');
    const { testHouseholdChannel } = await handlers();
    vi.mocked(svc.sendTestPost).mockResolvedValueOnce({
      status: 'cooldown',
      retryAfterSeconds: 12,
    } as never);
    const cooling = (await testHouseholdChannel(
      event({ httpMethod: 'POST' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(cooling.statusCode).toBe(429);
    vi.mocked(svc.sendTestPost).mockResolvedValueOnce({ status: 'none' } as never);
    const none = (await testHouseholdChannel(
      event({ httpMethod: 'POST' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(none.statusCode).toBe(404);
  });
});

describe('DELETE /households/{id}/channel', () => {
  it('disconnects, and works without a sealing key — turning it off is always possible', async () => {
    delete process.env.CHANNEL_WEBHOOK_KMS_KEY_ID;
    const store = await import('../../../src/services/householdChannelStore.js');
    vi.mocked(store.deleteChannel).mockResolvedValue(true);
    const { deleteHouseholdChannel } = await handlers();
    const res = (await deleteHouseholdChannel(
      event({ httpMethod: 'DELETE' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(204);
    expect(store.deleteChannel).toHaveBeenCalledWith('hh-1');
  });

  it('404 when there was nothing to disconnect', async () => {
    const store = await import('../../../src/services/householdChannelStore.js');
    vi.mocked(store.deleteChannel).mockResolvedValue(false);
    const { deleteHouseholdChannel } = await handlers();
    const res = (await deleteHouseholdChannel(
      event({ httpMethod: 'DELETE' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
  });
});
