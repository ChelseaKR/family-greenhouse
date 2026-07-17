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
  /** Server-side delivery capability. False when the SMS provider/feature is
   * unavailable, so the UI never offers a verification flow that will 503. */
  smsAvailable: boolean;
  phone: string;
  /** "HH:MM" 24-hour pair in the user's IANA timezone. Both empty = no DND. */
  dndStart: string;
  dndEnd: string;
  /** IANA timezone name, e.g. "America/New_York". Defaults to UTC server-side. */
  timezone: string;
  /** Opt-in seasonal pest pressure alerts. Defaults false. */
  pestAlerts: boolean;
  /** Weekly "plants at risk" digest email. Defaults on when email is enabled. */
  weeklyDigest: boolean;
  /** True once the current phone number was confirmed via SMS code. Read-only:
   *  only the confirm-verification endpoint can set it. */
  phoneVerified: boolean;
  updatedAt: string;
}

export interface StartVerificationResponse {
  sent: boolean;
  /** Local mock server only — production never echoes the code. */
  devCode?: string;
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
      | 'browser'
      | 'email'
      | 'sms'
      | 'phone'
      | 'dndStart'
      | 'dndEnd'
      | 'timezone'
      | 'pestAlerts'
      | 'weeklyDigest'
    >
  ): Promise<NotificationPreferences> {
    const response = await api.put<NotificationPreferences>('/notifications/prefs', prefs);
    return response.data;
  },

  /** Text a 6-digit verification code to an E.164 phone number. */
  async startPhoneVerification(phone: string): Promise<StartVerificationResponse> {
    const response = await api.post<StartVerificationResponse>(
      '/notifications/phone/start-verification',
      { phone }
    );
    return response.data;
  },

  /** Confirm the texted code; returns the updated (now verified) preferences. */
  async confirmPhoneVerification(code: string): Promise<NotificationPreferences> {
    const response = await api.post<NotificationPreferences>(
      '/notifications/phone/confirm-verification',
      { code }
    );
    return response.data;
  },
};
