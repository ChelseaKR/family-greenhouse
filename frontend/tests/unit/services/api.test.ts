import { describe, expect, it, vi } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { AxiosError } from 'axios';
import { api, getErrorMessage } from '@/services/api';
import { useAuthStore } from '@/store/authStore';
import { server, handlers } from '../../msw/server';

const API = 'http://localhost:4000';

/** /plants that 401s unless presented the given bearer token. */
function plantsGatedBy(validBearer: string) {
  return http.get(`${API}/plants`, ({ request }) => {
    if (request.headers.get('authorization') !== `Bearer ${validBearer}`) {
      return HttpResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }
    return HttpResponse.json([{ id: 'p1', name: 'Pothos' }]);
  });
}

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

describe('401 refresh queue', () => {
  it('coalesces concurrent 401s into a single refresh and retries all originals', async () => {
    let refreshCalls = 0;
    server.use(
      plantsGatedBy('id-2'),
      http.post(`${API}/auth/refresh`, async () => {
        refreshCalls += 1;
        // Long enough that every concurrent 401 lands while the refresh is
        // still in flight — the scenario that used to fall through to
        // Promise.reject for all but the first request.
        await delay(100);
        return HttpResponse.json({
          idToken: 'id-2',
          accessToken: 'access-2',
          refreshToken: 'refresh-2',
        });
      })
    );
    useAuthStore.setState({
      idToken: 'expired',
      accessToken: 'expired',
      refreshToken: 'refresh-1',
    });

    const [a, b, c] = await Promise.all([
      api.get('/plants'),
      api.get('/plants'),
      api.get('/plants'),
    ]);

    expect(refreshCalls).toBe(1);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(200);
    expect(useAuthStore.getState().idToken).toBe('id-2');
    expect(useAuthStore.getState().refreshToken).toBe('refresh-2');
  });

  it('rejects all waiters and logs out exactly once when the refresh fails', async () => {
    let refreshCalls = 0;
    server.use(
      plantsGatedBy('never-issued'),
      http.post(`${API}/auth/refresh`, async () => {
        refreshCalls += 1;
        await delay(100);
        return HttpResponse.json({ message: 'Bad refresh' }, { status: 401 });
      })
    );
    useAuthStore.setState({
      idToken: 'expired',
      accessToken: 'expired',
      refreshToken: 'refresh-1',
    });
    const logoutSpy = vi.spyOn(useAuthStore.getState(), 'logout');

    const results = await Promise.allSettled([api.get('/plants'), api.get('/plants')]);

    expect(refreshCalls).toBe(1);
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('rejected');
    expect(logoutSpy).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    logoutSpy.mockRestore();
  });
});

describe('tab-local session clearing (multi-tab logout cascade)', () => {
  it('clears only this tab when there is no refresh token — no localStorage rewrite', async () => {
    server.use(plantsGatedBy('never-issued'));
    // Persist a session the "other tabs" depend on…
    useAuthStore.getState().setTokens('id-1', 'access-1', 'refresh-1');
    expect(localStorage.getItem('auth-storage')).toContain('id-1');
    // …then simulate a freshly-opened tab: idToken inherited from
    // localStorage, but the sessionStorage-only refresh token is absent.
    useAuthStore.setState({ refreshToken: null });

    await expect(api.get('/plants')).rejects.toMatchObject({ response: { status: 401 } });

    // This tab's in-memory session is gone…
    expect(useAuthStore.getState().idToken).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    // …but the shared localStorage payload was NOT rewritten, so other tabs
    // (holding valid refresh tokens) are not cascaded into logout.
    expect(localStorage.getItem('auth-storage')).toContain('id-1');
  });

  it('explicit logout still rewrites localStorage (cross-tab propagation)', () => {
    useAuthStore.getState().setTokens('id-1', 'access-1', 'refresh-1');
    useAuthStore.getState().logout();
    const persisted = localStorage.getItem('auth-storage');
    expect(persisted).not.toBeNull();
    expect(persisted).not.toContain('id-1');
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

  describe('standardized error-body contract', () => {
    function axiosErrorWithBody(data: unknown): AxiosError {
      const err = new AxiosError('Request failed with status code 500');
      err.response = { data, status: 500, statusText: '', headers: {}, config: {} } as never;
      return err;
    }

    it('reads message from the JSON contract, with or without details', () => {
      expect(getErrorMessage(axiosErrorWithBody({ message: 'Plant not found' }))).toBe(
        'Plant not found'
      );
      expect(
        getErrorMessage(axiosErrorWithBody({ message: 'Invalid', details: { name: ['required'] } }))
      ).toBe('Invalid');
    });

    it('falls back to a plain-string body', () => {
      expect(getErrorMessage(axiosErrorWithBody('Watering limit exceeded'))).toBe(
        'Watering limit exceeded'
      );
    });

    it('extracts message from JSON delivered as a string (mislabeled content type)', () => {
      expect(getErrorMessage(axiosErrorWithBody('{"message":"Nope"}'))).toBe('Nope');
    });

    it('does not surface HTML gateway pages; uses the axios message instead', () => {
      expect(getErrorMessage(axiosErrorWithBody('<html><body>502</body></html>'))).toBe(
        'Request failed with status code 500'
      );
    });

    it('falls back to the axios message for empty or shape-less bodies', () => {
      expect(getErrorMessage(axiosErrorWithBody(''))).toBe('Request failed with status code 500');
      expect(getErrorMessage(axiosErrorWithBody({ error: 'no message field' }))).toBe(
        'Request failed with status code 500'
      );
    });
  });
});
