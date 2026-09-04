/**
 * Unit tests for the `plantTags` Lambda group (ADR 0016). The real middy
 * stack runs, so these cover the auth + admin gates, the plan gate, the IP
 * rate limit, and — for the two PUBLIC routes — that an event with NO
 * authorizer claims is served, the PIN states, the one-plant scope of task
 * completion, and the settled-read history contract.
 *
 * Services are mocked so the tests pin handler wiring, not DynamoDB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/plantTagService.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/plantTagService.js')>(
    '../../../src/services/plantTagService.js'
  );
  return {
    ...actual,
    issueTag: vi.fn(),
    listActiveTags: vi.fn(),
    revokeTagsForPlant: vi.fn(),
    getActiveTag: vi.fn(),
    getTagSettings: vi.fn(),
    setTagPin: vi.fn(),
    verifyTagPin: vi.fn(),
  };
});
vi.mock('../../../src/services/plantService.js');
vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(async () => ({ planId: 'garden' })),
}));
vi.mock('../../../src/services/activity.js', () => ({ recordActivity: vi.fn(async () => {}) }));

const ctx = {} as Context;
const TOKEN = 'a'.repeat(64);

function baseEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/',
    pathParameters: {},
    queryStringParameters: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

/** Anonymous event: no authorizer claims, a fresh IP per call unless pinned. */
function anonEvent(
  overrides: Partial<APIGatewayProxyEvent> = {},
  ip = `10.0.0.${Math.floor(Math.random() * 250) + 1}`
): APIGatewayProxyEvent {
  return baseEvent({
    requestContext: { identity: { sourceIp: ip } } as APIGatewayProxyEvent['requestContext'],
    ...overrides,
  });
}

const adminClaims = {
  sub: 'user-1',
  email: 'a@b.com',
  'custom:household_id': 'hh-1',
  'custom:household_role': 'admin',
};

function authedEvent(
  overrides: Partial<APIGatewayProxyEvent> = {},
  claims: Record<string, unknown> = adminClaims
): APIGatewayProxyEvent {
  return baseEvent({
    requestContext: {
      authorizer: { claims },
      identity: { sourceIp: '198.51.100.7' },
    } as unknown as APIGatewayProxyEvent['requestContext'],
    ...overrides,
  });
}

function activePlant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    householdId: 'hh-1',
    name: 'Monstera',
    species: 'Monstera deliciosa',
    imageUrl: null,
    notes: 'Bottom-water only',
    status: 'active',
    tags: [],
    ...overrides,
  };
}

function tag(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tag-1',
    token: TOKEN,
    householdId: 'hh-1',
    plantId: 'p1',
    createdBy: 'user-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    status: 'active',
    revokedAt: null,
    pinFailures: 0,
    pinLockedUntil: null,
    ...overrides,
  };
}

async function svc() {
  return import('../../../src/services/plantTagService.js');
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.FRONTEND_URL = 'https://test.familygreenhouse.net';
  process.env.ALLOWED_ORIGIN = 'https://test.familygreenhouse.net';
  const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
  const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
  __resetRateLimitForTests();
  const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
  setCachedMembership('user-1', 'hh-1', 'admin');
  const billing = await import('../../../src/services/billing.js');
  vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId: 'garden' } as never);
  const s = await svc();
  vi.mocked(s.verifyTagPin).mockResolvedValue({ verdict: 'ok' });
  vi.mocked(s.getTagSettings).mockResolvedValue({ pinEnabled: false });
});

