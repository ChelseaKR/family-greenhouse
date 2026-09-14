/**
 * The single source of truth for the authenticated user, their tokens, and
 * an `isLoading` flag the ProtectedRoute uses while we verify a stored token
 * on app boot.
 *
 * Storage model (post-2026-05-31 OWASP A07 hardening):
 *   - Short-lived `idToken` + `accessToken` go to `localStorage` so the
 *     session survives page reloads.
 *   - Long-lived `refreshToken` goes to `sessionStorage` BY DEFAULT, so
 *     closing the tab ends the 30-day grant window — an XSS that exfiltrates
 *     the access token only gets at most one hour of access (Cognito's
 *     access-token TTL) instead of pivoting into a 30-day account hijack.
 *   - Opt-in exception (2026-09-13): ticking "keep me signed in" at login
 *     sets `rememberMe`, which routes the refresh token to `localStorage`
 *     instead, so that person stays signed in after closing the browser.
 *     The 30-day XSS blast radius of finding 7.1 applies to exactly those
 *     sessions and nobody else's; the hardened path stays the default for
 *     anyone who doesn't ask. Cognito does not rotate refresh tokens, so a
 *     stolen one is good until logout or its 30 days run out.
 *   - A `storage` event listener propagates logout across tabs: a logout
 *     in one tab triggers logout in all other tabs of the same origin.
 *
 * Why zustand vs Context: zustand lets services (axios interceptors) read
 * state without being inside the React tree. The 401-refresh interceptor
 * needs that.
 */
import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import {
  identify,
  reset as resetAnalytics,
  setActiveHousehold,
  setTelemetryAuthToken,
} from '@/services/analytics';

export interface User {
  id: string;
  email: string;
  name: string;
  householdId: string | null;
  householdRole: 'admin' | 'member' | null;
}

function isUser(value: unknown): value is User {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.email === 'string' &&
    typeof candidate.name === 'string' &&
    (candidate.householdId === null || typeof candidate.householdId === 'string') &&
    (candidate.householdRole === null ||
      candidate.householdRole === 'admin' ||
      candidate.householdRole === 'member')
  );
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
  /** "Keep me signed in", chosen at login. When true the refresh token is
   *  persisted to localStorage so the session outlives a closed browser.
   *  Defaults false — the hardened sessionStorage-only path. */
  rememberMe: boolean;
  setUser: (user: User | null) => void;
  setTokens: (idToken: string, accessToken: string, refreshToken: string) => void;
  setHousehold: (householdId: string, role: 'admin' | 'member') => void;
  setActiveHouseholdId: (id: string | null) => void;
  /** Set BEFORE setTokens at login: the storage adapter reads this flag off
   *  the payload it writes, so the tokens land in the right place. */
  setRememberMe: (rememberMe: boolean) => void;
  logout: () => void;
  /**
   * Clears THIS tab's in-memory session without touching the persisted
   * localStorage payload. Used when a tab's session is unusable locally
   * (e.g. a freshly-opened tab inherited an idToken from localStorage but
   * has no sessionStorage refresh token) — a full logout() would rewrite
   * the shared localStorage and the cross-tab `storage` listener would
   * then log out EVERY tab, including ones holding valid refresh tokens.
   */
  clearLocalSession: () => void;
  setLoading: (loading: boolean) => void;
  verifySession: () => Promise<void>;
}

// Custom Storage that splits keys across localStorage (default) and
// sessionStorage (long-lived secrets). The bracketing here is the
// JSON-payload field name inside the persisted state, not the storage key.
const SESSION_FIELDS = new Set(['refreshToken']);
// An empty set means "hold nothing back" — every field, refresh token
// included, persists to localStorage.
const NO_SESSION_FIELDS = new Set<string>();

/**
 * Which fields this write holds back to sessionStorage. Read from the
 * payload being written rather than from a closure, so the decision always
 * matches the state actually being persisted (a token refresh writes through
 * this path too, long after login set the flag).
 */
