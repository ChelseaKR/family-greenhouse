/**
 * The single source of truth for the authenticated user, their tokens, and
 * an `isLoading` flag the ProtectedRoute uses while we verify a stored token
 * on app boot.
 *
 * Storage model (post-2026-05-31 OWASP A07 hardening):
 *   - Short-lived `idToken` + `accessToken` go to `localStorage` so the
 *     session survives page reloads.
 *   - Long-lived `refreshToken` goes to `sessionStorage` so closing the tab
 *     ends the 30-day grant window — an XSS that exfiltrates the access
 *     token only gets at most one hour of access (Cognito's access-token
 *     TTL) instead of pivoting into a 30-day account hijack.
 *   - A `storage` event listener propagates logout across tabs: a logout
 *     in one tab triggers logout in all other tabs of the same origin.
 *
 * Why zustand vs Context: zustand lets services (axios interceptors) read
 * state without being inside the React tree. The 401-refresh interceptor
 * needs that.
 */
import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import { identify, reset as resetAnalytics } from '@/services/analytics';

export interface User {
  id: string;
  email: string;
  name: string;
  householdId: string | null;
  householdRole: 'admin' | 'member' | null;
}

interface AuthState {
  user: User | null;
  /** Cognito ID token — sent as Authorization: Bearer for all API calls.
   *  Carries the household custom claims (access tokens do not). */
  idToken: string | null;
  /** Cognito access token — only used for Cognito-direct endpoints
   *  (ChangePassword, UpdateUserAttributes) that reject ID tokens. */
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** Active household for multi-household users. Null falls back to the
   *  Cognito-claim householdId. The api interceptor sends this as
   *  `X-Household-Id` so backend services scope to it. */
  activeHouseholdId: string | null;
  setUser: (user: User | null) => void;
  setTokens: (idToken: string, accessToken: string, refreshToken: string) => void;
  setHousehold: (householdId: string, role: 'admin' | 'member') => void;
  setActiveHouseholdId: (id: string | null) => void;
  logout: () => void;
  setLoading: (loading: boolean) => void;
  verifySession: () => Promise<void>;
}

// Custom Storage that splits keys across localStorage (default) and
// sessionStorage (long-lived secrets). The bracketing here is the
// JSON-payload field name inside the persisted state, not the storage key.
const SESSION_FIELDS = new Set(['refreshToken']);

function splitJsonByField(json: string, fields: Set<string>): { local: string; session: string } {
  try {
    const parsed = JSON.parse(json) as { state?: Record<string, unknown> };
    const state = (parsed.state ?? {}) as Record<string, unknown>;
    const localState: Record<string, unknown> = {};
    const sessionState: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(state)) {
      if (fields.has(k)) sessionState[k] = v;
      else localState[k] = v;
    }
    return {
      local: JSON.stringify({ ...parsed, state: localState }),
      session: JSON.stringify({ ...parsed, state: sessionState }),
    };
  } catch {
    return { local: json, session: '{}' };
  }
}

function mergeJsonFromSplit(local: string | null, session: string | null): string | null {
  if (!local && !session) return null;
  try {
    const localParsed = local
      ? (JSON.parse(local) as { state?: Record<string, unknown>; version?: number })
      : { state: {} };
    const sessionParsed = session
      ? (JSON.parse(session) as { state?: Record<string, unknown> })
      : { state: {} };
    return JSON.stringify({
      ...localParsed,
      state: { ...(localParsed.state ?? {}), ...(sessionParsed.state ?? {}) },
    });
  } catch {
    return local;
  }
}

