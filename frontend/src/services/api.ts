/**
 * The single axios instance every frontend service uses. Two interceptors
 * run on every request:
 *
 *   1. Request: attach `Authorization: Bearer <idToken>` (Cognito ID token,
 *      which carries custom:household_id — falls back to the access token
 *      for pre-2026-05-31 persisted sessions where idToken is null).
 *   2. Response: on a 401 to a non-/auth/* route, call /auth/refresh once
 *      and retry the original request. If refresh itself 401s, log the user
 *      out silently — letting the ProtectedRoute kick them to /login.
 *
 * The access token (Cognito access token, distinct from idToken) is sent in
 * `X-Cognito-Access-Token` only for the two routes that need it for
 * Cognito-direct calls: PATCH /auth/me and POST /auth/change-password.
 *
 * Concurrency: a single shared `refreshPromise` serializes refreshes when
 * many requests 401 simultaneously. The first request to 401 starts the
 * refresh; every subsequent 401 awaits the SAME promise and retries its own
 * original request with the new token. If the refresh fails, all waiters
 * reject and logout fires exactly once (from the refresh promise itself).
 */
import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '@/store/authStore';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

/** Minimal shape of the auth state the header builder reads. */
type AuthHeaderState = {
  idToken: string | null;
  accessToken: string | null;
  activeHouseholdId: string | null;
};

/**
 * Build the shared auth headers — `Authorization: Bearer <idToken>` (falling
 * back to the access token for pre-fix persisted sessions) plus the active
 * household pin. Used by both the axios request interceptor and the chat
 * stream's raw `fetch`, so the scheme can't drift between them.
 */
export function buildAuthHeaders(state: AuthHeaderState): Record<string, string> {
  const headers: Record<string, string> = {};
  const authToken = state.idToken ?? state.accessToken;
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  if (state.activeHouseholdId) {
    headers['X-Household-Id'] = state.activeHouseholdId;
  }
  return headers;
}

// Request interceptor to add auth token + active household pin.
api.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    // Authorization carries the ID token, which is the only one that carries
    // the `custom:household_id` claim the backend's requireHousehold reads
    // (access-token fallback handles pre-fix persisted sessions). The
    // `X-Household-Id` pin lets a switched-household user scope requests; the
    // backend resource handlers refuse cross-household access, so a forged
    // header still can't read another household's data. See buildAuthHeaders.
    if (config.headers) {
      const headers = buildAuthHeaders(useAuthStore.getState());
      for (const [k, v] of Object.entries(headers)) {
        config.headers[k] = v;
      }
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Shared in-flight refresh. While set, every 401 awaits this single promise
// instead of racing its own refresh (Cognito refresh tokens are reusable, but
// a stampede still burns requests and can interleave setTokens writes).
// Resolves with the bearer token to retry with; rejects if the refresh failed.
let refreshPromise: Promise<string> | null = null;

function startRefresh(refreshToken: string): Promise<string> {
  return axios
    .post(`${API_URL}/auth/refresh`, { refreshToken })
    .then((response) => {
      const { idToken, accessToken, refreshToken: newRefreshToken } = response.data;
      useAuthStore.getState().setTokens(idToken, accessToken, newRefreshToken);
      // Prefer the ID token (household claims); tolerate refresh responses
      // that only carry an access token, mirroring the request interceptor.
      return (idToken ?? accessToken) as string;
    })
    .catch((refreshError) => {
      // Fires once, here, no matter how many requests are waiting.
      // Silently logout - don't force redirect, let ProtectedRoute handle it.
      useAuthStore.getState().logout();
      throw refreshError;
    })
    .finally(() => {
      refreshPromise = null;
    });
}

// Response interceptor for token refresh
api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

    // Only handle 401 once per request and don't handle auth endpoints
    if (
      error.response?.status === 401 &&
      originalRequest &&
      !originalRequest._retry &&
      !originalRequest.url?.includes('/auth/')
    ) {
      originalRequest._retry = true;

      const refreshToken = useAuthStore.getState().refreshToken;

      if (!refreshToken) {
        // No refresh token in THIS tab (refresh tokens are sessionStorage-
        // only). Clear this tab's in-memory session without rewriting the
        // shared localStorage payload — other tabs may hold valid sessions
        // and a full logout() here would cascade to all of them.
        useAuthStore.getState().clearLocalSession();
        return Promise.reject(error);
      }

      if (!refreshPromise) {
        refreshPromise = startRefresh(refreshToken);
      }

      try {
        const bearer = await refreshPromise;
        if (originalRequest.headers) {
          originalRequest.headers.Authorization = `Bearer ${bearer}`;
        }
        return api(originalRequest);
      } catch {
        // Refresh failed — logout already happened inside startRefresh.
        // Reject with the original 401 so callers see a consistent error.
      }
    }

    return Promise.reject(error);
  }
);

/**
 * Shape of a backend error body. The `details` field is populated by the
 * Zod-backed validation middleware as `{ "field": ["message1", ...] }`.
 */
export interface ApiError {
  message: string;
  code?: string;
  details?: Record<string, string[]>;
}

/**
 * Best-effort error-to-string for displaying in toasts/alerts. The backend
 * standardizes errors to JSON `{"message": string, "details"?: unknown}`,
 * but we still tolerate plain-string bodies (legacy text/plain responses,
 * proxies, or JSON the client failed to parse). Falls back to the JS Error
 * message, then a generic string. Never throws.
 */
export function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data: unknown = error.response?.data;
    // Standard contract: JSON body with a string `message`.
    if (
      data &&
      typeof data === 'object' &&
      typeof (data as { message?: unknown }).message === 'string' &&
      (data as { message: string }).message
    ) {
      return (data as { message: string }).message;
    }
    // Plain-string body. It may still be JSON text if the server mislabeled
    // the content type — try to pull `message` out before using it verbatim.
    if (typeof data === 'string' && data.trim()) {
      try {
        const parsed: unknown = JSON.parse(data);
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof (parsed as { message?: unknown }).message === 'string'
        ) {
          return (parsed as { message: string }).message;
        }
      } catch {
        // Not JSON — fall through to the raw string.
      }
      // Don't surface gateway HTML error pages as toast text.
      if (!data.trimStart().startsWith('<')) {
        return data;
      }
    }
    return error.message || 'An unexpected error occurred';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'An unexpected error occurred';
}