function sessionFieldsFor(state: Record<string, unknown>): Set<string> {
  return state.rememberMe === true ? NO_SESSION_FIELDS : SESSION_FIELDS;
}

function splitJsonByField(json: string): { local: string; session: string } {
  try {
    const parsed = JSON.parse(json) as { state?: Record<string, unknown> };
    const state = (parsed.state ?? {}) as Record<string, unknown>;
    const fields = sessionFieldsFor(state);
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

// When true, persist writes are skipped entirely. `clearLocalSession` flips
// this around its `set` so a tab-local clear never rewrites the shared
// localStorage payload (which would fire `storage` events in other tabs and
// cascade the logout). zustand's persist middleware writes synchronously on
// every set, so a synchronous flag is sufficient.
let suppressPersistWrites = false;

const splitStorage: StateStorage = {
  getItem: (name) => {
    if (typeof window === 'undefined') return null;
    const local = window.localStorage.getItem(name);
    const session = window.sessionStorage.getItem(`${name}-session`);
    return mergeJsonFromSplit(local, session);
  },
  setItem: (name, value) => {
    if (typeof window === 'undefined' || suppressPersistWrites) return;
    const { local, session } = splitJsonByField(value);
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
      rememberMe: false,

      setRememberMe: (rememberMe) => set({ rememberMe }),

      setActiveHouseholdId: (activeHouseholdId) => {
        set({ activeHouseholdId });
        // Keep the analytics group key in lockstep with the effective active
        // household so every captured event is attributed to the household the
        // requests are actually scoped to (see useActiveHouseholdId).
        setActiveHousehold(activeHouseholdId ?? get().user?.householdId ?? null);
      },

      setUser: (user) => {
        if (user) {
          // Pin analytics to the Cognito sub. Safe to call on every set;
          // the underlying shim is idempotent and does nothing without
          // VITE_POSTHOG_KEY configured. Set the household group BEFORE
          // identify so the $identify event carries `$groups.household`.
          setActiveHousehold(get().activeHouseholdId ?? user.householdId ?? null);
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

      setTokens: (idToken, accessToken, refreshToken) => {
        setTelemetryAuthToken(idToken ?? accessToken);
        set({
          idToken,
          accessToken,
          refreshToken,
        });
      },

      setHousehold: (householdId, role) => {
        set((state) => ({
          user: state.user ? { ...state.user, householdId, householdRole: role } : null,
        }));
        // A user who just got their first household (onboarding) has no
        // explicit active id yet — fall back to the new claim household.
        setActiveHousehold(get().activeHouseholdId ?? householdId);
      },

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
          // Never sticky across accounts: the next person to sign in on this
          // browser opts in again, or gets the hardened default.
          rememberMe: false,
        });
      },

      clearLocalSession: () => {
        resetAnalytics();
        // Same state reset as logout(), but with persistence suppressed so
        // the shared localStorage payload survives for other tabs. This
        // tab's ProtectedRoute will route to /login as usual.
        suppressPersistWrites = true;
        try {
          set({
            user: null,
            idToken: null,
            accessToken: null,
            refreshToken: null,
            isAuthenticated: false,
            isLoading: false,
            activeHouseholdId: null,
            rememberMe: false,
          });
        } finally {
          suppressPersistWrites = false;
        }
      },

      setLoading: (loading) => set({ isLoading: loading }),

      verifySession: async () => {
        const {
          idToken,
          accessToken,
          refreshToken,
          logout,
          clearLocalSession,
          setLoading,
          setTokens,
        } = get();
        // Prefer ID token (carries the household claims the backend reads).
        // Fall back to access token only to handle pre-fix persisted state.
        const authToken = idToken ?? accessToken;
        setTelemetryAuthToken(authToken);

        // When this tab can't recover the session on its own (no refresh
        // token — it's sessionStorage-only, so e.g. a freshly-opened tab),
        // fail tab-locally instead of nuking the shared localStorage that
        // other tabs with valid refresh tokens still depend on.
        const failSession = refreshToken ? logout : clearLocalSession;

        // No token, just mark as not loading
        if (!authToken) {
          setLoading(false);
          return;
        }

        const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';
        const fetchMe = (token: string) =>
          fetch(`${API_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });

        /**
         * Mirrors the axios interceptor's 401-refresh flow (services/api.ts)
         * for this boot-time check, which uses a raw `fetch` rather than the
         * shared axios instance. An expired short-lived idToken does NOT mean
         * the session is over — the 30-day refresh token this tab holds may
         * still be good, and a page reload (when this runs) is exactly when
         * the idToken is most likely to have expired.
         *
         * The outcome is three-state on purpose (see `unreachable` below):
         * a refused refresh and one we never managed to send are different
         * answers, and only one of them is about the session.
         */
        async function refreshAndRetry(): Promise<Response | null | 'unreachable'> {
          if (!refreshToken) return null;
          try {
            const refreshResponse = await fetch(`${API_URL}/auth/refresh`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ refreshToken }),
            });
            if (!refreshResponse.ok) return null;
            const data = await refreshResponse.json();
            const newBearer = data.idToken ?? data.accessToken;
            if (!newBearer) return null;
            setTokens(data.idToken, data.accessToken, data.refreshToken ?? refreshToken);
            return await fetchMe(newBearer);
          } catch {
            // `fetch` rejects for exactly one reason: the request never got
            // an answer. The server did not refuse anything.
            return 'unreachable';
          }
        }

        let response: Response | null | 'unreachable';
        try {
          response = await fetchMe(authToken);
          // Refresh only means "the bearer expired" for a 401. Retrying a
          // forbidden request or a server outage with fresh credentials adds
          // load and cannot change the outcome.
          if (response.status === 401) response = await refreshAndRetry();
        } catch {
          // The initial /auth/me call itself threw (network error) — still
          // worth trying a refresh (a flaky first request shouldn't cost an
          // otherwise-valid 30-day session) before deciding anything.
          response = await refreshAndRetry();
          // No refresh token to try with, and the one call we made never
          // reached the server: that is not a verdict on this session.
          if (response === null && !refreshToken) response = 'unreachable';
        }

        if (response === 'unreachable') {
          // WE COULD NOT ASK is not THE SERVER SAID NO. Ending the session
          // here is what logged people out of the installed app every time
          // they opened it without a network: measured on the production
          // build's service worker, an offline reload left `auth-storage`
          // holding `user: null` and the tab sitting on /login, and coming
          // back online did not bring the session back — it was gone from
          // storage. The persisted session stays exactly as it was; the
          // pages' own reads report the outage, and a token that really has
          // expired still ends the session at the first answered 401.
          setLoading(false);
          return;
        }

        if (!response || !response.ok) {
          // Token is invalid and refreshing didn't help (or wasn't possible)
          // — end the session silently (tab-local when this tab has no
          // refresh token, full logout otherwise).
          failSession();
          return;
        }

        // Token (or the refreshed one) is valid, update user data. Keep JSON
        // decoding inside the same fail-safe boundary as the network calls:
        // a malformed/truncated 200 response must not leave the boot screen
        // stuck forever with isLoading=true.
        let userData: unknown;
        try {
          userData = await response.json();
        } catch {
          failSession();
          return;
        }
        if (!isUser(userData)) {
          failSession();
          return;
        }
        // Session restore: re-establish the analytics household group from
        // the persisted active id (or the user's claim household) so events
        // captured before the user touches the switcher are still grouped.
        setActiveHousehold(get().activeHouseholdId ?? userData.householdId ?? null);
        identify(userData.id);
        set({
          user: userData,
          isAuthenticated: true,
          isLoading: false,
        });
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
        rememberMe: state.rememberMe,
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
