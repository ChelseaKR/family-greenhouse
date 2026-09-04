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
  /** Household emails — each individually switchable, all default on when
   *  email is enabled. See docs/notifications.md. */
  memberJoined: boolean;
  taskUpForGrabs: boolean;
  coverageUpdates: boolean;
  careCredit: boolean;
  /** End-of-year recap email. Defaults on when email is enabled. */
  yearRecap: boolean;
  /**
   * Language outbound email is written in. `''` means "never chosen" — a real
   * state, unlike `timezone`, whose 'UTC' default is indistinguishable from a
   * deliberate choice. The settings page back-fills it from the active UI
   * language rather than waiting for a Save.
   */
  emailLocale: '' | 'en' | 'es';
  /** True once the current phone number was confirmed via SMS code. Read-only:
   *  only the confirm-verification endpoint can set it. */
  phoneVerified: boolean;
  /**
   * Whether the caller's own address is still on the outbound send list.
   * `undeliverable` means it hard-bounced or a complaint was filed and every
   * product email to it is being withheld — the `email` toggle above can read
   * "on" while that is true, which is exactly the state this field exists to
   * make visible. `unknown` means the server could not tell; render it as
   * uncertainty, never as health. Absent on older servers — treat as `unknown`.
   */
  emailStatus?: EmailDeliverabilityStatus;
  /** Why the address was suppressed. Null unless `emailStatus` is
   *  `undeliverable`; shown only to the address's own owner. */
  emailSuppressionReason?: EmailSuppressionReason | null;
  updatedAt: string;
}

export type EmailDeliverabilityStatus = 'ok' | 'undeliverable' | 'unknown';

export type EmailSuppressionReason = 'hard_bounce' | 'complaint' | 'soft_bounce_limit';

export interface StartVerificationResponse {
  sent: boolean;
  /** Local mock server only — production never echoes the code. */
  devCode?: string;
}

export const notificationService = {
  async subscribe(payload: PushSubscriptionPayload): Promise<void> {
    await api.post('/notifications/subscribe', payload);
  },

  async unsubscribe(endpoint: string): Promise<{ ok: true; remainingSubscriptions: number }> {
    const response = await api.post<{ ok: true; remainingSubscriptions: number }>(
      '/notifications/unsubscribe',
      { endpoint }
    );
    return response.data;
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
      | 'memberJoined'
      | 'taskUpForGrabs'
      | 'coverageUpdates'
      | 'careCredit'
      | 'yearRecap'
      | 'emailLocale'
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

  /**
   * Put the caller's own address back on the send list after a bounce or a
   * complaint suppressed it. The server takes the address from the session,
   * never from the client, so this can only ever affect the caller's own
   * mailbox. Returns the refreshed preferences.
   */
  async clearEmailSuppression(): Promise<NotificationPreferences> {
    const response = await api.delete<NotificationPreferences>('/notifications/email-suppression');
    return response.data;
  },
};
