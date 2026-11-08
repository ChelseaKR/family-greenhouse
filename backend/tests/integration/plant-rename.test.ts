/**
 * A task row keeps its own copy of the plant's name, written when the task is
 * created. Task lists, the sitter, caretaker and kiosk pages and the calendar
 * feed all read that copy, so renaming a plant has to reach it. Real handlers, DynamoDB faked at the SDK boundary.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDynamo } from './support/inMemoryDynamo.js';
import { invokeHandler } from './support/invokeHandler.js';
import { seedHousehold } from './support/seed.js';

const store = createInMemoryDynamo();
vi.mock('../../src/utils/dynamodb.js', () => ({
  dynamodb: store.client,
  TABLE_NAME: 'test-table',
}));

const ADMIN = { userId: 'user-admin', email: 'admin@example.com', name: 'Ada Admin' };

beforeEach(async () => {
  store.reset();
  vi.restoreAllMocks();
  console.log = () => {};
  const { __resetMembershipCacheForTests } = await import('../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
});

type TaskRow = { id: string; plantId: string; plantName: string };

async function setUp() {
  const plantsHandler = await import('../../src/handlers/plants/handler.js');
  const tasksHandler = await import('../../src/handlers/tasks/handler.js');
  const { householdId } = await seedHousehold(store, { admin: ADMIN });
  const identity = { ...ADMIN, householdId };

  const addPlant = async (name: string) => {
    const created = await invokeHandler(plantsHandler.createPlant, {
      method: 'POST',
      routeKey: 'POST /plants',
      identity,
      body: { name },
    });
    expect(created.statusCode).toBe(201);
    return (created.body as { id: string }).id;
  };
  const addTask = async (plantId: string, type: string) => {
    const created = await invokeHandler(tasksHandler.createTask, {
      method: 'POST',
      routeKey: 'POST /tasks',
      identity,
      body: { plantId, type, frequency: 7 },
    });
    expect(created.statusCode).toBe(201);
  };
  const editPlant = (plantId: string, body: Record<string, unknown>) =>
    invokeHandler(plantsHandler.updatePlant, {
      method: 'PUT',
      routeKey: 'PUT /plants/{id}',
      pathParameters: { id: plantId },
      identity,
      body,
    });
  const listTasks = async () => {
    const listed = await invokeHandler(tasksHandler.listTasks, {
      method: 'GET',
      routeKey: 'GET /tasks',
      identity,
    });
    expect(listed.statusCode).toBe(200);
    return listed.body as TaskRow[];
  };
  return { householdId, addPlant, addTask, editPlant, listTasks };
}

describe('renaming a plant', () => {
  it("puts the new name on all of that plant's tasks and on nobody else's", async () => {
    const { addPlant, addTask, editPlant, listTasks } = await setUp();
    const fern = await addPlant('Fern');
    const ivy = await addPlant('Ivy');
    await addTask(fern, 'water');
    await addTask(fern, 'fertilize');
    await addTask(ivy, 'water');

    const renamed = await editPlant(fern, { name: 'Boston Fern' });
    expect(renamed.statusCode).toBe(200);

    const names = (await listTasks()).map((task) => [task.plantId, task.plantName]);
    expect(names.filter(([plantId]) => plantId === fern)).toEqual([
      [fern, 'Boston Fern'],
      [fern, 'Boston Fern'],
    ]);
    expect(names.filter(([plantId]) => plantId === ivy)).toEqual([[ivy, 'Ivy']]);
  });

  it('reaches what a sitter is shown', async () => {
    const { householdId, addPlant, addTask, editPlant } = await setUp();
    const fern = await addPlant('Fern');
    await addTask(fern, 'water');

    await editPlant(fern, { name: 'Boston Fern' });

    const taskService = await import('../../src/services/taskService.js');
    const tasks = await taskService.getSitterTasks(
      householdId,
      new Date(Date.now() + 30 * 86_400_000).toISOString()
    );
    expect(tasks.map((task) => task.plantName)).toEqual(['Boston Fern']);
  });

  it('heals a task left behind by an earlier rename the next time the plant is saved', async () => {
    const { householdId, addPlant, addTask, editPlant, listTasks } = await setUp();
    const fern = await addPlant('Boston Fern');
    await addTask(fern, 'water');
    const [row] = await listTasks();
    const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
    await store.client.send(
      new UpdateCommand({
        TableName: 'test-table',
        Key: { PK: `HOUSEHOLD#${householdId}`, SK: `TASK#${row.id}` },
        UpdateExpression: 'SET plantName = :old',
        ExpressionAttributeValues: { ':old': 'Fern' },
      })
    );
    expect((await listTasks())[0].plantName).toBe('Fern');

    await editPlant(fern, { name: 'Boston Fern' });

    expect((await listTasks())[0].plantName).toBe('Boston Fern');
  });

  it('answers with an error rather than success when a task could not be updated, so a retry can finish', async () => {
    const { addPlant, addTask, editPlant, listTasks } = await setUp();
    const fern = await addPlant('Fern');
    await addTask(fern, 'water');
    const send = store.client.send.bind(store.client);
    const failing = vi
      .spyOn(store.client, 'send')
      .mockImplementation(((command: { input: { UpdateExpression?: string } }) =>
        command.input.UpdateExpression?.includes('#plantName')
          ? Promise.reject(new Error('throttled'))
          : send(command as never)) as never);

    const refused = await editPlant(fern, { name: 'Boston Fern' });
    expect(refused.statusCode).toBeGreaterThanOrEqual(500);
    expect((await listTasks())[0].plantName).toBe('Fern');

    failing.mockRestore();
    const retried = await editPlant(fern, { name: 'Boston Fern' });
    expect(retried.statusCode).toBe(200);
    expect((await listTasks())[0].plantName).toBe('Boston Fern');
  });

  it('does not bring back a task deleted while the rename ran', async () => {
    const { householdId, addPlant, addTask, listTasks } = await setUp();
    const fern = await addPlant('Fern');
    await addTask(fern, 'water');
    const [row] = await listTasks();
    const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
    const taskService = await import('../../src/services/taskService.js');
    const send = store.client.send.bind(store.client);
    const deleteFirst = vi.spyOn(store.client, 'send').mockImplementation((async (command: {
      input: { UpdateExpression?: string };
    }) => {
      if (command.input.UpdateExpression?.includes('#plantName')) {
        await send(
          new DeleteCommand({
            TableName: 'test-table',
            Key: { PK: `HOUSEHOLD#${householdId}`, SK: `TASK#${row.id}` },
          }) as never
        );
      }
      return send(command as never);
    }) as never);

    await expect(
      taskService.syncPlantNameOnTasks(householdId, fern, 'Boston Fern')
    ).resolves.toBeUndefined();

    deleteFirst.mockRestore();
    // The row itself: a list reading only whole tasks would hide a stray stub.
    const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
    const raw = await store.client.send(
      new GetCommand({
        TableName: 'test-table',
        Key: { PK: `HOUSEHOLD#${householdId}`, SK: `TASK#${row.id}` },
      })
    );
    expect(raw.Item).toBeUndefined();
  });

  it('does not touch tasks on an edit that leaves the name out', async () => {
    const { addPlant, addTask, editPlant } = await setUp();
    const fern = await addPlant('Fern');
    await addTask(fern, 'water');
    const send = vi.spyOn(store.client, 'send');

    await editPlant(fern, { careRule: 'Bottom-water only' });

    const wrote = send.mock.calls.some(([command]) =>
      (command as { input: { UpdateExpression?: string } }).input.UpdateExpression?.includes(
        '#plantName'
      )
    );
    expect(wrote).toBe(false);
  });
});
