/**
 * Task write paths. The bodies matter more than the responses here: snooze
 * omits absent options rather than sending nulls, and completion/snooze echo
 * `expectedNextDue` so a transport retry can't double-advance an occurrence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { taskService } from '@/services/taskService';
import { firstDueIso, isOverdue, isToday } from '@/utils/date';
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

  /**
   * #346. The server's `createTask` falls back to `now` when the body names no
   * `nextDue`, and its overdue predicate is the instant comparison
   * `t.nextDue < now`. A task created without a date was therefore overdue one
   * second later on every backend surface — `GET /tasks?overdue=true`, the
   * sitter projection's red badge, the weekly digest's plants-at-risk — while
   * TasksPage said "Today", because it compares calendar days.
   *
   * These assert the wire body, which is the only thing the client controls,
   * against BOTH readings: the backend's instant comparison and the UI's
   * calendar-day one. They must agree, and the way to make them agree is to
   * name the end of the creator's local day rather than let the server guess.
   */
  describe('createTask first due date', () => {
    async function capturePostedBody(data: Parameters<typeof taskService.createTask>[0]) {
      let body: Record<string, unknown> = {};
      server.use(
        http.post(`${API}/tasks`, async ({ request }) => {
          body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(mockTask);
        })
      );
      await taskService.createTask(data);
      return body;
    }

    it('names a due date rather than leaving the server to default it to now', async () => {
      const body = await capturePostedBody({ plantId: 'p1', type: 'water', frequency: 7 });

      expect(typeof body.nextDue).toBe('string');
      expect(Number.isNaN(Date.parse(body.nextDue as string))).toBe(false);
    });

    it('does not create a task that is already overdue by the backend predicate', async () => {
      const body = await capturePostedBody({ plantId: 'p1', type: 'water', frequency: 7 });

      // `taskService.getTasks({ overdue: true })` -> `t.nextDue < now`, and
      // `getSitterTasks` -> `overdue: t.nextDue < nowIso`. Both must be false
      // for a task created this instant.
      expect(new Date(body.nextDue as string).getTime()).toBeGreaterThan(Date.now());
      expect(isOverdue(body.nextDue as string)).toBe(false);
    });

    it("still puts the first occurrence on today, so the UI's label stays true", async () => {
      const body = await capturePostedBody({ plantId: 'p1', type: 'water', frequency: 7 });

      expect(isToday(body.nextDue as string)).toBe(true);
    });

    it('never overwrites a due date the caller chose', async () => {
      const chosen = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      const body = await capturePostedBody({
        plantId: 'p1',
        type: 'water',
        frequency: 7,
        nextDue: chosen,
      });

      expect(body.nextDue).toBe(chosen);
    });
  });

  describe('firstDueIso', () => {
    it('is the last instant of the local day, not the instant asked about', () => {
      const created = new Date(2026, 5, 9, 14, 32, 7, 0);
      const due = new Date(firstDueIso(created));

      expect(due.getTime()).toBeGreaterThan(created.getTime());
      expect(due.getFullYear()).toBe(2026);
      expect(due.getMonth()).toBe(5);
      expect(due.getDate()).toBe(9);
      expect(due.getHours()).toBe(23);
      expect(due.getMinutes()).toBe(59);
    });

    it('does not roll into tomorrow for a task created a second before midnight', () => {
      const created = new Date(2026, 5, 9, 23, 59, 58, 0);
      const due = new Date(firstDueIso(created));

      expect(due.getDate()).toBe(9);
      expect(due.getTime()).toBeGreaterThan(created.getTime());
    });
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

  it('askFamily omits an absent note and pins the occurrence it is asking about', async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/tasks/t1/ask`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          task: mockTask,
          note: null,
          askedAt: '2026-08-09T00:00:00.000Z',
          nextAllowedAt: '2026-08-10T00:00:00.000Z',
          recipients: [{ userId: 'u2', name: 'Priya' }],
          skipped: [],
          delivered: 1,
        });
      })
    );

    const result = await taskService.askFamily('t1', undefined, '2026-08-10');

    // A blank note is left out entirely rather than sent as '' — the server
    // treats "no note" as a real state, not an empty string.
    expect(body).toEqual({ expectedNextDue: '2026-08-10' });
    expect(result.delivered).toBe(1);
    expect(result.recipients).toEqual([{ userId: 'u2', name: 'Priya' }]);
  });

  it('askFamily sends the note when there is one', async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/tasks/t1/ask`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          task: mockTask,
          note: 'travelling',
          askedAt: '',
          nextAllowedAt: '',
          recipients: [],
          skipped: [{ userId: 'u2', name: 'Priya', reason: 'dnd' }],
          delivered: 0,
        });
      })
    );

    const result = await taskService.askFamily('t1', 'travelling', '2026-08-10');

    expect(body).toEqual({ note: 'travelling', expectedNextDue: '2026-08-10' });
    // Reaching nobody comes back as data, not as an error.
    expect(result.recipients).toEqual([]);
    expect(result.skipped).toEqual([{ userId: 'u2', name: 'Priya', reason: 'dnd' }]);
  });

  it('surfaces a 429 when this member already asked about the task today', async () => {
    server.use(
      http.post(`${API}/tasks/t1/ask`, () =>
        HttpResponse.json(
          {
            message: 'You already asked about this task today.',
            details: { nextAllowedAt: '2026-08-10T00:00:00.000Z' },
          },
          { status: 429 }
        )
      )
    );

    await expect(taskService.askFamily('t1')).rejects.toMatchObject({
      response: { status: 429 },
    });
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
