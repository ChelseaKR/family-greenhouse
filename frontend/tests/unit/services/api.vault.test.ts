import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server, handlers } from '../../msw/server';

/**
 * The 401-refresh interceptor inside the shells (ADR 0034). A request that
 * fires at launch, before the store has read the refresh token back from
 * the device keychain, must wait for that read instead of concluding there
 * is nothing to refresh with. Native push's registration sync is such a
 * request: it ran at every launch with the expired ID token, and signed the
 * person out before the session had a chance.
 */
const vault = vi.hoisted(() => ({
  token: null as string | null,
  read: vi.fn(async () => vault.token),
  write: vi.fn(async (token: string | null) => {
    vault.token = token;
  }),
}));

// The keychain itself is faked; `sessionVaultAvailable` stays real, so the
// bridge-header check runs against the pretense below.
vi.mock('@/services/sessionVault', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/sessionVault')>();
  return {
    ...actual,
    readVaultedRefreshToken: vault.read,
    writeVaultedRefreshToken: vault.write,
  };
});

import { api, refreshSession } from '@/services/api';
import { resetAuthVaultForTests, useAuthStore } from '@/store/authStore';

const API = 'http://localhost:4000';

function plantsGatedBy(validBearer: string) {
  return http.get(`${API}/plants`, ({ request }) => {
    if (request.headers.get('authorization') !== `Bearer ${validBearer}`) {
      return HttpResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }
    return HttpResponse.json([{ id: 'p1', name: 'Pothos' }]);
  });
}

beforeEach(() => {
  vault.token = null;
  vault.read.mockClear();
  vault.write.mockClear();
  localStorage.clear();
  sessionStorage.clear();
  resetAuthVaultForTests();
});

afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

describe('api interceptor inside the shells', () => {
  beforeEach(() => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      PluginHeaders: [
        {
          name: 'SecureStorage',
          methods: [
            { name: 'internalGetItem', rtype: 'promise' },
            { name: 'internalSetItem', rtype: 'promise' },
            { name: 'internalRemoveItem', rtype: 'promise' },
          ],
        },
      ],
    };
  });

  it('waits for the keychain before deciding there is nothing to refresh with', async () => {
    vault.token = 'refresh-1';
    useAuthStore.setState({ idToken: 'expired', accessToken: 'expired', refreshToken: null });
    let refreshedWith: string | null = null;
    server.use(
      plantsGatedBy('access-2'),
      http.post(`${API}/auth/refresh`, async ({ request }) => {
        refreshedWith = ((await request.json()) as { refreshToken: string }).refreshToken;
        return HttpResponse.json({ accessToken: 'access-2', refreshToken: 'refresh-2' });
      })
    );

    const res = await api.get('/plants');

    expect(res.status).toBe(200);
    expect(vault.read).toHaveBeenCalledTimes(1);
    expect(refreshedWith).toBe('refresh-1');
    expect(useAuthStore.getState().accessToken).toBe('access-2');
    // A rotated token (the backend echoes the same one today) goes to the
    // keychain, and to no web storage.
    expect(vault.write).toHaveBeenLastCalledWith('refresh-2');
    expect(localStorage.getItem('auth-storage') ?? '').not.toContain('refresh-2');
    expect(sessionStorage.getItem('auth-storage-session') ?? '').not.toContain('refresh-2');
  });

  it('signs the device out fully when the keychain is empty too', async () => {
    useAuthStore.setState({ idToken: 'id-1', accessToken: 'expired', refreshToken: null });
    expect(localStorage.getItem('auth-storage')).toContain('id-1');
    server.use(plantsGatedBy('access-2'));

    await expect(api.get('/plants')).rejects.toMatchObject({ response: { status: 401 } });

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().idToken).toBeNull();
    // Unlike the website's tab-local clear, the stored tokens are gone, so
    // the next launch does not replay the same refused request.
    expect(localStorage.getItem('auth-storage') ?? '').not.toContain('id-1');
  });

  it('refreshSession() for the authenticated /auth/* routes waits for the keychain as well', async () => {
    vault.token = 'refresh-1';
    useAuthStore.setState({ idToken: 'id-1', accessToken: 'access-1', refreshToken: null });
    server.use(handlers.authRefreshOk);

    await expect(refreshSession()).resolves.toBe('access-2');
    expect(vault.read).toHaveBeenCalledTimes(1);
  });
});

describe('api interceptor on the website', () => {
  it('still clears only this tab when it holds no refresh token', async () => {
    useAuthStore.setState({ idToken: 'id-1', accessToken: 'expired', refreshToken: null });
    server.use(plantsGatedBy('access-2'));

    await expect(api.get('/plants')).rejects.toMatchObject({ response: { status: 401 } });

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(vault.read).not.toHaveBeenCalled();
    // Other tabs may still hold a session: the shared payload survives.
    expect(localStorage.getItem('auth-storage')).toContain('id-1');
  });
});
