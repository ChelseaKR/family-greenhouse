import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { api, getErrorMessage } from '@/services/api';
import { useAuthStore } from '@/store/authStore';
import { server, handlers } from '../../msw/server';

const API = 'http://localhost:4000';

describe('api interceptors', () => {
  it('attaches Authorization header from auth store', async () => {
    useAuthStore.setState({ accessToken: 'access-1' });
    let captured: string | null = null;
    server.use(
      http.get(`${API}/plants`, ({ request }) => {
        captured = request.headers.get('authorization');
        return HttpResponse.json([]);
      })
    );
    await api.get('/plants');
    expect(captured).toBe('Bearer access-1');
  });

  it('refreshes the token on a 401 and retries the original request', async () => {
    useAuthStore.setState({ accessToken: 'expired', refreshToken: 'refresh-1' });

    let plantCalls = 0;
    server.use(
      http.get(`${API}/plants`, ({ request }) => {
        plantCalls += 1;
        const auth = request.headers.get('authorization');
        if (auth === 'Bearer access-2') return HttpResponse.json([{ id: 'p1' }]);
        return HttpResponse.json({ message: 'Unauthorized' }, { status: 401 });
      }),
      handlers.authRefreshOk
    );

    const res = await api.get('/plants');
    expect(res.status).toBe(200);
    expect(plantCalls).toBe(2);
    expect(useAuthStore.getState().accessToken).toBe('access-2');
  });

  it('logs the user out when refresh itself fails', async () => {
    useAuthStore.setState({
      accessToken: 'expired',
      refreshToken: 'rotten',
      isAuthenticated: true,
      user: {
        id: 'u',
        email: 'e',
        name: 'n',
        householdId: null,
        householdRole: null,
      },
    });

    server.use(
      http.get(`${API}/plants`, () =>
        HttpResponse.json({ message: 'Unauthorized' }, { status: 401 })
      ),
      handlers.authRefreshFail
    );

    await expect(api.get('/plants')).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('does not loop on /auth/* 401s', async () => {
    let refreshCalls = 0;
    server.use(
      http.post(`${API}/auth/login`, () => HttpResponse.json({ message: 'bad' }, { status: 401 })),
      http.post(`${API}/auth/refresh`, () => {
        refreshCalls += 1;
        return HttpResponse.json({ accessToken: 'a', refreshToken: 'r' });
      })
    );
    await expect(api.post('/auth/login', { email: 'a', password: 'b' })).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(refreshCalls).toBe(0);
  });
});

describe('getErrorMessage', () => {
  it('extracts message field from axios error', () => {
    const err = {
      isAxiosError: true,
      response: { data: { message: 'boom' } },
      message: 'fallback',
    };
    expect(getErrorMessage(err)).toBe('boom');
  });

  it('falls back to error.message for plain errors', () => {
    expect(getErrorMessage(new Error('plain'))).toBe('plain');
  });

  it('handles unknowns gracefully', () => {
    expect(getErrorMessage('string')).toBe('An unexpected error occurred');
  });
});
