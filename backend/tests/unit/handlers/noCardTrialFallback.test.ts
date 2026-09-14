/**
 * What a household keeps when its no-card Garden trial falls back to Seedling
 * (ADR 0027), exercised through the real handlers on a household time-travelled
 * past day 14.
 *
 * The rule is the one the Terms already publish for every downgrade: nothing is
 * deleted. Whatever is over a Seedling limit stays readable and editable,
 * adding more is refused, and paid-only surfaces stop granting new things. The
 * `destructiveCalls()` guard is the point of the file: across the fallback, no
 * service function whose name deletes, removes, archives, revokes, purges or
 * clears is called, and no delete reaches DynamoDB. A positive control at the
 * bottom proves the guard can see one.
 *
 * Synthetic fixtures only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn(async () => ({})) },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/services/plantService.js');
vi.mock('../../../src/services/spaceService.js');
vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/sitterService.js');
vi.mock('../../../src/services/plantTagService.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/plantTagService.js')>(
    '../../../src/services/plantTagService.js'
  );
  return {
    ...actual,
    issueTag: vi.fn(),
    listActiveTags: vi.fn(),
    listTags: vi.fn(),
    revokeTag: vi.fn(),
    revokeTagsCreatedBy: vi.fn(),
    revokeTagsForPlant: vi.fn(),
    getActiveTag: vi.fn(),
    getTagSettings: vi.fn(),
    setTagPin: vi.fn(),
    verifyTagPin: vi.fn(),
  };
});
vi.mock('../../../src/services/activity.js', () => ({ recordActivity: vi.fn(async () => {}) }));
vi.mock('../../../src/services/sitterBrief.js', () => ({ buildSitterBrief: vi.fn() }));
vi.mock('../../../src/services/enrichment.js', () => ({
  getSpeciesCached: vi.fn(),
  lookupSpeciesCached: vi.fn(),
}));
vi.mock('../../../src/services/householdService.js', () => ({
  getMemberByUserId: vi.fn(async () => ({
    householdId: 'hh-trial',
    userId: 'user-trial',
    name: 'Synthetic Admin',
    email: 'synthetic-admin',
    role: 'admin',
    joinedAt: '',
  })),
}));
vi.mock('../../../src/services/billing.js', () => ({ getHouseholdSubscription: vi.fn() }));
vi.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: vi.fn(function (input) {
    return { input };
  }),
  HeadObjectCommand: vi.fn(function (input) {
    return { input };
  }),
  DeleteObjectCommand: vi.fn(function (input) {
    return { input };
  }),
  S3Client: vi.fn(function () {
    return {};
  }),
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://upload.example.test/signed'),
}));
vi.mock('../../../src/utils/s3.js', () => ({
  s3: { send: vi.fn() },
  IMAGES_BUCKET: 'test-bucket',
}));

import * as plantService from '../../../src/services/plantService.js';
import * as plantTagService from '../../../src/services/plantTagService.js';
import * as sitterService from '../../../src/services/sitterService.js';
import * as spaceService from '../../../src/services/spaceService.js';
import * as taskService from '../../../src/services/taskService.js';
import * as billing from '../../../src/services/billing.js';
import { dynamodb } from '../../../src/utils/dynamodb.js';

const ctx = {} as Context;
const DAY = 24 * 60 * 60 * 1000;
const CREATED = Date.parse('2026-09-20T23:30:00.000Z');
const ENDS_ISO = '2026-10-04T23:30:00.000Z';
const DURING = CREATED + 13 * DAY;
const PAST = CREATED + 15 * DAY;
const TOKEN = 'a'.repeat(64);

/** The household as billing reads it: created with the trial, no Stripe state. */
const TRIAL_HOUSEHOLD = { planId: 'seedling' as const, noCardTrialEndsAt: ENDS_ISO };

/** Twenty-five plants: five past Seedling's twenty, all added during the trial. */
const PLANTS = Array.from({ length: 25 }, (_, i) => ({
  id: `plant-${i + 1}`,
  householdId: 'hh-trial',
  name: `Synthetic Plant ${i + 1}`,
  species: null,
  imageUrl: null,
  notes: null,
  status: 'active',
  tags: [],
  createdAt: new Date(CREATED + i * 60_000).toISOString(),
}));

