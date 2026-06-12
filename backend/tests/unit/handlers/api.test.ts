import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/apiKeys.js', () => ({
  lookupApiKey: vi.fn(),
}));
vi.mock('../../../src/services/plantService.js');
vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/activity.js', () => ({
  recordActivity: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn((input: unknown) => ({ input, kind: 'Get' })),
}));

import * as apiKeysService from '../../../src/services/apiKeys.js';
import * as plantService from '../../../src/services/plantService.js';
import * as taskService from '../../../src/services/taskService.js';
import { recordActivity } from '../../../src/services/activity.js';
import { dynamodb } from '../../../src/utils/dynamodb.js';
import { __resetRateLimitForTests } from '../../../src/middleware/rateLimit.js';

const ALL_SCOPES = ['read:plants', 'read:tasks', 'read:activity'] as const;

const keyRecord = {
  id: 'key-1',
  householdId: 'hh-1',
  label: 'integration',
  last4: 'abcd',
  scopes: [...ALL_SCOPES] as Array<(typeof ALL_SCOPES)[number]>,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'user-1',
  lastUsedAt: null,
};

function buildEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: { authorization: 'Bearer fg_testkey' },
    httpMethod: 'GET',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/api/v1/me',
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      identity: { sourceIp: '127.0.0.1' },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

const ctx = {} as Context;

type LambdaFn = (e: unknown, c: Context, cb: () => void) => Promise<unknown>;

async function invoke(
  handler: unknown,
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  return (await (handler as LambdaFn)(event, ctx, () => {})) as APIGatewayProxyResult;
}

