/**
 * The plant passport routes (#676), handler level: services are mocked, so
 * what is asserted is what the handlers decide — the off switch, who the
 * import writes for, what it refuses, what it never lets through.
 *
 * The service half (row shape, the once-per-household claim) is in
 * tests/unit/services/plantPassport.test.ts, and the whole flow across two
 * households in tests/integration/plant-passport.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import {
  buildPassportSummary,
  PASSPORT_ALREADY_IMPORTED,
  PASSPORT_IMPORT_DISABLED,
} from '../../../src/models/plantPassport.js';

vi.mock('../../../src/services/householdAudit.js');
vi.mock('../../../src/services/plantService.js');
vi.mock('../../../src/services/plantPassport.js');
vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/activity.js');
vi.mock('../../../src/services/email/locale.js', () => ({
  resolveEmailLocaleForUser: vi.fn(async () => ({ locale: 'en', source: 'user' })),
}));
vi.mock('../../../src/services/householdService.js', () => ({
  getMemberByUserId: vi.fn(async () => ({
    householdId: 'hh-1',
    userId: 'user-1',
    name: 'Tester',
    email: 'a@b.com',
    role: 'member',
    joinedAt: '',
  })),
  getHousehold: vi.fn(async () => ({
    id: 'hh-2',
    name: 'Source House',
    createdAt: '',
    createdBy: 'user-9',
  })),
}));
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(async () => ({ planId: 'garden' })),
}));
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

const PLANT_ID = '11111111-1111-4111-8111-111111111111';
const NEW_PLANT_ID = '22222222-2222-4222-8222-222222222222';
const CODE = 'a'.repeat(32);

const fakeContext = {} as Context;

function buildEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/',
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      authorizer: {
        claims: {
          sub: 'user-1',
          email: 'a@b.com',
          'custom:household_id': 'hh-1',
          'custom:household_role': 'member',
        },
      },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

const summary = buildPassportSummary({
  plant: { createdAt: '2025-01-01T00:00:00.000Z', speciesSource: 'catalog' },
  tasks: [{ type: 'water', customType: null, frequency: 7 }],
  completions: [{ completedAt: '2026-09-10T00:00:00.000Z' }],
  completionsReadLimit: 100,
  lineage: { parentName: 'Kitchen Pothos', cuttingsTaken: 1 },
  now: new Date('2026-09-19T00:00:00.000Z'),
});

const passportShare = {
  code: CODE,
  plantId: PLANT_ID,
  householdId: 'hh-2',
  plantSnapshot: {
    name: 'Mother Monstera',
    species: 'Monstera deliciosa',
    careRule: 'bottom-water only',
    imageUrl: null,
    tags: ['tropical'],
  },
  passport: summary,
  createdBy: 'user-9',
  createdAt: '2026-09-19T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

const cuttingShare = { ...passportShare, passport: null };

type Handler = (
  event: APIGatewayProxyEvent,
  context: Context,
  cb: () => void
) => Promise<APIGatewayProxyResult>;

async function handlers() {
  const passport = (await import('../../../src/handlers/plants/passport.js')) as unknown as {
    sharePlantPassport: Handler;
    getSharedPassport: Handler;
    importSharedPassport: Handler;
  };
  const { handler } = (await import('../../../src/handlers/plants/handler.js')) as unknown as {
    handler: { routes: string[] };
  };
  return { ...passport, handler };
}

async function call(fn: Handler, event: APIGatewayProxyEvent) {
  return fn(event, fakeContext, () => {});
}

const anonymous = (event: APIGatewayProxyEvent) => {
  delete (event.requestContext as { authorizer?: unknown }).authorizer;
  return event;
};

describe('plant passport handlers', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv('FRONTEND_URL', 'https://familygreenhouse.net');
    const activity = await import('../../../src/services/activity.js');
    vi.mocked(activity.recordActivity).mockResolvedValue(undefined);
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    __resetMembershipCacheForTests();
    const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
    __resetRateLimitForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('routes the three passport routes on the plants Lambda', async () => {
    const { handler } = await handlers();
    expect(handler.routes).toEqual(
      expect.arrayContaining([
        'POST /plants/{id}/passport-share',
        'GET /plants/shared/{code}/passport',
        'POST /plants/shared/{code}/passport/import',
      ])
    );
  });

  describe('while the feature is off (the default)', () => {
    it('answers every route with 404 PASSPORT_IMPORT_DISABLED and touches no data', async () => {
      const { sharePlantPassport, getSharedPassport, importSharedPassport } = await handlers();
      const plantService = await import('../../../src/services/plantService.js');
      const passport = await import('../../../src/services/plantPassport.js');

      const responses = [
        await call(sharePlantPassport, buildEvent({ pathParameters: { id: PLANT_ID } })),
        await call(getSharedPassport, anonymous(buildEvent({ pathParameters: { code: CODE } }))),
        await call(importSharedPassport, buildEvent({ pathParameters: { code: CODE } })),
      ];
      for (const res of responses) {
        expect(res.statusCode).toBe(404);
        expect(JSON.parse(res.body).details).toEqual({ code: PASSPORT_IMPORT_DISABLED });
      }
      expect(passport.createPassportShare).not.toHaveBeenCalled();
      expect(passport.claimPassportImport).not.toHaveBeenCalled();
      expect(plantService.getPlantShare).not.toHaveBeenCalled();
      expect(plantService.createPlant).not.toHaveBeenCalled();
    });

    it('is 404 before authentication and before body validation', async () => {
      const { sharePlantPassport, importSharedPassport } = await handlers();
      const noAuth = anonymous(buildEvent({ pathParameters: { id: PLANT_ID } }));
      expect((await call(sharePlantPassport, noAuth)).statusCode).toBe(404);

      const forged = buildEvent({
        pathParameters: { code: CODE },
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ householdId: 'hh-victim' }),
      });
      expect((await call(importSharedPassport, forged)).statusCode).toBe(404);
    });

    it('is off for anything but exactly "1"', async () => {
      const { getSharedPassport } = await handlers();
      for (const value of ['0', 'true', '']) {
        vi.stubEnv('PASSPORT_IMPORT_ENABLED', value);
        const res = await call(
          getSharedPassport,
          anonymous(buildEvent({ pathParameters: { code: CODE } }))
        );
        expect(res.statusCode).toBe(404);
      }
    });
  });

  describe('when the feature is on', () => {
    beforeEach(() => {
      vi.stubEnv('PASSPORT_IMPORT_ENABLED', '1');
    });

    describe('POST /plants/{id}/passport-share', () => {
      it('mints a link for the CALLER household and returns the /shared URL', async () => {
        const { sharePlantPassport } = await handlers();
        const passport = await import('../../../src/services/plantPassport.js');
        vi.mocked(passport.createPassportShare).mockResolvedValueOnce(passportShare);

        const res = await call(
          sharePlantPassport,
          buildEvent({ pathParameters: { id: PLANT_ID } })
        );

        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body);
        expect(body).toEqual({
          code: CODE,
          expiresAt: passportShare.expiresAt,
          url: `https://familygreenhouse.net/shared/${CODE}`,
        });
        // Household and user come from the token, never from the request.
        expect(passport.createPassportShare).toHaveBeenCalledWith('hh-1', PLANT_ID, 'user-1');
        // The summary is not echoed to the sharer's browser either.
        expect(JSON.stringify(body)).not.toContain('Kitchen Pothos');
      });

      it('is 404 for a plant outside the caller household', async () => {
        const { sharePlantPassport } = await handlers();
        const passport = await import('../../../src/services/plantPassport.js');
        vi.mocked(passport.createPassportShare).mockResolvedValueOnce(null);
        const res = await call(
          sharePlantPassport,
          buildEvent({ pathParameters: { id: PLANT_ID } })
        );
        expect(res.statusCode).toBe(404);
      });

      it('mints nothing when link configuration is missing', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('FRONTEND_URL', '');
        vi.stubEnv('ALLOWED_ORIGIN', '');
        const { sharePlantPassport } = await handlers();
        const passport = await import('../../../src/services/plantPassport.js');
        const res = await call(
          sharePlantPassport,
          buildEvent({ pathParameters: { id: PLANT_ID } })
        );
        expect(res.statusCode).toBe(500);
        expect(passport.createPassportShare).not.toHaveBeenCalled();
      });

      it('requires a signed-in member', async () => {
        const { sharePlantPassport } = await handlers();
        const res = await call(
          sharePlantPassport,
          anonymous(buildEvent({ pathParameters: { id: PLANT_ID } }))
        );
        expect(res.statusCode).toBe(401);
      });

      it('rate-limits a runaway client', async () => {
        const { sharePlantPassport } = await handlers();
        const passport = await import('../../../src/services/plantPassport.js');
        vi.mocked(passport.createPassportShare).mockResolvedValue(passportShare);
        let last = 0;
        for (let i = 0; i < 11; i++) {
          last = (await call(sharePlantPassport, buildEvent({ pathParameters: { id: PLANT_ID } })))
            .statusCode;
        }
        expect(last).toBe(429);
      });
    });

    describe('GET /plants/shared/{code}/passport (public)', () => {
      it('serves the frozen summary with no credentials, and nothing that identifies the sharer', async () => {
        const { getSharedPassport } = await handlers();
        const plantService = await import('../../../src/services/plantService.js');
        vi.mocked(plantService.getPlantShare).mockResolvedValueOnce(passportShare);

        const res = await call(
          getSharedPassport,
          anonymous(buildEvent({ httpMethod: 'GET', pathParameters: { code: CODE } }))
        );

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body).toEqual({ passport: summary, expiresAt: passportShare.expiresAt });
        expect(JSON.stringify(body)).not.toMatch(/hh-2|user-9|PRIVATE|createdBy|householdId/);
      });

      it('is 404 for an unknown or expired code', async () => {
        const { getSharedPassport } = await handlers();
        const plantService = await import('../../../src/services/plantService.js');
        vi.mocked(plantService.getPlantShare).mockResolvedValueOnce(null);
        const res = await call(
          getSharedPassport,
          anonymous(buildEvent({ httpMethod: 'GET', pathParameters: { code: 'f'.repeat(32) } }))
        );
        expect(res.statusCode).toBe(404);
      });

      it('is 404 for a plain cutting link, and for a stored block that did not parse', async () => {
        const { getSharedPassport } = await handlers();
        const plantService = await import('../../../src/services/plantService.js');
        // `getPlantShare` reads an unparseable block back as null (service test).
        vi.mocked(plantService.getPlantShare).mockResolvedValueOnce(cuttingShare);
        const res = await call(
          getSharedPassport,
          anonymous(buildEvent({ httpMethod: 'GET', pathParameters: { code: CODE } }))
        );
        expect(res.statusCode).toBe(404);
      });

      it('rate-limits probing by IP', async () => {
        const { getSharedPassport } = await handlers();
        const plantService = await import('../../../src/services/plantService.js');
        vi.mocked(plantService.getPlantShare).mockResolvedValue(null);
        let last = 0;
        for (let i = 0; i < 31; i++) {
          last = (
            await call(
              getSharedPassport,
              anonymous(buildEvent({ httpMethod: 'GET', pathParameters: { code: CODE } }))
            )
          ).statusCode;
        }
        expect(last).toBe(429);
      });
    });

    describe('POST /plants/shared/{code}/passport/import', () => {
      async function primeHappyPath() {
        const plantService = await import('../../../src/services/plantService.js');
        const passport = await import('../../../src/services/plantPassport.js');
        vi.mocked(plantService.getPlantShare).mockResolvedValue(passportShare);
        vi.mocked(passport.claimPassportImport).mockResolvedValue({ kind: 'claimed' });
        vi.mocked(plantService.createPlant).mockResolvedValue({
          id: NEW_PLANT_ID,
          householdId: 'hh-1',
          name: 'Mother Monstera',
        } as never);
        return { plantService, passport };
      }

      const importEvent = (extra: Partial<APIGatewayProxyEvent> = {}) =>
        buildEvent({ pathParameters: { code: CODE }, ...extra });

      it('creates ONE plant in the CALLER household, its summary as the first note', async () => {
        const { importSharedPassport } = await handlers();
        const { plantService, passport } = await primeHappyPath();

        const res = await call(importSharedPassport, importEvent());

        expect(res.statusCode).toBe(201);
        expect(plantService.createPlant).toHaveBeenCalledTimes(1);
        const [input, householdId, userId, cap] = vi.mocked(plantService.createPlant).mock.calls[0];
        // The recipient's own household and user, from the token; the plan's cap.
        expect(householdId).toBe('hh-1');
        expect(userId).toBe('user-1');
        expect(cap).toBe(200);
        expect(input).toMatchObject({
          name: 'Mother Monstera',
          species: 'Monstera deliciosa',
          careRule: 'bottom-water only',
          tags: ['tropical'],
        });
        const notes = (input as { notes: string }).notes;
        expect(notes).toContain('Plant passport from Source House, shared on 2026-09-19.');
        expect(notes).toContain('House rule: bottom-water only');
        expect(notes).toContain('Water every 7 days');
        expect(notes).toContain('a cutting of Kitchen Pothos');
        // Nothing about the source household's ids reaches the new plant.
        expect(JSON.stringify(input)).not.toMatch(/hh-2|user-9|plant-1|11111111/);
        // Claim taken before the write, and pointed at the plant after it.
        expect(passport.claimPassportImport).toHaveBeenCalledWith(
          'hh-1',
          CODE,
          passportShare.expiresAt
        );
        expect(passport.recordPassportImport).toHaveBeenCalledWith('hh-1', CODE, NEW_PLANT_ID);
        expect(passport.releasePassportImport).not.toHaveBeenCalled();
      });

      it('copies no photo, no task and no id', async () => {
        const { importSharedPassport } = await handlers();
        const { plantService } = await primeHappyPath();
        const taskService = await import('../../../src/services/taskService.js');
        await call(importSharedPassport, importEvent());
        const input = vi.mocked(plantService.createPlant).mock.calls[0][0] as Record<
          string,
          unknown
        >;
        expect(Object.keys(input).sort()).toEqual(['careRule', 'name', 'notes', 'species', 'tags']);
        expect(taskService.createTask).not.toHaveBeenCalled();
      });

      it('writes the note in Spanish for a Spanish speaker', async () => {
        const { importSharedPassport } = await handlers();
        const { plantService } = await primeHappyPath();
        const locale = await import('../../../src/services/email/locale.js');
        vi.mocked(locale.resolveEmailLocaleForUser).mockResolvedValueOnce({
          locale: 'es',
          source: 'user',
        });
        await call(importSharedPassport, importEvent());
        const notes = (vi.mocked(plantService.createPlant).mock.calls[0][0] as { notes: string })
          .notes;
        expect(notes).toContain('Pasaporte de planta de Source House');
        expect(notes).toContain('Regla de la casa: bottom-water only');
      });

      it('refuses a forged household id, plant id or note in the body — and writes nothing', async () => {
        const { importSharedPassport } = await handlers();
        const { plantService, passport } = await primeHappyPath();
        for (const forged of [
          { householdId: 'hh-victim' },
          { plantId: PLANT_ID },
          { notes: 'INJECTED' },
          { passport: summary },
          { householdId: 'hh-2', code: CODE },
        ]) {
          const res = await call(
            importSharedPassport,
            importEvent({
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(forged),
            })
          );
          expect(res.statusCode).toBe(400);
        }
        expect(plantService.createPlant).not.toHaveBeenCalled();
        // Refused before the claim, so nothing was taken that needs giving back.
        expect(passport.claimPassportImport).not.toHaveBeenCalled();
      });

      it('accepts an empty object body and no body', async () => {
        const { importSharedPassport } = await handlers();
        await primeHappyPath();
        const withEmpty = await call(
          importSharedPassport,
          importEvent({ headers: { 'content-type': 'application/json' }, body: '{}' })
        );
        expect(withEmpty.statusCode).toBe(201);
        const withNone = await call(importSharedPassport, importEvent());
        expect(withNone.statusCode).toBe(201);
      });

      it('rejects malformed JSON', async () => {
        const { importSharedPassport } = await handlers();
        const { plantService } = await primeHappyPath();
        for (const body of ['{not json', '[', '"str"', '7']) {
          const res = await call(
            importSharedPassport,
            importEvent({ headers: { 'content-type': 'application/json' }, body })
          );
          expect(res.statusCode).toBeGreaterThanOrEqual(400);
          expect(res.statusCode).toBeLessThan(500);
        }
        expect(plantService.createPlant).not.toHaveBeenCalled();
      });

      it('rejects an oversize body with 413 before anything is read', async () => {
        const { importSharedPassport } = await handlers();
        const { plantService, passport } = await primeHappyPath();
        const res = await call(
          importSharedPassport,
          importEvent({
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ padding: 'x'.repeat(2048) }),
          })
        );
        expect(res.statusCode).toBe(413);
        expect(plantService.getPlantShare).not.toHaveBeenCalled();
        expect(passport.claimPassportImport).not.toHaveBeenCalled();
        expect(plantService.createPlant).not.toHaveBeenCalled();
      });

      it('answers a REPLAY with 409 and the existing plant, creating nothing', async () => {
        const { importSharedPassport } = await handlers();
        const { plantService, passport } = await primeHappyPath();
        vi.mocked(passport.claimPassportImport).mockResolvedValueOnce({
          kind: 'already',
          plantId: NEW_PLANT_ID,
        });

        const res = await call(importSharedPassport, importEvent());

        expect(res.statusCode).toBe(409);
        expect(JSON.parse(res.body).details).toEqual({
          code: PASSPORT_ALREADY_IMPORTED,
          plantId: NEW_PLANT_ID,
        });
        expect(plantService.createPlant).not.toHaveBeenCalled();
        expect(passport.recordPassportImport).not.toHaveBeenCalled();
      });

      it('is 404 for an unknown code and for a link with no passport, taking no claim', async () => {
        const { importSharedPassport } = await handlers();
        const { plantService, passport } = await primeHappyPath();
        vi.mocked(plantService.getPlantShare).mockResolvedValueOnce(null);
        expect((await call(importSharedPassport, importEvent())).statusCode).toBe(404);
        vi.mocked(plantService.getPlantShare).mockResolvedValueOnce(cuttingShare);
        expect((await call(importSharedPassport, importEvent())).statusCode).toBe(404);
        expect(passport.claimPassportImport).not.toHaveBeenCalled();
      });

      it('holds the plan cap: 402 like manual creation, and the claim is given back', async () => {
        const { importSharedPassport } = await handlers();
        const { plantService, passport } = await primeHappyPath();
        const billing = await import('../../../src/services/billing.js');
        vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({ planId: 'seedling' });
        vi.mocked(plantService.createPlant).mockRejectedValueOnce(
          Object.assign(new Error('Plant limit of 20 reached'), { name: 'PlanLimitError' })
        );

        const res = await call(importSharedPassport, importEvent());

        expect(res.statusCode).toBe(402);
        expect(res.body).toMatch(/Seedling plan is limited to 20 plants/);
        // The cap is passed to createPlant, not re-implemented here.
        expect(vi.mocked(plantService.createPlant).mock.calls[0][3]).toBe(20);
        expect(passport.releasePassportImport).toHaveBeenCalledWith('hh-1', CODE);
        expect(passport.recordPassportImport).not.toHaveBeenCalled();
      });

      it('gives the claim back on any other failure, and hides the error from the caller', async () => {
        const { importSharedPassport } = await handlers();
        const { plantService, passport } = await primeHappyPath();
        vi.mocked(plantService.createPlant).mockRejectedValueOnce(new Error('ddb exploded'));
        const res = await call(importSharedPassport, importEvent());
        expect(res.statusCode).toBe(500);
        expect(res.body).not.toContain('ddb exploded');
        expect(passport.releasePassportImport).toHaveBeenCalledWith('hh-1', CODE);
      });

      it('requires a signed-in member of a household', async () => {
        const { importSharedPassport } = await handlers();
        const { plantService } = await primeHappyPath();
        const res = await call(importSharedPassport, anonymous(importEvent()));
        expect(res.statusCode).toBe(401);
        expect(plantService.createPlant).not.toHaveBeenCalled();
      });

      it('records the same activity a cutting accept does, in the recipient household', async () => {
        const { importSharedPassport } = await handlers();
        await primeHappyPath();
        const activity = await import('../../../src/services/activity.js');
        await call(importSharedPassport, importEvent());
        expect(activity.recordActivity).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'plant.shared_accepted',
            householdId: 'hh-1',
            payload: expect.objectContaining({ fromHouseholdName: 'Source House' }),
          })
        );
      });
    });
  });
});