const TAGS = [1, 2, 3].map((n) => ({
  id: `tag-${n}`,
  token: `${String(n)}`.repeat(64),
  householdId: 'hh-trial',
  plantId: `plant-${n}`,
  createdBy: 'user-trial',
  createdAt: new Date(CREATED + DAY).toISOString(),
  status: 'active',
  revokedAt: null,
}));

const DESTRUCTIVE = /delete|remove|archive|revoke|purge|clear/i;

function destructiveCalls(): string[] {
  const modules = { plantService, plantTagService, sitterService, spaceService, taskService };
  const calls: string[] = [];
  for (const [moduleName, mod] of Object.entries(modules)) {
    for (const [name, value] of Object.entries(mod)) {
      if (DESTRUCTIVE.test(name) && vi.isMockFunction(value) && value.mock.calls.length > 0) {
        calls.push(`${moduleName}.${name}`);
      }
    }
  }
  for (const [command] of vi.mocked(dynamodb.send).mock.calls) {
    const name = (command as { constructor: { name: string } }).constructor.name;
    if (/Delete|BatchWrite/.test(name)) calls.push(`dynamodb.${name}`);
  }
  return calls;
}

function authed(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/',
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      authorizer: {
        claims: {
          sub: 'user-trial',
          email: 'synthetic-admin',
          'custom:household_id': 'hh-trial',
          'custom:household_role': 'admin',
        },
      },
      identity: { sourceIp: '198.51.100.9' },
    } as unknown as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

function anonymous(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    ...authed(overrides),
    requestContext: {
      identity: { sourceIp: `10.0.1.${Math.floor(Math.random() * 250) + 1}` },
    } as APIGatewayProxyEvent['requestContext'],
  };
}