describe('POST /plants/{plantId}/tag (issue / re-issue)', () => {
  it('402s on Seedling — plant tags are a paid surface', async () => {
    const billing = await import('../../../src/services/billing.js');
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({
      planId: 'seedling',
    } as never);
    const plantService = await import('../../../src/services/plantService.js');
    vi.mocked(plantService.getPlant).mockResolvedValueOnce(activePlant() as never);

    const { issuePlantTag } = await import('../../../src/handlers/plantTags/handler.js');
    const res = (await issuePlantTag(
      authedEvent({ httpMethod: 'POST', pathParameters: { plantId: 'p1' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(402);
    expect(JSON.parse(res.body).message).toMatch(/Garden/);
    expect((await svc()).issueTag).not.toHaveBeenCalled();
  });

  it('issues a tag on Garden and returns the token + scan URL once', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    vi.mocked(plantService.getPlant).mockResolvedValueOnce(activePlant() as never);
    const s = await svc();
    vi.mocked(s.listActiveTags).mockResolvedValueOnce([]);
    vi.mocked(s.issueTag).mockResolvedValueOnce(tag() as never);

    const { issuePlantTag } = await import('../../../src/handlers/plantTags/handler.js');
    const res = (await issuePlantTag(
      authedEvent({ httpMethod: 'POST', pathParameters: { plantId: 'p1' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.token).toBe(TOKEN);
    expect(body.url).toBe(`https://test.familygreenhouse.net/tag/${TOKEN}`);
    expect(body.plantName).toBe('Monstera');
    // The PIN bookkeeping never leaves the service.
    expect(body.pinFailures).toBeUndefined();
    expect(s.issueTag).toHaveBeenCalledWith({
      householdId: 'hh-1',
      plantId: 'p1',
      createdBy: 'user-1',
    });
  });

  it('402s at the Garden cap, counting only OTHER plants’ tags (re-issue is always allowed)', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const s = await svc();
    const { issuePlantTag } = await import('../../../src/handlers/plantTags/handler.js');

    // 50 active tags on other plants → a 51st plant is refused.
    vi.mocked(plantService.getPlant).mockResolvedValueOnce(activePlant({ id: 'p-new' }) as never);
    vi.mocked(s.listActiveTags).mockResolvedValueOnce(
      Array.from({ length: 50 }, (_, i) => tag({ id: `t${i}`, plantId: `p${i}` })) as never
    );
    const refused = (await issuePlantTag(
      authedEvent({ httpMethod: 'POST', pathParameters: { plantId: 'p-new' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(refused.statusCode).toBe(402);
    expect(JSON.parse(refused.body).message).toMatch(/50 plant tags/);

    // 49 others + this plant's own tag → re-issuing this plant still works.
    vi.mocked(plantService.getPlant).mockResolvedValueOnce(activePlant({ id: 'p0' }) as never);
    vi.mocked(s.listActiveTags).mockResolvedValueOnce(
      Array.from({ length: 50 }, (_, i) => tag({ id: `t${i}`, plantId: `p${i}` })) as never
    );
    vi.mocked(s.issueTag).mockResolvedValueOnce(tag({ plantId: 'p0' }) as never);
    const reissued = (await issuePlantTag(
      authedEvent({ httpMethod: 'POST', pathParameters: { plantId: 'p0' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(reissued.statusCode).toBe(201);
  });

  it('404s for a plant outside the caller’s household and 409s for an archived one', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const { issuePlantTag } = await import('../../../src/handlers/plantTags/handler.js');

    vi.mocked(plantService.getPlant).mockResolvedValueOnce(null);
    const missing = (await issuePlantTag(
      authedEvent({ httpMethod: 'POST', pathParameters: { plantId: 'nope' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(missing.statusCode).toBe(404);

    vi.mocked(plantService.getPlant).mockResolvedValueOnce(
      activePlant({ status: 'archived' }) as never
    );
    const archived = (await issuePlantTag(
      authedEvent({ httpMethod: 'POST', pathParameters: { plantId: 'p1' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(archived.statusCode).toBe(409);
  });

  it('requires a signed-in household member', async () => {
    const { issuePlantTag } = await import('../../../src/handlers/plantTags/handler.js');
    const res = (await issuePlantTag(
      anonEvent({ httpMethod: 'POST', pathParameters: { plantId: 'p1' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(401);
  });
});

describe('DELETE /plants/{plantId}/tag (revoke)', () => {
  it('204s when a tag was revoked and 404s when the plant had none', async () => {
    const s = await svc();
    const { revokePlantTag } = await import('../../../src/handlers/plantTags/handler.js');

    vi.mocked(s.revokeTagsForPlant).mockResolvedValueOnce(1);
    const ok = (await revokePlantTag(
      authedEvent({ httpMethod: 'DELETE', pathParameters: { plantId: 'p1' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(ok.statusCode).toBe(204);
    expect(s.revokeTagsForPlant).toHaveBeenCalledWith('hh-1', 'p1');

    vi.mocked(s.revokeTagsForPlant).mockResolvedValueOnce(0);
    const none = (await revokePlantTag(
      authedEvent({ httpMethod: 'DELETE', pathParameters: { plantId: 'p1' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(none.statusCode).toBe(404);
  });
});

describe('GET /households/{id}/plant-tags', () => {
  it('403s for a household the caller is not in', async () => {
    const { listPlantTags } = await import('../../../src/handlers/plantTags/handler.js');
    const res = (await listPlantTags(
      authedEvent({ pathParameters: { id: 'hh-other' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(403);
  });

  it('returns active tags with tokens, the PIN state and the plan allowance', async () => {
    const s = await svc();
    const plantService = await import('../../../src/services/plantService.js');
    vi.mocked(s.listActiveTags).mockResolvedValueOnce([
      tag(),
      tag({ id: 'orphan', token: 'b'.repeat(64), plantId: 'gone' }),
    ] as never);
    vi.mocked(plantService.getPlants).mockResolvedValueOnce([activePlant()] as never);
    vi.mocked(s.getTagSettings).mockResolvedValueOnce({ pinEnabled: true });

    const { listPlantTags } = await import('../../../src/handlers/plantTags/handler.js');
    const res = (await listPlantTags(
      authedEvent({ pathParameters: { id: 'hh-1' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // A tag whose plant no longer exists is not listed (it cannot be printed).
    expect(body.tags).toHaveLength(1);
    expect(body.tags[0]).toMatchObject({
      id: 'tag-1',
      plantId: 'p1',
      plantName: 'Monstera',
      token: TOKEN,
      url: `https://test.familygreenhouse.net/tag/${TOKEN}`,
    });
    expect(body.pinEnabled).toBe(true);
    expect(body.allowance).toEqual({ enabled: true, max: 50, used: 2 });
    expect(body.planId).toBe('garden');
    expect(plantService.getPlants).toHaveBeenCalledWith('hh-1', 'all');
  });

  // #451: this route hands back every active tag's RAW, never-expiring token
  // in one call. Issuing one tag is not an escalation; taking a copy of every
  // token in the house is a different act, and it was neither audited nor
  // limited while all three of its siblings were both.
  it('audits the bulk read with a tag count, and never a token', async () => {
    const s = await svc();
    const plantService = await import('../../../src/services/plantService.js');
    const { logger } = await import('../../../src/utils/logger.js');
    // Spy rather than module-mock: the middy stack builds its request logger
    // from this module, so replacing the whole module breaks every route.
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.mocked(s.listActiveTags).mockResolvedValueOnce([tag()] as never);
    vi.mocked(plantService.getPlants).mockResolvedValueOnce([activePlant()] as never);
    vi.mocked(s.getTagSettings).mockResolvedValueOnce({ pinEnabled: false });

    const { listPlantTags } = await import('../../../src/handlers/plantTags/handler.js');
    await listPlantTags(authedEvent({ pathParameters: { id: 'hh-1' } }), ctx, () => {});

    const audited = info.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((fields) => fields?.event === 'planttag.listed');
    expect(audited).toMatchObject({
      audit: true,
      event: 'planttag.listed',
      householdId: 'hh-1',
      actorId: 'user-1',
      metadata: { tags: 1 },
    });
    expect(JSON.stringify(audited)).not.toContain(TOKEN);
    info.mockRestore();
  });

  it('rate limits the bulk export at 30/min per user, like issue and revoke', async () => {
    const s = await svc();
    const plantService = await import('../../../src/services/plantService.js');
    vi.mocked(s.listActiveTags).mockResolvedValue([] as never);
    vi.mocked(plantService.getPlants).mockResolvedValue([] as never);
    vi.mocked(s.getTagSettings).mockResolvedValue({ pinEnabled: false } as never);

    const { listPlantTags } = await import('../../../src/handlers/plantTags/handler.js');
    const call = () =>
      listPlantTags(
        authedEvent({ pathParameters: { id: 'hh-1' } }),
        ctx,
        () => {}
      ) as Promise<APIGatewayProxyResult>;
    for (let i = 0; i < 30; i += 1) expect((await call()).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(429);
  });
});

describe('PUT /households/{id}/plant-tags/pin', () => {
  it('is admin-only', async () => {
    const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
    setCachedMembership('user-1', 'hh-1', 'member');
    const { setPlantTagPin } = await import('../../../src/handlers/plantTags/handler.js');
    const res = (await setPlantTagPin(
      authedEvent(
        {
          httpMethod: 'PUT',
          pathParameters: { id: 'hh-1' },
          body: JSON.stringify({ pin: '1234' }),
        },
        { ...adminClaims, 'custom:household_role': 'member' }
      ),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(403);
    expect((await svc()).setTagPin).not.toHaveBeenCalled();
  });

  it('sets a four-digit PIN and clears it with null', async () => {
    const s = await svc();
    vi.mocked(s.setTagPin).mockResolvedValueOnce({ pinEnabled: true });
    const { setPlantTagPin } = await import('../../../src/handlers/plantTags/handler.js');
    const set = (await setPlantTagPin(
      authedEvent({
        httpMethod: 'PUT',
        pathParameters: { id: 'hh-1' },
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '1234' }),
      }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(set.statusCode).toBe(200);
    expect(JSON.parse(set.body)).toEqual({ pinEnabled: true });
    expect(s.setTagPin).toHaveBeenCalledWith('hh-1', '1234', 'user-1');

    vi.mocked(s.setTagPin).mockResolvedValueOnce({ pinEnabled: false });
    const cleared = (await setPlantTagPin(
      authedEvent({
        httpMethod: 'PUT',
        pathParameters: { id: 'hh-1' },
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: null }),
      }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(cleared.statusCode).toBe(200);
    expect(s.setTagPin).toHaveBeenLastCalledWith('hh-1', null, 'user-1');
  });

  it('rejects a PIN that is not exactly four digits', async () => {
    const { setPlantTagPin } = await import('../../../src/handlers/plantTags/handler.js');
    for (const pin of ['12', '12345', 'abcd']) {
      const res = (await setPlantTagPin(
        authedEvent({
          httpMethod: 'PUT',
          pathParameters: { id: 'hh-1' },
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin }),
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('GET /tag/{token} (public)', () => {
  async function arrange(opts: { plant?: Record<string, unknown> | null } = {}) {
    const s = await svc();
    const plantService = await import('../../../src/services/plantService.js');
    const taskService = await import('../../../src/services/taskService.js');
    vi.mocked(s.getActiveTag).mockResolvedValue(tag() as never);
    vi.mocked(plantService.getPlant).mockResolvedValue(
      (opts.plant === null ? null : activePlant(opts.plant ?? {})) as never
    );
    vi.mocked(taskService.getTasksForPlant).mockResolvedValue([
      {
        id: 't-water',
        plantId: 'p1',
        type: 'water',
        customType: null,
        nextDue: new Date(Date.now() - 3_600_000).toISOString(),
      },
      {
        id: 't-feed',
        plantId: 'p1',
        type: 'fertilize',
        customType: null,
        nextDue: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      },
    ] as never);
    vi.mocked(taskService.getTaskCompletions).mockResolvedValue([
      {
        taskType: 'fertilize',
        completedAt: '2026-09-02T10:00:00.000Z',
        completedBy: 'user-2',
        completedByName: 'Jane Smith',
      },
      {
        taskType: 'water',
        completedAt: '2026-08-30T10:00:00.000Z',
        completedBy: 'tag:tag-1',
        completedByName: 'Grandma Jo',
      },
    ] as never);
    return { s, plantService, taskService };
  }

  it('serves the scan view anonymously: plant, notes, due tasks, and last care by FIRST name', async () => {
    await arrange();
    const { getTagView } = await import('../../../src/handlers/plantTags/handler.js');
    const res = (await getTagView(
      anonEvent({ path: `/tag/${TOKEN}`, pathParameters: { token: TOKEN } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.plantName).toBe('Monstera');
    expect(body.careNotes).toBe('Bottom-water only');
    expect(body.history.status).toBe('ok');
    // Member names are cut to a first name; a tag scanner's typed name is kept.
    expect(body.history.lastCare).toEqual({
      taskType: 'fertilize',
      completedAt: '2026-09-02T10:00:00.000Z',
      completedByName: 'Jane',
      viaTag: false,
    });
    expect(body.history.lastWatered).toEqual({
      taskType: 'water',
      completedAt: '2026-08-30T10:00:00.000Z',
      completedByName: 'Grandma Jo',
      viaTag: true,
    });
    // Only the due task (within 7 days / overdue) is offered.
    expect(body.tasks).toEqual([
      expect.objectContaining({ taskId: 't-water', taskType: 'water', overdue: true }),
    ]);
    // Nothing that identifies members or the household leaks.
    expect(res.body).not.toContain('user-2');
    expect(res.body).not.toContain('hh-1');
    expect(res.body).not.toContain('Smith');
  });

  it('reports a FAILED history read as unavailable — never as "never watered"', async () => {
    const { taskService } = await arrange();
    vi.mocked(taskService.getTaskCompletions).mockRejectedValueOnce(new Error('ddb down'));
    const { getTagView } = await import('../../../src/handlers/plantTags/handler.js');
    const res = (await getTagView(
      anonEvent({ pathParameters: { token: TOKEN } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.history).toEqual({ status: 'unavailable' });
    expect(body.plantName).toBe('Monstera'); // the rest of the page still works
  });

  it('404s (generic) for an invalid/revoked token and for a plant that is no longer active', async () => {
    const { s } = await arrange();
    const { getTagView } = await import('../../../src/handlers/plantTags/handler.js');

    vi.mocked(s.getActiveTag).mockResolvedValueOnce(null);
    const bad = (await getTagView(
      anonEvent({ pathParameters: { token: 'bad' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(bad.statusCode).toBe(404);

    await arrange({ plant: { status: 'died' } });
    const dead = (await getTagView(
      anonEvent({ pathParameters: { token: TOKEN } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(dead.statusCode).toBe(404);
    expect(JSON.parse(dead.body).message).toBe(JSON.parse(bad.body).message);
  });

  it('enforces the household PIN server-side: 401 required / 401 wrong / 423 locked', async () => {
    const { s } = await arrange();
    const { getTagView } = await import('../../../src/handlers/plantTags/handler.js');

    vi.mocked(s.verifyTagPin).mockResolvedValueOnce({ verdict: 'required' });
    const required = (await getTagView(
      anonEvent({ pathParameters: { token: TOKEN } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(required.statusCode).toBe(401);
    expect(JSON.parse(required.body).details).toEqual({ pinRequired: true, reason: 'required' });

    vi.mocked(s.verifyTagPin).mockResolvedValueOnce({ verdict: 'wrong' });
    const wrong = (await getTagView(
      anonEvent({ pathParameters: { token: TOKEN }, headers: { 'X-Tag-Pin': '0000' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(wrong.statusCode).toBe(401);
    expect(JSON.parse(wrong.body).details.reason).toBe('wrong');
    // The header reaches the service case-insensitively.
    expect(s.verifyTagPin).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'tag-1' }),
      '0000'
    );

    vi.mocked(s.verifyTagPin).mockResolvedValueOnce({
      verdict: 'locked',
      lockedUntil: '2026-09-03T12:15:00.000Z',
    });
    const locked = (await getTagView(
      anonEvent({ pathParameters: { token: TOKEN }, headers: { 'x-tag-pin': '0000' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(locked.statusCode).toBe(423);
    expect(JSON.parse(locked.body).details.lockedUntil).toBe('2026-09-03T12:15:00.000Z');
  });

  it('applies an IP rate limit (429 after 60 requests/min)', async () => {
    await arrange();
    const { getTagView } = await import('../../../src/handlers/plantTags/handler.js');
    const event = () => anonEvent({ pathParameters: { token: TOKEN } }, '203.0.113.9');
    for (let i = 0; i < 60; i++) {
      const r = (await getTagView(event(), ctx, () => {})) as APIGatewayProxyResult;
      expect(r.statusCode).toBe(200);
    }
    const limited = (await getTagView(event(), ctx, () => {})) as APIGatewayProxyResult;
    expect(limited.statusCode).toBe(429);
  });
});

describe('POST /tag/{token}/tasks/{taskId}/complete (public)', () => {
  async function arrange() {
    const s = await svc();
    const plantService = await import('../../../src/services/plantService.js');
    const taskService = await import('../../../src/services/taskService.js');
    vi.mocked(s.getActiveTag).mockResolvedValue(tag() as never);
    vi.mocked(plantService.getPlant).mockResolvedValue(activePlant() as never);
    vi.mocked(taskService.getTask).mockResolvedValue({
      id: 't-water',
      plantId: 'p1',
      householdId: 'hh-1',
      type: 'water',
      customType: null,
      nextDue: '2026-09-03T00:00:00.000Z',
    } as never);
    vi.mocked(taskService.completeTask).mockResolvedValue({
      id: 't-water',
      plantId: 'p1',
      plantName: 'Monstera',
      type: 'water',
      customType: null,
      nextDue: '2026-09-10T00:00:00.000Z',
    } as never);
    return { s, plantService, taskService };
  }

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    anonEvent({
      httpMethod: 'POST',
      path: `/tag/${TOKEN}/tasks/t-water/complete`,
      pathParameters: { token: TOKEN, taskId: 't-water' },
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('completes the task as the typed display name with a tag actor and viaTag on the feed', async () => {
    const { taskService } = await arrange();
    const activity = await import('../../../src/services/activity.js');
    const { completeTagTask } = await import('../../../src/handlers/plantTags/handler.js');
    const res = (await completeTagTask(
      post({ displayName: '  Grandma  ', expectedNextDue: '2026-09-03T00:00:00.000Z' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      taskId: 't-water',
      taskType: 'water',
      dueDate: '2026-09-10T00:00:00.000Z',
      completedByName: 'Grandma',
      alreadyDone: false,
    });
    expect(taskService.completeTask).toHaveBeenCalledWith(
      'hh-1',
      't-water',
      'tag:tag-1',
      'Grandma',
      undefined,
      '2026-09-03T00:00:00.000Z'
    );
    expect(activity.recordActivity).toHaveBeenCalledWith({
      type: 'task.completed',
      householdId: 'hh-1',
      actorId: 'tag:tag-1',
      actorName: 'Grandma',
      payload: {
        taskId: 't-water',
        plantId: 'p1',
        plantName: 'Monstera',
        taskType: 'water',
        viaTag: true,
      },
    });
  });

  it('refuses a task that belongs to ANOTHER plant in the same household (one-plant scope)', async () => {
    const { taskService } = await arrange();
    vi.mocked(taskService.getTask).mockResolvedValueOnce({
      id: 't-water',
      plantId: 'p-sibling',
      householdId: 'hh-1',
    } as never);
    const { completeTagTask } = await import('../../../src/handlers/plantTags/handler.js');
    const res = (await completeTagTask(
      post({ displayName: 'Grandma' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
    expect(taskService.completeTask).not.toHaveBeenCalled();
  });

  it('acknowledges a retried tap for an already-advanced occurrence without completing again', async () => {
    const { taskService } = await arrange();
    const activity = await import('../../../src/services/activity.js');
    const { completeTagTask } = await import('../../../src/handlers/plantTags/handler.js');
    const res = (await completeTagTask(
      post({ displayName: 'Grandma', expectedNextDue: '2026-08-27T00:00:00.000Z' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).alreadyDone).toBe(true);
    expect(taskService.completeTask).not.toHaveBeenCalled();
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it('requires a real display name (control characters are not a name)', async () => {
    await arrange();
    const { completeTagTask } = await import('../../../src/handlers/plantTags/handler.js');
    const empty = (await completeTagTask(
      post({ displayName: '​' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(empty.statusCode).toBe(400);
    const missing = (await completeTagTask(post({}), ctx, () => {})) as APIGatewayProxyResult;
    expect(missing.statusCode).toBe(400);
  });

  it('enforces the PIN on the write path too', async () => {
    const { s, taskService } = await arrange();
    vi.mocked(s.verifyTagPin).mockResolvedValueOnce({ verdict: 'required' });
    const { completeTagTask } = await import('../../../src/handlers/plantTags/handler.js');
    const res = (await completeTagTask(
      post({ displayName: 'Grandma' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(401);
    expect(taskService.completeTask).not.toHaveBeenCalled();
  });
});
