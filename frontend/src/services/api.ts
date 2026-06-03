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
 * Concurrency: a global `isRefreshing` flag avoids stampedes when many
 * requests 401 simultaneously. The first request to 401 owns the refresh;
 * subsequent ones wait for it implicitly via the retry path.
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

// Request interceptor to add auth token + active household pin.
api.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const state = useAuthStore.getState();
    // Authorization carries the ID token, which is the only one that carries
    // the `custom:household_id` claim the backend's requireHousehold reads.
    // Access tokens go in `X-Cognito-Access-Token` for Cognito-direct calls.
    // Falling back to accessToken handles pre-fix persisted sessions.
    const authToken = state.idToken ?? state.accessToken;
    if (authToken && config.headers) {
      config.headers.Authorization = `Bearer ${authToken}`;
    }
    // Multi-household: when the user has switched to a non-default
    // household, every request carries `X-Household-Id` so the backend
    // scopes correctly. The backend resource handlers refuse cross-
    // household access, so a forged header still can't read another
    // household's data.
    if (state.activeHouseholdId && config.headers) {
      config.headers['X-Household-Id'] = state.activeHouseholdId;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Track if we're already handling a 401 to prevent loops
let isRefreshing = false;

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

      if (refreshToken && !isRefreshing) {
        isRefreshing = true;
        try {
          const response = await axios.post(`${API_URL}/auth/refresh`, {
            refreshToken,
          });

          const { idToken, accessToken, refreshToken: newRefreshToken } = response.data;
          useAuthStore.getState().setTokens(idToken, accessToken, newRefreshToken);

          if (originalRequest.headers) {
            originalRequest.headers.Authorization = `Bearer ${idToken}`;
          }
          isRefreshing = false;
          return api(originalRequest);
        } catch {
          isRefreshing = false;
          // Silently logout - don't force redirect, let ProtectedRoute handle it
          useAuthStore.getState().logout();
        }
      } else if (!refreshToken) {
        // No refresh token, just logout silently
        useAuthStore.getState().logout();
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
 * Best-effort error-to-string for displaying in toasts/alerts. Prefer the
 * server's `message` if axios captured one; otherwise fall back to the JS
 * Error message; otherwise a generic string. Never throws.
 */
export function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as ApiError | undefined;
    return data?.message || error.message || 'An unexpected error occurred';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'An unexpected error occurred';
}
