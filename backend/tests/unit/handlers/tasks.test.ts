import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/plantService.js');

function buildEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
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
          sub: 'user-1',
          email: 'a@b.com',
          'custom:household_id': 'hh-1',
          'custom:household_role': 'admin',
        },
      },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

const fakeContext = {} as Context;

describe('tasks handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('listTasks parses query string filters', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const { listTasks } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(taskService.getTasks).mockResolvedValueOnce([]);

    const event = buildEvent({
      queryStringParameters: { plantId: 'p1', dueWithin: '14', overdue: 'true' },
    });
    const res = (await listTasks(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(taskService.getTasks).toHaveBeenCalledWith('hh-1', {
      plantId: 'p1',
      dueWithin: 14,
      overdue: true,
    });
  });

  it('getUpcomingTasks queries 7-day window', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const { getUpcomingTasks } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(taskService.getUpcomingTasks).mockResolvedValueOnce([]);
    const res = (await getUpcomingTasks(
      buildEvent(),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(taskService.getUpcomingTasks).toHaveBeenCalledWith('hh-1');
  });

  it('createTask 404s when plant not found', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const { createTask } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(plantService.getPlant).mockResolvedValueOnce(null);
    const event = buildEvent({
      httpMethod: 'POST',
      body: JSON.stringify({
        plantId: '11111111-1111-1111-1111-111111111111',
        type: 'water',
        frequency: 7,
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await createTask(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
  });

  it('createTask creates task with plant name', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const taskService = await import('../../../src/services/taskService.js');
    const { createTask } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(plantService.getPlant).mockResolvedValueOnce({
      id: 'p1',
      householdId: 'hh-1',
      name: 'Pothos',
      species: null,
      location: null,
      imageUrl: null,
      notes: null,
      createdAt: '',
      createdBy: '',
      updatedAt: '',
    });
    vi.mocked(taskService.createTask).mockResolvedValueOnce({
      id: 't1',
      householdId: 'hh-1',
      plantId: 'p1',
      plantName: 'Pothos',
      type: 'water',
      customType: null,
      frequency: 7,
      lastCompleted: null,
      nextDue: '',
      assignedTo: null,
      assignedToName: null,
      notes: null,
      createdBy: 'user-1',
      createdAt: '',
    });
    const event = buildEvent({
      httpMethod: 'POST',
      body: JSON.stringify({
        plantId: '11111111-1111-1111-1111-111111111111',
        type: 'water',
        frequency: 7,
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await createTask(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(201);
    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        plantId: '11111111-1111-1111-1111-111111111111',
        type: 'water',
        frequency: 7,
      }),
      'hh-1',
      'user-1',
      'Pothos'
    );
  });

  it('completeTask handles JSON-parsed body without re-parsing', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const { completeTask } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(taskService.completeTask).mockResolvedValueOnce({
      id: 't1',
      householdId: 'hh-1',
      plantId: 'p1',
      plantName: 'Pothos',
      type: 'water',
      customType: null,
      frequency: 7,
      lastCompleted: '',
      nextDue: '',
      assignedTo: null,
      assignedToName: null,
      notes: null,
      createdBy: '',
      createdAt: '',
    });
    // Regression: when Content-Type: application/json, the body parser middleware
    // turns event.body into an object. The handler used to call JSON.parse on
    // that object, throwing TypeError. Pass JSON content type to exercise that path.
    const event = buildEvent({
      httpMethod: 'POST',
      pathParameters: { id: 't1' },
      body: JSON.stringify({ notes: 'done' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await completeTask(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(taskService.completeTask).toHaveBeenCalledWith('hh-1', 't1', 'user-1', 'a', 'done');
  });

  it('completeTask returns 404 when task missing', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const { completeTask } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(taskService.completeTask).mockResolvedValueOnce(null);
    const event = buildEvent({
      httpMethod: 'POST',
      pathParameters: { id: 'missing' },
      // completeTask now validates the body via Zod (completeTaskSchema);
      // the frontend always sends `{}` (or `{ notes }`), never bare null.
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await completeTask(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
  });

  it('updateTask returns 404 when missing', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const { updateTask } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(taskService.updateTask).mockResolvedValueOnce(null);
    const event = buildEvent({
      httpMethod: 'PUT',
      pathParameters: { id: 't' },
      body: JSON.stringify({ frequency: 14 }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await updateTask(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
  });

  it('snoozeTask 404s when missing', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const { snoozeTask } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(taskService.snoozeTask).mockResolvedValueOnce(null);
    const event = buildEvent({
      httpMethod: 'POST',
      pathParameters: { id: 't' },
      body: JSON.stringify({ days: 3 }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await snoozeTask(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
  });

  it('snoozeTask validates days bounds', async () => {
    const { snoozeTask } = await import('../../../src/handlers/tasks/handler.js');
    const event = buildEvent({
      httpMethod: 'POST',
      pathParameters: { id: 't' },
      body: JSON.stringify({ days: 0 }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await snoozeTask(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
  });

  it('snoozeTask returns updated task on success', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const { snoozeTask } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(taskService.snoozeTask).mockResolvedValueOnce({
      id: 't',
      householdId: 'hh-1',
      plantId: 'p',
      plantName: 'P',
      type: 'water',
      customType: null,
      frequency: 7,
      lastCompleted: null,
      nextDue: '2026-05-04',
      assignedTo: null,
      assignedToName: null,
      notes: null,
      createdBy: '',
      createdAt: '',
    });
    const event = buildEvent({
      httpMethod: 'POST',
      pathParameters: { id: 't' },
      body: JSON.stringify({ days: 3 }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await snoozeTask(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(taskService.snoozeTask).toHaveBeenCalledWith('hh-1', 't', 3);
  });

  it('deleteTask 404s and 204s correctly', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const { deleteTask } = await import('../../../src/handlers/tasks/handler.js');

    vi.mocked(taskService.getTask).mockResolvedValueOnce(null);
    const missing = (await deleteTask(
      buildEvent({ httpMethod: 'DELETE', pathParameters: { id: 'x' } }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(missing.statusCode).toBe(404);

    vi.mocked(taskService.getTask).mockResolvedValueOnce({
      id: 't1',
      householdId: 'hh-1',
      plantId: 'p1',
      plantName: 'Pothos',
      type: 'water',
      customType: null,
      frequency: 7,
      lastCompleted: null,
      nextDue: '',
      assignedTo: null,
      assignedToName: null,
      notes: null,
      createdBy: '',
      createdAt: '',
    });
    vi.mocked(taskService.deleteTask).mockResolvedValueOnce(undefined);
    const ok = (await deleteTask(
      buildEvent({ httpMethod: 'DELETE', pathParameters: { id: 't1' } }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(ok.statusCode).toBe(204);
  });
});
