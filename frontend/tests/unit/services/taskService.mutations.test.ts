/**
 * Task write paths. The bodies matter more than the responses here: snooze
 * omits absent options rather than sending nulls, and completion/snooze echo
 * `expectedNextDue` so a transport retry can't double-advance an occurrence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { taskService } from '@/services/taskService';
import { track } from '@/services/analytics';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

vi.mock('@/services/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/analytics')>();
  return { ...actual, track: vi.fn() };
});

const API = 'http://localhost:4000';

const mockTask = {
  id: 't1',
  plantId: 'p1',
  plantName: 'Pothos',
  type: 'water' as const,
  frequency: 7,
  lastCompleted: null,
  nextDue: '2026-08-10',
  assignedTo: null,
  assignedToName: null,
  notes: null,
  createdBy: 'u1',
  createdAt: '',
};

describe('taskService reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ accessToken: 'access-1' });
  });

  it('getTask fetches a single occurrence', async () => {
    server.use(http.get(`${API}/tasks/t1`, () => HttpResponse.json(mockTask)));

    await expect(taskService.getTask('t1')).resolves.toMatchObject({ id: 't1' });
  });

  it('getTasks omits filters the caller did not set', async () => {
    let receivedUrl = '';
    server.use(
      http.get(`${API}/tasks`, ({ request }) => {
        receivedUrl = request.url;
        return HttpResponse.json([mockTask]);
      })
    );

    await taskService.getTasks({ assignedTo: 'u1', dueWithin: 3 });

    expect(receivedUrl).toContain('assignedTo=u1');
    expect(receivedUrl).toContain('dueWithin=3');
    expect(receivedUrl).not.toContain('plantId');
    expect(receivedUrl).not.toContain('overdue');
  });

  it('getTasks sends overdue=false, which is meaningful, not absent', async () => {
    let receivedUrl = '';
    server.use(
      http.get(`${API}/tasks`, ({ request }) => {
        receivedUrl = request.url;
        return HttpResponse.json([]);
      })
    );

    await taskService.getTasks({ overdue: false });

    expect(receivedUrl).toContain('overdue=false');
  });

  it('listTemplates returns the curated bundles', async () => {
    server.use(
      http.get(`${API}/tasks/templates`, () =>
        HttpResponse.json([
          { id: 'tropical', name: 'Tropical', description: '', suitsKeywords: [], tasks: [] },
        ])
      )
    );

    await expect(taskService.listTemplates()).resolves.toHaveLength(1);
  });
});

describe('taskService writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ accessToken: 'access-1' });
  });

  it('createTask reports the task type to analytics', async () => {
    server.use(http.post(`${API}/tasks`, () => HttpResponse.json(mockTask)));

    await taskService.createTask({ plantId: 'p1', type: 'fertilize', frequency: 30 });

    expect(track).toHaveBeenCalledWith('task_created', { taskType: 'fertilize' });
  });

  it('updateTask PUTs the partial patch it was given', async () => {
    let body: unknown;
    server.use(
      http.put(`${API}/tasks/t1`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...mockTask, assignedTo: null });
      })
    );

    await taskService.updateTask('t1', { assignedTo: null, frequency: 14 });

    expect(body).toEqual({ assignedTo: null, frequency: 14 });
  });

  it('deleteTask and cancelVacation issue DELETEs', async () => {
    const hit: string[] = [];
    server.use(
      http.delete(`${API}/tasks/t1`, () => {
        hit.push('task');
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete(`${API}/tasks/vacation/u1`, () => {
        hit.push('vacation');
        return new HttpResponse(null, { status: 204 });
      })
    );

    await taskService.deleteTask('t1');
    await taskService.cancelVacation('u1');

    expect(hit).toEqual(['task', 'vacation']);
  });

  it('snoozeTask sends only the options the caller supplied', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${API}/tasks/t1/snooze`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(mockTask);
      })
    );

    await taskService.snoozeTask('t1', 3);
    await taskService.snoozeTask('t1', 1, {
      reason: 'rain',
      note: 'storm forecast',
      expectedNextDue: '2026-08-10',
    });

    expect(bodies[0]).toEqual({ days: 3 });
    expect(bodies[1]).toEqual({
      days: 1,
      reason: 'rain',
      note: 'storm forecast',
      expectedNextDue: '2026-08-10',
    });
    expect(track).toHaveBeenCalledTimes(2);
  });

  it('completeTask forwards notes and the idempotency echo', async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/tasks/t1/complete`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(mockTask);
      })
    );

    await taskService.completeTask('t1', {
      notes: 'looked thirsty',
      expectedNextDue: '2026-08-10',
    });

    expect(body).toEqual({ notes: 'looked thirsty', expectedNextDue: '2026-08-10' });
    expect(track).toHaveBeenCalledWith('task_completed', { taskType: 'water' });
  });

  it('claim and unclaim post empty bodies to their own routes', async () => {
    const hit: string[] = [];
    server.use(
      http.post(`${API}/tasks/t1/claim`, () => {
        hit.push('claim');
        return HttpResponse.json({ ...mockTask, assignedTo: 'u1' });
      }),
      http.post(`${API}/tasks/t1/unclaim`, () => {
        hit.push('unclaim');
        return HttpResponse.json(mockTask);
      })
    );

    await expect(taskService.claimTask('t1')).resolves.toMatchObject({ assignedTo: 'u1' });
    await expect(taskService.unclaimTask('t1')).resolves.toMatchObject({ assignedTo: null });
    expect(hit).toEqual(['claim', 'unclaim']);
  });

  it('surfaces a 409 when someone else claimed the task first', async () => {
    server.use(
      http.post(`${API}/tasks/t1/claim`, () =>
        HttpResponse.json({ message: 'Already claimed' }, { status: 409 })
      )
    );

    await expect(taskService.claimTask('t1')).rejects.toMatchObject({
      response: { status: 409 },
    });
  });

  it('setVacation PUTs the handoff window', async () => {
    let body: unknown;
    server.use(
      http.put(`${API}/tasks/vacation`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          householdId: 'hh-1',
          userId: 'u1',
          coveredBy: 'u2',
          coveredByName: 'Sam',
          startDate: '2026-08-10',
          endDate: '2026-08-20',
          createdBy: 'u1',
          createdAt: '',
        });
      })
    );

    const window = await taskService.setVacation({
      coveredBy: 'u2',
      startDate: '2026-08-10',
      endDate: '2026-08-20',
    });

    expect(body).toEqual({ coveredBy: 'u2', startDate: '2026-08-10', endDate: '2026-08-20' });
    expect(window.coveredByName).toBe('Sam');
  });

  it('getVacationWindows lists active handoffs', async () => {
    server.use(http.get(`${API}/tasks/vacation`, () => HttpResponse.json([])));

    await expect(taskService.getVacationWindows()).resolves.toEqual([]);
  });

  it('applyTemplate posts the template id to the plant route', async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/plants/p1/apply-template`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ created: [mockTask] });
      })
    );

    await expect(taskService.applyTemplate('p1', 'tropical')).resolves.toMatchObject({
      created: [{ id: 't1' }],
    });
    expect(body).toEqual({ templateId: 'tropical' });
  });

  it('applyTemplateBulk reports applied and skipped plants separately', async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/plants/apply-template-bulk`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          applied: [{ plantId: 'p1', taskIds: ['t1'] }],
          skipped: [{ plantId: 'p2', reason: 'already has tasks' }],
        });
      })
    );

    const result = await taskService.applyTemplateBulk(['p1', 'p2'], 'tropical');

    expect(body).toEqual({ plantIds: ['p1', 'p2'], templateId: 'tropical' });
    expect(result.applied).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('already has tasks');
  });
});
