import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { taskService } from '@/services/taskService';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

const mockTask = {
  id: 't1',
  plantId: 'p1',
  plantName: 'Pothos',
  type: 'water' as const,
  customType: undefined,
  frequency: 7,
  lastCompleted: null,
  nextDue: '2026-05-01',
  assignedTo: null,
  assignedToName: null,
  notes: null,
  createdBy: 'u1',
  createdAt: '',
};

describe('taskService', () => {
  it('getTasks forwards filter query parameters', async () => {
    useAuthStore.setState({ accessToken: 'access-1' });
    let receivedUrl = '';
    server.use(
      http.get(`${API}/tasks`, ({ request }) => {
        receivedUrl = request.url;
        return HttpResponse.json([mockTask]);
      })
    );
    await taskService.getTasks({ plantId: 'p1', overdue: true });
    expect(receivedUrl).toContain('plantId=p1');
    expect(receivedUrl).toContain('overdue=true');
  });

  it('getUpcomingTasks returns array', async () => {
    useAuthStore.setState({ accessToken: 'access-1' });
    server.use(http.get(`${API}/tasks/upcoming`, () => HttpResponse.json([mockTask])));
    const tasks = await taskService.getUpcomingTasks();
    expect(tasks).toHaveLength(1);
  });

  it('completeTask POSTs to /:id/complete', async () => {
    useAuthStore.setState({ accessToken: 'access-1' });
    let called = false;
    server.use(
      http.post(`${API}/tasks/t1/complete`, () => {
        called = true;
        return HttpResponse.json(mockTask);
      })
    );
    await taskService.completeTask('t1');
    expect(called).toBe(true);
  });
});