const splitStorage: StateStorage = {
  getItem: (name) => {
    if (typeof window === 'undefined') return null;
    const local = window.localStorage.getItem(name);
    const session = window.sessionStorage.getItem(`${name}-session`);
    return mergeJsonFromSplit(local, session);
  },
  setItem: (name, value) => {
    if (typeof window === 'undefined') return;
    const { local, session } = splitJsonByField(value, SESSION_FIELDS);
    window.localStorage.setItem(name, local);
    window.sessionStorage.setItem(`${name}-session`, session);
  },
  removeItem: (name) => {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(name);
    window.sessionStorage.removeItem(`${name}-session`);
  },
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      idToken: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      isLoading: true,
      activeHouseholdId: null,

      setActiveHouseholdId: (activeHouseholdId) => set({ activeHouseholdId }),

      setUser: (user) => {
        if (user) {
          // Pin analytics to the Cognito sub. Safe to call on every set;
          // the underlying shim is idempotent and does nothing without
          // VITE_POSTHOG_KEY configured.
          identify(user.id);
        } else {
          resetAnalytics();
        }
        set({
          user,
          isAuthenticated: user !== null,
          isLoading: false,
        });
      },

      setTokens: (idToken, accessToken, refreshToken) =>
        set({
          idToken,
          accessToken,
          refreshToken,
        }),

      setHousehold: (householdId, role) =>
        set((state) => ({
          user: state.user ? { ...state.user, householdId, householdRole: role } : null,
        })),

      logout: () => {
        resetAnalytics();
        set({
          user: null,
          idToken: null,
          accessToken: null,
          refreshToken: null,
          isAuthenticated: false,
          isLoading: false,
          activeHouseholdId: null,
        });
      },

      setLoading: (loading) => set({ isLoading: loading }),

      verifySession: async () => {
        const { idToken, accessToken, logout, setLoading } = get();
        // Prefer ID token (carries the household claims the backend reads).
        // Fall back to access token only to handle pre-fix persisted state.
        const authToken = idToken ?? accessToken;

        // No token, just mark as not loading
        if (!authToken) {
          setLoading(false);
          return;
        }

        try {
          // Try to verify the token by calling a protected endpoint
          const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';
          const response = await fetch(`${API_URL}/auth/me`, {
            headers: {
              Authorization: `Bearer ${authToken}`,
            },
          });

          if (!response.ok) {
            // Token is invalid, logout silently
            logout();
          } else {
            // Token is valid, update user data
            const userData = await response.json();
            set({
              user: userData,
              isAuthenticated: true,
              isLoading: false,
            });
          }
        } catch {
          // Network error or other issue, logout to be safe
          logout();
        }
      },
    }),
    {
      name: 'auth-storage',
      storage: createJSONStorage(() => splitStorage),
      partialize: (state) => ({
        user: state.user,
        idToken: state.idToken,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        isAuthenticated: state.isAuthenticated,
        activeHouseholdId: state.activeHouseholdId,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Pre-fix sessions only stored an `accessToken` (no `idToken`).
        // The access token doesn't carry the household claim, so reusing
        // it would silently push the user back to onboarding even when
        // they already have a household. Force a clean re-login instead.
        if (state.accessToken && !state.idToken) {
          state.logout();
          return;
        }
        state.verifySession();
      },
    }
  )
);

// Cross-tab logout: when another tab clears the persisted state (logout,
// manual clear, or rehydrate-guard kick-out), every other tab observes the
// `storage` event and synchronously logs out. Prevents the "logged out in
// one tab, still logged in in another" inconsistency. Skipped in SSR.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== 'auth-storage') return;
    // If the local-side payload disappears or no longer carries an idToken,
    // mirror logout into this tab so its in-memory zustand state matches.
    //
    // The payload is same-origin (the `storage` event only fires for our own
    // localStorage key) so the trust boundary is the same as any other
    // localStorage read — but we still validate shape before reading nested
    // fields. A bare `?? null` would coerce both "missing" and "wrong type"
    // to logout; that's the right action either way, but typeof-checking
    // first keeps the read explicit and the failure mode obvious.
    if (!e.newValue) {
      useAuthStore.getState().logout();
      return;
    }
    try {
      const parsed = JSON.parse(e.newValue) as unknown;
      const idToken =
        parsed &&
        typeof parsed === 'object' &&
        'state' in parsed &&
        parsed.state &&
        typeof parsed.state === 'object' &&
        'idToken' in parsed.state &&
        typeof (parsed.state as { idToken?: unknown }).idToken === 'string'
          ? (parsed.state as { idToken: string }).idToken
          : null;
      if (!idToken) {
        useAuthStore.getState().logout();
      }
    } catch {
      // Malformed JSON — safer to log out than to keep stale auth state.
      useAuthStore.getState().logout();
    }
  });
}
