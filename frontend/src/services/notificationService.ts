import { api } from './api';

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface NotificationPreferences {
  userId: string;
  browser: boolean;
  email: boolean;
  sms: boolean;
  phone: string;
  /** "HH:MM" 24-hour pair in the user's IANA timezone. Both empty = no DND. */
  dndStart: string;
  dndEnd: string;
  /** IANA timezone name, e.g. "America/New_York". Defaults to UTC server-side. */
  timezone: string;
  /** Opt-in seasonal pest pressure alerts. Defaults false. */
  pestAlerts: boolean;
  updatedAt: string;
}

export const notificationService = {
  async subscribe(payload: PushSubscriptionPayload): Promise<void> {
    await api.post('/notifications/subscribe', payload);
  },

  async unsubscribe(endpoint: string): Promise<void> {
    await api.post('/notifications/unsubscribe', { endpoint });
  },

  async runReminders(): Promise<{ sent: number }> {
    const response = await api.post<{ sent: number }>('/notifications/run-reminders');
    return response.data;
  },

  async getPreferences(): Promise<NotificationPreferences> {
    const response = await api.get<NotificationPreferences>('/notifications/prefs');
    return response.data;
  },

  async updatePreferences(
    prefs: Pick<
      NotificationPreferences,
      'browser' | 'email' | 'sms' | 'phone' | 'dndStart' | 'dndEnd' | 'timezone' | 'pestAlerts'
    >
  ): Promise<NotificationPreferences> {
    const response = await api.put<NotificationPreferences>('/notifications/prefs', prefs);
    return response.data;
  },
};