describe('public API v1 handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimitForTests();
    vi.mocked(apiKeysService.lookupApiKey).mockResolvedValue({ ...keyRecord });
  });

  describe('GET /api/v1/me', () => {
    it('returns the key household for a valid Bearer key', async () => {
      const { me } = await import('../../../src/handlers/api/handler.js');
      const res = await invoke(me, buildEvent());
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ householdId: 'hh-1', apiVersion: 'v1' });
      expect(apiKeysService.lookupApiKey).toHaveBeenCalledWith('fg_testkey');
    });

    it('also accepts the key via X-Api-Key', async () => {
      const { me } = await import('../../../src/handlers/api/handler.js');
      const res = await invoke(me, buildEvent({ headers: { 'x-api-key': 'fg_altkey' } }));
      expect(res.statusCode).toBe(200);
      expect(apiKeysService.lookupApiKey).toHaveBeenCalledWith('fg_altkey');
    });

    it('requires no scope — a key with zero scopes can still call /me', async () => {
      vi.mocked(apiKeysService.lookupApiKey).mockResolvedValue({ ...keyRecord, scopes: [] });
      const { me } = await import('../../../src/handlers/api/handler.js');
      const res = await invoke(me, buildEvent());
      expect(res.statusCode).toBe(200);
    });

    it('401s with a JSON body when no key is presented', async () => {
      const { me } = await import('../../../src/handlers/api/handler.js');
      const res = await invoke(me, buildEvent({ headers: {} }));
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ message: 'API key required' });
    });

    it('401s for an unknown/revoked key', async () => {
      vi.mocked(apiKeysService.lookupApiKey).mockResolvedValue(null);
      const { me } = await import('../../../src/handlers/api/handler.js');
      const res = await invoke(me, buildEvent());
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ message: 'Invalid API key' });
    });

    it('429s after the 60/min per-key budget is spent', async () => {
      const { me } = await import('../../../src/handlers/api/handler.js');
      for (let i = 0; i < 60; i++) {
        const res = await invoke(me, buildEvent());
        expect(res.statusCode).toBe(200);
      }
      const res = await invoke(me, buildEvent());
      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body).message).toMatch(/Too many requests/);
    });
  });

  describe('GET /api/v1/plants', () => {
    it('returns the household plants for a key with read:plants', async () => {
      vi.mocked(plantService.getPlants).mockResolvedValue([
        { id: 'p1', name: 'Monstera' },
      ] as never);
      const { listPlants } = await import('../../../src/handlers/api/handler.js');
      const res = await invoke(listPlants, buildEvent({ path: '/api/v1/plants' }));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([{ id: 'p1', name: 'Monstera' }]);
      expect(plantService.getPlants).toHaveBeenCalledWith('hh-1');
    });

    it('403s (naming the scope) when the key lacks read:plants', async () => {
      vi.mocked(apiKeysService.lookupApiKey).mockResolvedValue({
        ...keyRecord,
        scopes: ['read:tasks', 'read:activity'],
      });
      const { listPlants } = await import('../../../src/handlers/api/handler.js');
      const res = await invoke(listPlants, buildEvent({ path: '/api/v1/plants' }));
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).message).toContain('read:plants');
      expect(plantService.getPlants).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/plants/{id}', () => {
    it('returns a single plant scoped to the key household', async () => {
      vi.mocked(plantService.getPlant).mockResolvedValue({ id: 'p1', name: 'Fern' } as never);
      const { getPlant } = await import('../../../src/handlers/api/handler.js');
      const res = await invoke(
        getPlant,
        buildEvent({ path: '/api/v1/plants/p1', pathParameters: { id: 'p1' } })
      );
      expect(res.statusCode).toBe(200);
      expect(plantService.getPlant).toHaveBeenCalledWith('hh-1', 'p1');
    });

    it('404s when the plant does not exist in the key household', async () => {
      vi.mocked(plantService.getPlant).mockResolvedValue(null as never);
      const { getPlant } = await import('../../../src/handlers/api/handler.js');
      const res = await invoke(
        getPlant,
        buildEvent({ path: '/api/v1/plants/nope', pathParameters: { id: 'nope' } })
      );
      expect(res.statusCode).toBe(404);
    });

    it('is gated on read:plants', async () => {
      vi.mocked(apiKeysService.lookupApiKey).mockResolvedValue({
        ...keyRecord,
        scopes: ['read:tasks'],
      });
      const { getPlant } = await import('../../../src/handlers/api/handler.js');
      const res = await invoke(
        getPlant,
        buildEvent({ path: '/api/v1/plants/p1', pathParameters: { id: 'p1' } })
      );
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /api/v1/tasks', () => {
    it('is gated on read:tasks (403 without, 200 with)', async () => {
      const { listTasks } = await import('../../../src/handlers/api/handler.js');

      vi.mocked(apiKeysService.lookupApiKey).mockResolvedValue({
        ...keyRecord,
        scopes: ['read:plants'],
      });
      const denied = await invoke(listTasks, buildEvent({ path: '/api/v1/tasks' }));
      expect(denied.statusCode).toBe(403);
      expect(JSON.parse(denied.body).message).toContain('read:tasks');
      expect(taskService.getTasks).not.toHaveBeenCalled();

      vi.mocked(apiKeysService.lookupApiKey).mockResolvedValue({
        ...keyRecord,
        scopes: ['read:tasks'],
      });
      vi.mocked(taskService.getTasks).mockResolvedValue([] as never);
      const ok = await invoke(listTasks, buildEvent({ path: '/api/v1/tasks' }));
      expect(ok.statusCode).toBe(200);
      expect(taskService.getTasks).toHaveBeenCalledWith('hh-1');
    });
  });

  describe('GET /api/v1/activity', () => {
    it('is gated on read:activity', async () => {
      vi.mocked(apiKeysService.lookupApiKey).mockResolvedValue({
        ...keyRecord,
        scopes: ['read:plants', 'read:tasks'],
      });
      const { listActivity } = await import('../../../src/handlers/api/handler.js');
      const res = await invoke(listActivity, buildEvent({ path: '/api/v1/activity' }));
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).message).toContain('read:activity');
    });

    it('defaults limit to 50 and clamps it into [1, 200]', async () => {
      vi.mocked(taskService.getHouseholdActivity).mockResolvedValue([] as never);
      const { listActivity } = await import('../../../src/handlers/api/handler.js');

      await invoke(listActivity, buildEvent({ path: '/api/v1/activity' }));
      expect(taskService.getHouseholdActivity).toHaveBeenLastCalledWith('hh-1', 50);

      await invoke(
        listActivity,
        buildEvent({ path: '/api/v1/activity', queryStringParameters: { limit: '9999' } })
      );
      expect(taskService.getHouseholdActivity).toHaveBeenLastCalledWith('hh-1', 200);

      await invoke(
        listActivity,
        buildEvent({ path: '/api/v1/activity', queryStringParameters: { limit: 'abc' } })
      );
      expect(taskService.getHouseholdActivity).toHaveBeenLastCalledWith('hh-1', 50);
    });

    it('a legacy all-read key clears every scoped route', async () => {
      // Pre-scope keys are expanded to all read scopes by the service layer
      // (covered in services/apiKeys.test.ts); this verifies the expansion
      // satisfies each route gate end to end.
      vi.mocked(plantService.getPlants).mockResolvedValue([] as never);
      vi.mocked(taskService.getTasks).mockResolvedValue([] as never);
      vi.mocked(taskService.getHouseholdActivity).mockResolvedValue([] as never);
      const { listPlants, listTasks, listActivity } =
        await import('../../../src/handlers/api/handler.js');
      for (const [handler, path] of [
        [listPlants, '/api/v1/plants'],
        [listTasks, '/api/v1/tasks'],
        [listActivity, '/api/v1/activity'],
      ] as const) {
        const res = await invoke(handler, buildEvent({ path }));
        expect(res.statusCode).toBe(200);
      }
    });
  });

  describe('POST /api/v1/tasks/{id}/complete', () => {
    const writeKey = { ...keyRecord, scopes: ['write:tasks'] as never };
    const taskShape = { id: 't1', plantId: 'p1', plantName: 'Fern', type: 'water', frequency: 7 };

    it('completes the task as the explicit machine actor apikey:{keyId}', async () => {
      vi.mocked(apiKeysService.lookupApiKey).mockResolvedValue(writeKey);
      vi.mocked(taskService.completeTask).mockResolvedValue(taskShape as never);
      const { completeTask } = await import('../../../src/handlers/api/handler.js');
      const res = await invoke(
        completeTask,
        buildEvent({
          httpMethod: 'POST',
          path: '/api/v1/tasks/t1/complete',
          pathParameters: { id: 't1' },
        })
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).id).toBe('t1');
      // Actor: the synthetic key principal; display name: the key's label.
      expect(taskService.completeTask).toHaveBeenCalledWith(
        'hh-1',
        't1',
        'apikey:key-1',
        'integration',
        undefined
      );
    });

    it('passes optional notes from the body through to the service', async () => {
      vi.mocked(apiKeysService.lookupApiKey).mockResolvedValue(writeKey);
      vi.mocked(taskService.completeTask).mockResolvedValue(taskShape as never);
      const { completeTask } = await import('../../../src/handlers/api/handler.js');
      const res = await invoke(
        completeTask,
        buildEvent({
          httpMethod: 'POST',
          path: '/api/v1/tasks/t1/complete',
          pathParameters: { id: 't1' },
          headers: { authorization: 'Bearer fg_testkey', 'content-type': 'application/json' },
          body: JSON.stringify({ notes: 'watered via webhook' }),
        })
      );
      expect(res.statusCode).toBe(200);
      expect(taskService.completeTask).toHaveBeenCalledWith(
        'hh-1',
        't1',
        'apikey:key-1',
        'integration',
        'watered via webhook'
      );
    });

    it('404s when the task does not exist in the key household', async () => {
      vi.mocked(apiKeysService.lookupApiKey).mockResolvedValue(writeKey);
      vi.mocked(taskService.completeTask).mockResolvedValue(null as never);
      const { completeTask } = await import('../../../src/handlers/api/handler.js');
      const res = await invoke(
        completeTask,
        buildEvent({
          httpMethod: 'POST',
          path: '/api/v1/tasks/nope/complete',
          pathParameters: { id: 'nope' },
        })
      );
      expect(res.statusCode).toBe(404);
    });

    it('403s for a key without write:tasks — including a legacy all-read key', async () => {
      // keyRecord carries every READ scope (the legacy expansion); that must
      // never satisfy the write gate.
      vi.mocked(apiKeysService.lookupApiKey).mockResolvedValue({ ...keyRecord });
      const { completeTask } = await import('../../../src/handlers/api/handler.js');
      const res = await invoke(
        completeTask,
        buildEvent({
          httpMethod: 'POST',
          path: '/api/v1/tasks/t1/complete',
          pathParameters: { id: 't1' },
        })
      );
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).message).toContain('write:tasks');
      expect(taskService.completeTask).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/tasks/{id}/snooze', () => {
    const writeKey = { ...keyRecord, scopes: ['write:tasks'] as never };
    const taskShape = { id: 't1', plantId: 'p1', plantName: 'Fern', type: 'water', frequency: 7 };

    it('snoozes by the explicit number of days from the body', async () => {
      vi.mocked(apiKeysService.lookupApiKey).mockResolvedValue(writeKey);
      vi.mocked(taskService.getTask).mockResolvedValue(taskShape as never);
      vi.mocked(taskService.snoozeTask).mockResolvedValue(taskShape as never);
      const { snoozeTask } = await import('../../../src/handlers/api/handler.js');
      const res = await invoke(
        snoozeTask,
        buildEvent({
          httpMethod: 'POST',
          path: '/api/v1/tasks/t1/snooze',
          pathParameters: { id: 't1' },
          headers: { authorization: 'Bearer fg_testkey', 'content-type': 'application/json' },
          body: JSON.stringify({ days: 3 }),
        })
      );
      expect(res.statusCode).toBe(200);
      expect(taskService.snoozeTask).toHaveBeenCalledWith('hh-1', 't1', 3);
      // Writes via the API land in the activity feed attributed to the key.
      expect(recordActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'task.snoozed',
          householdId: 'hh-1',
          actorId: 'apikey:key-1',
          actorName: 'integration',
        })
      );
    });

    it('defaults omitted days to the task frequency (skip one cycle)', async () => {
      vi.mocked(apiKeysService.lookupApiKey).mockResolvedValue(writeKey);
      vi.mocked(taskService.getTask).mockResolvedValue(taskShape as never);
      vi.mocked(taskService.snoozeTask).mockResolvedValue(taskShape as never);
      const { snoozeTask } = await import('../../../src/handlers/api/handler.js');
      const res = await invoke(
        snoozeTask,
        buildEvent({
          httpMethod: 'POST',
          path: '/api/v1/tasks/t1/snooze',
          pathParameters: { id: 't1' },
        })
      );
      expect(res.statusCode).toBe(200);
      expect(taskService.snoozeTask).toHaveBeenCalledWith('hh-1', 't1', 7);
    });

    it('404s for an unknown task and rejects out-of-range days', async () => {
      vi.mocked(apiKeysService.lookupApiKey).mockResolvedValue(writeKey);
      vi.mocked(taskService.getTask).mockResolvedValue(null as never);
      const { snoozeTask } = await import('../../../src/handlers/api/handler.js');
      const missing = await invoke(
        snoozeTask,
        buildEvent({
          httpMethod: 'POST',
          path: '/api/v1/tasks/nope/snooze',
          pathParameters: { id: 'nope' },
        })
      );
      expect(missing.statusCode).toBe(404);

      const invalid = await invoke(
        snoozeTask,
        buildEvent({
          httpMethod: 'POST',
          path: '/api/v1/tasks/t1/snooze',
          pathParameters: { id: 't1' },
          headers: { authorization: 'Bearer fg_testkey', 'content-type': 'application/json' },
          body: JSON.stringify({ days: 0 }),
        })
      );
      expect(invalid.statusCode).toBe(400);
      expect(taskService.snoozeTask).not.toHaveBeenCalled();
    });

    it('is gated on write:tasks', async () => {
      vi.mocked(apiKeysService.lookupApiKey).mockResolvedValue({ ...keyRecord });
      const { snoozeTask } = await import('../../../src/handlers/api/handler.js');
      const res = await invoke(
        snoozeTask,
        buildEvent({
          httpMethod: 'POST',
          path: '/api/v1/tasks/t1/snooze',
          pathParameters: { id: 't1' },
        })
      );
      expect(res.statusCode).toBe(403);
      expect(taskService.snoozeTask).not.toHaveBeenCalled();
    });
  });

  describe('GET /health', () => {
    it('reports ok when the DDB probe succeeds, without requiring auth', async () => {
      vi.mocked(dynamodb.send).mockResolvedValue({} as never);
      const { health } = await import('../../../src/handlers/api/handler.js');
      const res = await invoke(health, buildEvent({ path: '/health', headers: {} }));
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('ok');
      expect(body.components.database.status).toBe('ok');
      expect(apiKeysService.lookupApiKey).not.toHaveBeenCalled();
    });

    it('degrades (still 200) when the DDB probe fails', async () => {
      vi.mocked(dynamodb.send).mockRejectedValue(new Error('ddb down') as never);
      const { health } = await import('../../../src/handlers/api/handler.js');
      const res = await invoke(health, buildEvent({ path: '/health', headers: {} }));
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('degraded');
      expect(body.components.database.status).toBe('error');
    });
  });
});
