import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../msw/server';

/**
 * The app stays signed in (ADR 0034): inside the iOS/Android shells the
 * refresh token lives in the device keychain, not in web storage, and is
 * read back from there at launch before the session is judged.
 *
 * The keychain is faked at the module boundary (services/sessionVault.ts),
 * whose own tests cover the plugin; this file covers what the store does
 * with it.
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

import { resetAuthVaultForTests, useAuthStore } from '@/store/authStore';

const API = 'http://localhost:4000';

const me = {
  id: 'u1',
  email: 'test@example.com',
  name: 'Test',
  householdId: 'hh-1',
  householdRole: 'admin',
};

/** An unsigned JWT-shaped token that expired an hour ago. */
const expiredJwt = (() => {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 3600 }))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.signature`;
})();

/** The shell with the plugin registered: the bridge lists it, as on a device. */
function pretendToBeTheShell({ withPlugin = true } = {}) {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
    ...(withPlugin
      ? {
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
        }
      : {}),
  };
}

function resetStore() {
  localStorage.clear();
  sessionStorage.clear();
  resetAuthVaultForTests();
  useAuthStore.setState({
    user: null,
    idToken: null,
    accessToken: null,
    refreshToken: null,
    isAuthenticated: false,
    isLoading: true,
    activeHouseholdId: null,
    rememberMe: false,
  });
}

beforeEach(() => {
  vault.token = null;
  vault.read.mockClear();
  vault.write.mockClear();
  resetStore();
});

afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

describe('authStore inside the shells — where the refresh token lives', () => {
  beforeEach(pretendToBeTheShell);

  it('writes the refresh token to the keychain and to neither web storage', () => {
    useAuthStore.getState().setTokens('id-1', 'access-1', 'refresh-secret');

    const local = localStorage.getItem('auth-storage') ?? '';
    const session = sessionStorage.getItem('auth-storage-session') ?? '';
    expect(local).not.toContain('refresh-secret');
    expect(session).not.toContain('refresh-secret');
    // The short-lived tokens still survive a launch in localStorage, so the
    // first render knows the person is signed in.
    expect(local).toContain('id-1');
    expect(vault.write).toHaveBeenCalledWith('refresh-secret');
  });

  it('does not touch the keychain for a state write that leaves the token as it was', () => {
    useAuthStore.getState().setTokens('id-1', 'access-1', 'refresh-secret');
    useAuthStore.getState().setUser({ ...me, householdRole: 'admin' });
    useAuthStore.getState().setActiveHouseholdId('hh-2');
    expect(vault.write).toHaveBeenCalledTimes(1);
  });

  it('removes the token from the keychain on sign-out', () => {
    useAuthStore.getState().setTokens('id-1', 'access-1', 'refresh-secret');
    useAuthStore.getState().logout();
    expect(vault.write).toHaveBeenLastCalledWith(null);
    expect(vault.token).toBeNull();
  });

  it('ignores "keep me signed in": the keychain is where the token goes either way', () => {
    useAuthStore.getState().setRememberMe(true);
    useAuthStore.getState().setTokens('id-1', 'access-1', 'refresh-secret');
    expect(localStorage.getItem('auth-storage') ?? '').not.toContain('refresh-secret');
    expect(vault.write).toHaveBeenCalledWith('refresh-secret');
  });
});

describe('authStore inside the shells — a cold start', () => {
  beforeEach(pretendToBeTheShell);

  it('restores the keychain token before judging the session, and refreshes with it', async () => {
    // What a launch looks like: the ID token came back from localStorage and
    // has expired, sessionStorage is empty (the process ended), and the
    // keychain still holds the refresh token.
    vault.token = 'refresh-1';
    useAuthStore.setState({ idToken: expiredJwt, accessToken: 'access-1', refreshToken: null });
    const meCalls: string[] = [];
    let refreshedWith: string | null = null;
    server.use(
      http.get(`${API}/auth/me`, ({ request }) => {
        meCalls.push(request.headers.get('authorization') ?? '');
        if (meCalls.at(-1) === 'Bearer id-2') return HttpResponse.json(me);
        return HttpResponse.json({ message: 'expired' }, { status: 401 });
      }),
      http.post(`${API}/auth/refresh`, async ({ request }) => {
        refreshedWith = ((await request.json()) as { refreshToken: string }).refreshToken;
        return HttpResponse.json({
          idToken: 'id-2',
          accessToken: 'access-2',
          refreshToken: 'refresh-1',
        });
      })
    );

    await useAuthStore.getState().verifySession();

    expect(refreshedWith).toBe('refresh-1');
    // The expired bearer was never sent: straight to the refresh, then one
    // /auth/me with the new one.
    expect(meCalls).toEqual(['Bearer id-2']);
    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.user?.id).toBe('u1');
    expect(state.idToken).toBe('id-2');
    expect(state.refreshToken).toBe('refresh-1');
    expect(state.isLoading).toBe(false);
    // Restoring and refreshing with the same token wrote nothing back.
    expect(vault.write).not.toHaveBeenCalled();
    expect(localStorage.getItem('auth-storage') ?? '').not.toContain('refresh-1');
  });

  it('sends a bearer it cannot read to the server first', async () => {
    vault.token = 'refresh-1';
    useAuthStore.setState({ idToken: 'opaque-id', accessToken: 'access-1', refreshToken: null });
    const meCalls: string[] = [];
    server.use(
      http.get(`${API}/auth/me`, ({ request }) => {
        meCalls.push(request.headers.get('authorization') ?? '');
        if (meCalls.at(-1) === 'Bearer id-2') return HttpResponse.json(me);
        return HttpResponse.json({ message: 'expired' }, { status: 401 });
      }),
      http.post(`${API}/auth/refresh`, () =>
        HttpResponse.json({ idToken: 'id-2', accessToken: 'access-2', refreshToken: 'refresh-1' })
      )
    );

    await useAuthStore.getState().verifySession();

    expect(meCalls).toEqual(['Bearer opaque-id', 'Bearer id-2']);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('drops a token the keychain kept through a reinstall, instead of signing in with it', async () => {
    // iOS keeps an app's keychain items when the app is deleted. A fresh
    // install has no session in localStorage, and that is the signal.
    vault.token = 'refresh-from-the-last-install';
    let refreshCalled = false;
    server.use(
      http.post(`${API}/auth/refresh`, () => {
        refreshCalled = true;
        return HttpResponse.json({ idToken: 'id-2', accessToken: 'access-2', refreshToken: 'r' });
      })
    );

    await useAuthStore.getState().verifySession();

    const state = useAuthStore.getState();
    expect(refreshCalled).toBe(false);
    expect(state.isAuthenticated).toBe(false);
    expect(state.isLoading).toBe(false);
    expect(state.refreshToken).toBeNull();
    expect(vault.write).toHaveBeenLastCalledWith(null);
    expect(vault.token).toBeNull();
  });

  it('reads the keychain once per launch however many callers ask', async () => {
    vault.token = 'refresh-1';
    await Promise.all([
      useAuthStore.getState().restoreVaultedSession(),
      useAuthStore.getState().restoreVaultedSession(),
    ]);
    await useAuthStore.getState().restoreVaultedSession();
    expect(vault.read).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().refreshToken).toBe('refresh-1');
  });

  it('signs out fully when the server refuses the keychain token', async () => {
    vault.token = 'refresh-1';
    useAuthStore.getState().setTokens('id-1', 'access-1', 'refresh-1');
    server.use(
      http.get(`${API}/auth/me`, () => HttpResponse.json({ message: 'nope' }, { status: 401 })),
      http.post(`${API}/auth/refresh`, () => HttpResponse.json({ message: 'no' }, { status: 401 }))
    );

    await useAuthStore.getState().verifySession();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.idToken).toBeNull();
    expect(localStorage.getItem('auth-storage') ?? '').not.toContain('id-1');
    expect(vault.write).toHaveBeenLastCalledWith(null);
  });

  it('signs out fully, not tab-locally, when the keychain is empty and the token is refused', async () => {
    // The website clears only the tab here (other tabs may hold a session);
    // the shells have no other tabs, and leaving the stale tokens in place
    // would replay this refusal at every launch.
    useAuthStore.getState().setTokens('id-1', 'access-1', 'refresh-1');
    useAuthStore.setState({ refreshToken: null });
    server.use(
      http.get(`${API}/auth/me`, () => HttpResponse.json({ message: 'nope' }, { status: 401 }))
    );

    await useAuthStore.getState().verifySession();

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(localStorage.getItem('auth-storage') ?? '').not.toContain('id-1');
  });

  it('keeps the session when the keychain token cannot be tried because the server is unreachable', async () => {
    vault.token = 'refresh-1';
    useAuthStore.setState({
      idToken: expiredJwt,
      accessToken: 'access-1',
      isAuthenticated: true,
      user: me as never,
    });
    server.use(
      http.get(`${API}/auth/me`, () => HttpResponse.error()),
      http.post(`${API}/auth/refresh`, () => HttpResponse.error())
    );

    await useAuthStore.getState().verifySession();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.refreshToken).toBe('refresh-1');
    expect(state.isLoading).toBe(false);
    expect(vault.write).not.toHaveBeenCalled();
  });
});

describe('authStore inside a shell whose bridge does not list the plugin', () => {
  beforeEach(() => pretendToBeTheShell({ withPlugin: false }));

  it('keeps the website storage model: sessionStorage by default, localStorage when asked', async () => {
    useAuthStore.getState().setTokens('id-1', 'access-1', 'refresh-secret');
    expect(vault.write).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('auth-storage-session') ?? '').toContain('refresh-secret');
    expect(localStorage.getItem('auth-storage') ?? '').not.toContain('refresh-secret');

    useAuthStore.getState().setRememberMe(true);
    useAuthStore.getState().setTokens('id-1', 'access-1', 'refresh-secret');
    expect(localStorage.getItem('auth-storage') ?? '').toContain('refresh-secret');
    expect(vault.write).not.toHaveBeenCalled();
  });

  it('judges a launch without reading any keychain, and clears only this tab on a refused token', async () => {
    useAuthStore.getState().setTokens('id-1', 'access-1', 'refresh-1');
    useAuthStore.setState({ refreshToken: null });
    server.use(
      http.get(`${API}/auth/me`, () => HttpResponse.json({ message: 'nope' }, { status: 401 }))
    );

    await useAuthStore.getState().verifySession();

    expect(vault.read).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    // The pre-keychain behavior, unchanged: the shared payload survives.
    expect(localStorage.getItem('auth-storage') ?? '').toContain('id-1');
  });
});

describe('authStore on the website — the keychain is never involved', () => {
  it('writes nothing to the vault and reads nothing from it', async () => {
    useAuthStore.getState().setTokens('id-1', 'access-1', 'refresh-secret');
    expect(vault.write).not.toHaveBeenCalled();
    // The hardened default is unchanged: sessionStorage only.
    expect(sessionStorage.getItem('auth-storage-session') ?? '').toContain('refresh-secret');
    expect(localStorage.getItem('auth-storage') ?? '').not.toContain('refresh-secret');

    server.use(http.get(`${API}/auth/me`, () => HttpResponse.json(me)));
    await useAuthStore.getState().verifySession();
    expect(vault.read).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('still goes straight to the refresh for a bearer it can see has expired', async () => {
    useAuthStore.getState().setTokens(expiredJwt, 'access-1', 'refresh-1');
    const meCalls: string[] = [];
    server.use(
      http.get(`${API}/auth/me`, ({ request }) => {
        meCalls.push(request.headers.get('authorization') ?? '');
        return HttpResponse.json(me);
      }),
      http.post(`${API}/auth/refresh`, () =>
        HttpResponse.json({ idToken: 'id-2', accessToken: 'access-2', refreshToken: 'refresh-1' })
      )
    );

    await useAuthStore.getState().verifySession();

    expect(meCalls).toEqual(['Bearer id-2']);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });
});
