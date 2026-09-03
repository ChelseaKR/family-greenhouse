import { api } from './api';

/**
 * The calendar-feed link: a per-user, per-household capability URL that
 * calendar apps can subscribe to without a session. The backend returns the
 * token exactly once (on mint/regenerate) and never again — status carries
 * only whether a link exists and when it was last fetched.
 */
export interface CalendarTokenStatus {
  active: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}

export interface CalendarTokenCreateResult extends CalendarTokenStatus {
  /** Plaintext token — shown once. */
  token: string;
  /** Feed path, owned by the backend so the URL can't drift from the route. */
  path: string;
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export const calendarFeedService = {
  async status(): Promise<CalendarTokenStatus> {
    const response = await api.get<CalendarTokenStatus>('/me/calendar-token');
    return response.data;
  },

  /** Mint a link for the active household, replacing any existing one. */
  async regenerate(): Promise<CalendarTokenCreateResult> {
    const response = await api.post<CalendarTokenCreateResult>('/me/calendar-token');
    return response.data;
  },

  async revoke(): Promise<void> {
    await api.delete('/me/calendar-token');
  },

  /** The full URL a calendar app subscribes to. */
  feedUrl(path: string): string {
    return `${API_URL}${path}`;
  },
};