async function at(ms: number) {
  vi.setSystemTime(ms);
  const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
  const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
  const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
  __resetMembershipCacheForTests();
  __resetRateLimitForTests();
  setCachedMembership('user-trial', 'hh-trial', 'admin');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  process.env.FRONTEND_URL = 'https://test.familygreenhouse.net';
  vi.mocked(billing.getHouseholdSubscription).mockResolvedValue(TRIAL_HOUSEHOLD);
  vi.mocked(plantService.getPlants).mockResolvedValue(PLANTS as never);
  vi.mocked(plantService.getPlant).mockImplementation(
    async (_householdId, plantId) => (PLANTS.find((p) => p.id === plantId) ?? null) as never
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('no-card trial fallback: plants beyond Seedling’s 20 (ADR 0027)', () => {
  it('during the trial the plant cap is Garden’s 200', async () => {
    await at(DURING);
    vi.mocked(plantService.createPlant).mockRejectedValueOnce(
      Object.assign(new Error('Plan limit'), { name: 'PlanLimitError' })
    );
    const { createPlant } = await import('../../../src/handlers/plants/handler.js');
    const res = (await createPlant(
      authed({ httpMethod: 'POST', body: JSON.stringify({ name: 'Synthetic Plant 26' }) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(vi.mocked(plantService.createPlant).mock.calls[0][3]).toBe(200);
    expect(JSON.parse(res.body).message).toMatch(/Garden plan is limited to 200 plants/);
  });

  it('past day 14 every plant is still listed', async () => {
    await at(PAST);
    const { listPlants } = await import('../../../src/handlers/plants/handler.js');
    const res = (await listPlants(authed(), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(25);
    expect(destructiveCalls()).toEqual([]);
  });

  it('past day 14 a plant over the limit can still be edited', async () => {
    await at(PAST);
    vi.mocked(plantService.updatePlant).mockResolvedValueOnce({
      ...PLANTS[24],
      name: 'Renamed Synthetic Plant',
    } as never);
    const { updatePlant } = await import('../../../src/handlers/plants/handler.js');
    const res = (await updatePlant(
      authed({
        httpMethod: 'PUT',
        pathParameters: { id: 'plant-25' },
        body: JSON.stringify({ name: 'Renamed Synthetic Plant' }),
      }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(plantService.updatePlant).toHaveBeenCalledWith(
      'hh-trial',
      'plant-25',
      expect.objectContaining({ name: 'Renamed Synthetic Plant' }),
      20
    );
    expect(destructiveCalls()).toEqual([]);
  });

  it('past day 14 a 26th plant is refused with a 402 naming Seedling’s 20, and nothing is removed to make room', async () => {
    await at(PAST);
    vi.mocked(plantService.createPlant).mockRejectedValueOnce(
      Object.assign(new Error('Plan limit'), { name: 'PlanLimitError' })
    );
    const { createPlant } = await import('../../../src/handlers/plants/handler.js');
    const res = (await createPlant(
      authed({ httpMethod: 'POST', body: JSON.stringify({ name: 'Synthetic Plant 26' }) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(402);
    expect(vi.mocked(plantService.createPlant).mock.calls[0][3]).toBe(20);
    expect(JSON.parse(res.body).message).toMatch(/Seedling plan is limited to 20 plants/);
    expect(destructiveCalls()).toEqual([]);
  });
});

describe('no-card trial fallback: plant tags printed during the trial (ADR 0027)', () => {
  beforeEach(() => {
    vi.mocked(plantTagService.listActiveTags).mockResolvedValue(TAGS as never);
    vi.mocked(plantTagService.getTagSettings).mockResolvedValue({ pinEnabled: false } as never);
  });

  it('past day 14 every tag is still returned, with the allowance to issue more switched off', async () => {
    await at(PAST);
    const { listPlantTags } = await import('../../../src/handlers/plantTags/handler.js');
    const res = (await listPlantTags(
      authed({ pathParameters: { id: 'hh-trial' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.tags).toHaveLength(3);
    expect(body.allowance).toMatchObject({ enabled: false, used: 3 });
    expect(destructiveCalls()).toEqual([]);
  });

  it('past day 14 a new tag is refused, and no existing tag is touched', async () => {
    await at(PAST);
    const { issuePlantTag } = await import('../../../src/handlers/plantTags/handler.js');
    const res = (await issuePlantTag(
      authed({ httpMethod: 'POST', pathParameters: { plantId: 'plant-4' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(402);
    expect(plantTagService.issueTag).not.toHaveBeenCalled();
    expect(destructiveCalls()).toEqual([]);
  });
});

describe('no-card trial fallback: sitter links shared during the trial (ADR 0027)', () => {
  beforeEach(() => {
    vi.mocked(sitterService.getActiveLink).mockResolvedValue({
      id: 'link-1',
      token: TOKEN,
      householdId: 'hh-trial',
      createdBy: 'user-trial',
      createdAt: new Date(CREATED + 10 * DAY).toISOString(),
      startsAt: new Date(CREATED + 10 * DAY).toISOString(),
      expiresAt: new Date(CREATED + 40 * DAY).toISOString(),
      status: 'active',
      label: 'Synthetic trip',
    } as never);
    vi.mocked(taskService.getSitterTasks).mockResolvedValue([
      { id: 'task-1', plantId: 'plant-1', plantName: 'Synthetic Plant 1', type: 'water' },
    ] as never);
  });

  it('while the trial runs the sitter is offered the handoff brief', async () => {
    await at(DURING);
    const { getSitterView } = await import('../../../src/handlers/tasks/handler.js');
    const res = (await getSitterView(
      anonymous({ pathParameters: { token: TOKEN } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).briefAvailable).toBe(true);
  });

  it('past day 14 the link keeps its task list until it expires; the brief stops, as at a cancelled subscription’s period end', async () => {
    await at(PAST);
    const { getSitterView, getSitterBrief } =
      await import('../../../src/handlers/tasks/handler.js');
    const view = (await getSitterView(
      anonymous({ pathParameters: { token: TOKEN } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(view.statusCode).toBe(200);
    const body = JSON.parse(view.body);
    expect(body.tasks).toHaveLength(1);
    expect(body.briefAvailable).toBe(false);

    const brief = (await getSitterBrief(
      anonymous({ pathParameters: { token: TOKEN } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(brief.statusCode).toBe(404);
    expect(destructiveCalls()).toEqual([]);
  });
});

describe('no-card trial fallback: the guard itself', () => {
  it('sees a destructive service call when one happens (positive control)', async () => {
    await vi.mocked(plantService.deletePlant)('hh-trial', 'plant-25');
    expect(destructiveCalls()).toEqual(['plantService.deletePlant']);
  });
});
