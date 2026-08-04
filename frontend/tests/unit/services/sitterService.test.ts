/**
 * The public plant-sitter client. It deliberately bypasses the axios instance
 * (and therefore the auth header + 401-refresh interceptors) because a sitter
 * is anonymous — the path token is the only credential.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { SitterLinkInactiveError, sitterService } from '@/services/sitterService';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

const task = {
  taskId: 't1',
  plantName: 'Pothos',
  taskType: 'water',
  dueDate: '2026-08-04',
  spaceName: 'Sunroom',
  placementNote: 'On the high shelf',
  overdue: false,
};

describe('sitterService.getView', () => {
  beforeEach(() => {
    // A signed-in session must not leak into the anonymous sitter request.
    useAuthStore.setState({ accessToken: 'access-1', idToken: 'id-1' });
  });

  it('fetches the time-boxed view without an Authorization header', async () => {
    let authorization: string | null = 'unset';
    server.use(
      http.get(`${API}/sitter/tok-1`, ({ request }) => {
        authorization = request.headers.get('authorization');
        return HttpResponse.json({ label: 'Neighbor', expiresAt: '2026-08-20', tasks: [task] });
      })
    );

    const view = await sitterService.getView('tok-1');

    expect(authorization).toBeNull();
    expect(view.tasks[0].placementNote).toBe('On the high shelf');
  });

  it('URL-encodes the token instead of interpolating it raw', async () => {
    let path = '';
    server.use(
      http.get(`${API}/sitter/:token`, ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ label: null, expiresAt: '2026-08-20', tasks: [] });
      })
    );

    await sitterService.getView('a/b c');

    expect(path).toBe('/sitter/a%2Fb%20c');
  });

  it('maps 404 and 410 to a friendly inactive-link error', async () => {
    for (const status of [404, 410]) {
      server.use(http.get(`${API}/sitter/tok-1`, () => new HttpResponse(null, { status })));
      await expect(sitterService.getView('tok-1')).rejects.toBeInstanceOf(SitterLinkInactiveError);
    }
  });

  it('surfaces other failures with their status', async () => {
    server.use(http.get(`${API}/sitter/tok-1`, () => new HttpResponse(null, { status: 500 })));

    await expect(sitterService.getView('tok-1')).rejects.toThrow('Sitter view failed (500)');
  });

  it('passes an abort signal through to fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    server.use(
      http.get(`${API}/sitter/tok-1`, () =>
        HttpResponse.json({ label: null, expiresAt: '', tasks: [] })
      )
    );

    await expect(sitterService.getView('tok-1', controller.signal)).rejects.toThrow();
  });
});

describe('sitterService.completeTask', () => {
  it('echoes the expected next due date for retry idempotency', async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/sitter/tok-1/tasks/t1/complete`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...task, dueDate: '2026-08-11' });
      })
    );

    const updated = await sitterService.completeTask('tok-1', 't1', '2026-08-04');

    expect(body).toEqual({ expectedNextDue: '2026-08-04' });
    expect(updated.dueDate).toBe('2026-08-11');
  });

  it('reports an expired link rather than a generic failure', async () => {
    server.use(
      http.post(
        `${API}/sitter/tok-1/tasks/t1/complete`,
        () => new HttpResponse(null, { status: 410 })
      )
    );

    await expect(sitterService.completeTask('tok-1', 't1', '2026-08-04')).rejects.toBeInstanceOf(
      SitterLinkInactiveError
    );
  });

  it('surfaces a conflicting completion with its status', async () => {
    server.use(
      http.post(
        `${API}/sitter/tok-1/tasks/t1/complete`,
        () => new HttpResponse(null, { status: 409 })
      )
    );

    await expect(sitterService.completeTask('tok-1', 't1', '2026-08-04')).rejects.toThrow(
      'Sitter completion failed (409)'
    );
  });
});
