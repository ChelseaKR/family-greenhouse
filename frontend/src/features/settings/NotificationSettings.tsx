import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import {
  disableLocally,
  getPermission,
  isEnabledLocally,
  isSupported,
  requestPermission,
} from '@/utils/notifications';
import { notificationService, type NotificationPreferences } from '@/services/notificationService';
import {
  buildPreferencesUpdate,
  resolveBrowserTimeZone,
  type PreferencesUpdate,
} from './preferencesUpdate';
import { getErrorMessage } from '@/services/api';
import { isNativeApp } from '@/lib/platform';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';

const VAPID_PUBLIC_KEY = (import.meta.env.VITE_VAPID_PUBLIC_KEY ?? '') as string;

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const b64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registerPushSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  if (!VAPID_PUBLIC_KEY) return null;
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing;
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });
}

const E164 = /^\+[1-9]\d{6,14}$/;

export function NotificationSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const householdId = useActiveHouseholdId();
  const native = isNativeApp();
  const [permission, setPermission] = useState<ReturnType<typeof getPermission>>(getPermission());
  const [browserActive, setBrowserActive] = useState(isEnabledLocally());
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phoneDraft, setPhoneDraft] = useState('');
  const [codeDraft, setCodeDraft] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [dndStartDraft, setDndStartDraft] = useState('');
  const [dndEndDraft, setDndEndDraft] = useState('');
  // Default to the user's actual timezone if the server doesn't have one
  // recorded yet — far better UX than UTC for first-time DND setup.
  const [tzDraft, setTzDraft] = useState(resolveBrowserTimeZone());

  const prefsQuery = useQuery({
    // Preferences are stored per household membership — scope by household.
    queryKey: ['notification-prefs', householdId],
    queryFn: notificationService.getPreferences,
    enabled: Boolean(householdId),
  });
  const prefsKey = ['notification-prefs', householdId] as const;
  const browserPreference = prefsQuery.data?.browser ?? false;

  useEffect(() => {
    if (native) return;

    const refreshBrowserState = () => {
      setPermission(getPermission());
      // The local permission/opt-in and the durable account preference must
      // both agree before the UI calls this device active.
      setBrowserActive(isEnabledLocally() && browserPreference);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshBrowserState();
    };

    refreshBrowserState();
    // Browser permission can change in site settings while this page remains
    // mounted. Re-read it when the user returns instead of leaving a denied
    // Enable button stale until a full reload.
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('focus', refreshBrowserState);
    window.addEventListener('pageshow', refreshBrowserState);
    return () => {
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('focus', refreshBrowserState);
      window.removeEventListener('pageshow', refreshBrowserState);
    };
  }, [browserPreference, native]);

  // TanStack serializes mutations that share a scope id. Browser enable/
  // disable, phone verification, and ordinary toggles all replace the same
  // server document, so letting them race can silently restore an older
  // field value from the slower request.
  const preferencesMutationScope = {
    id: `notification-preferences:${householdId ?? 'none'}`,
  };

  function currentPreferences(): NotificationPreferences | undefined {
    return queryClient.getQueryData<NotificationPreferences>(prefsKey) ?? prefsQuery.data;
  }

  useEffect(() => {
    if (prefsQuery.data) {
      setPhoneDraft(prefsQuery.data.phone);
      setDndStartDraft(prefsQuery.data.dndStart);
      setDndEndDraft(prefsQuery.data.dndEnd);
      if (prefsQuery.data.timezone) setTzDraft(prefsQuery.data.timezone);
    }
  }, [prefsQuery.data]);

  const saveMutation = useMutation({
    scope: preferencesMutationScope,
    mutationFn: (overrides: Partial<PreferencesUpdate>) => {
      const current = currentPreferences();
      if (!current) throw new Error(t('notifications.preferencesUnavailable'));
      return notificationService.updatePreferences(
        buildPreferencesUpdate(current, overrides, resolveBrowserTimeZone())
      );
    },
    onMutate: () => {
      setInfo(null);
      setError(null);
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(prefsKey, updated);
      setInfo(t('notifications.preferencesSaved'));
      setError(null);
    },
    onError: (err) => setError(getErrorMessage(err)),
  });

  /**
   * Helper that always sends the full prefs payload built from the last
   * PERSISTED preferences + an `overrides` patch. Lets each toggle/input
   * fire one mutation call without having to re-list every field. DND/tz
   * default to the saved values (not the in-progress draft state) so that
   * an unrelated toggle never silently commits a half-edited quiet-hours
   * draft — only the explicit "Save quiet hours" action should do that,
   * via an explicit override.
   */
  function save(overrides: Partial<PreferencesUpdate>): void {
    if (!currentPreferences()) return;
    saveMutation.mutate(overrides);
  }

  const sendCodeMutation = useMutation({
    mutationFn: () => notificationService.startPhoneVerification(phoneDraft),
    onSuccess: () => {
      setCodeSent(true);
      setCodeDraft('');
      setInfo(t('notifications.phoneCodeSent'));
      setError(null);
    },
    onError: (err) => setError(getErrorMessage(err)),
  });

  const verifyCodeMutation = useMutation({
    scope: preferencesMutationScope,
    mutationFn: () => notificationService.confirmPhoneVerification(codeDraft),
    onSuccess: (updated) => {
      queryClient.setQueryData(prefsKey, updated);
      setCodeSent(false);
      setCodeDraft('');
      setInfo(t('notifications.phoneVerifySuccess'));
      setError(null);
    },
    onError: (err) => setError(getErrorMessage(err)),
  });

  const enableBrowser = useMutation({
    scope: preferencesMutationScope,
    mutationFn: async () => {
      const current = currentPreferences();
      if (!current) throw new Error(t('notifications.preferencesUnavailable'));

      const result = await requestPermission();
      if (result === 'unsupported') {
        throw new Error(t('notifications.browserUnsupportedError'));
      }
      if (result === 'denied') {
        throw new Error(t('notifications.browserDeniedError'));
      }
      if (result !== 'granted') {
        // Browsers return "default" when the prompt is dismissed. Treat that
        // as no consent: do not persist browser=true or present an enabled UI.
        throw new Error(t('notifications.browserDismissedError'));
      }

      let subscription: PushSubscription | null = null;
      let backgroundPush = false;
      let backgroundPushFailed = false;
      try {
        subscription = await registerPushSubscription();
        if (subscription) {
          const json = subscription.toJSON();
          await notificationService.subscribe({
            endpoint: subscription.endpoint,
            keys: { p256dh: json.keys!.p256dh!, auth: json.keys!.auth! },
          });
          backgroundPush = true;
        }
      } catch (e) {
        // Local browser notifications still work even if push registration failed.
        backgroundPushFailed = true;
        console.warn('Push subscription failed', e);
      }

      try {
        const updated = await notificationService.updatePreferences(
          buildPreferencesUpdate(current, { browser: true }, resolveBrowserTimeZone())
        );
        return { updated, backgroundPush, backgroundPushFailed };
      } catch (cause) {
        // requestPermission persists the local opt-in. Roll it back when the
        // durable server preference cannot be saved, so the UI and delivery
        // gate never claim contradictory states.
        disableLocally();
        if (subscription) {
          await notificationService.unsubscribe(subscription.endpoint).catch(() => undefined);
          await subscription.unsubscribe().catch(() => false);
        }
        throw cause;
      }
    },
    onMutate: () => {
      setInfo(null);
      setError(null);
    },
    onSuccess: ({ updated, backgroundPush, backgroundPushFailed }) => {
      queryClient.setQueryData(prefsKey, updated);
      setBrowserActive(true);
      setPermission(getPermission());
      setInfo(
        backgroundPush
          ? t('notifications.browserEnabledBackground')
          : backgroundPushFailed
            ? t('notifications.browserEnabledForegroundFailed')
            : t('notifications.browserEnabledForegroundUnavailable')
      );
      setError(null);
    },
    onError: (err) => setError(getErrorMessage(err)),
  });

  const disableBrowser = useMutation({
    scope: preferencesMutationScope,
    mutationFn: async () => {
      const current = currentPreferences();
      if (!current) throw new Error(t('notifications.preferencesUnavailable'));

      let remainingSubscriptions: number | undefined;
      // Whether background push for THIS device is known to be gone. It stays
      // false while any step of the teardown failed or never ran, because a
      // failed teardown leaves a live subscription: the browser keeps
      // receiving reminders that the success copy has just told the user are
      // off. Only a confirmed teardown (or a device that had no subscription
      // to begin with) earns the confident message.
      let backgroundPushCleared = false;
      try {
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.getRegistration();
          const sub = await reg?.pushManager?.getSubscription();
          if (sub) {
            // `PushSubscription.unsubscribe()` resolves false when it did not
            // actually unsubscribe; a rejection is a hard failure. Neither is
            // a teardown, so neither may be discarded.
            const browserUnsubscribed = await sub.unsubscribe().catch((cause) => {
              console.warn('Browser push unsubscribe failed', cause);
              return false;
            });
            const result = await notificationService.unsubscribe(sub.endpoint).catch((cause) => {
              console.warn('Server push subscription cleanup failed', cause);
              return undefined;
            });
            remainingSubscriptions = result?.remainingSubscriptions;
            backgroundPushCleared = browserUnsubscribed === true && result !== undefined;
          } else {
            // No push subscription on this device: clearing the local
            // foreground opt-in below is the whole teardown.
            backgroundPushCleared = true;
          }
        } else {
          // No service worker => no background push was ever registered here.
          backgroundPushCleared = true;
        }
      } catch (cause) {
        // A broken/stale service worker must not prevent this device's local
        // foreground opt-in from being cleared — but it does mean we could not
        // confirm that background push is gone.
        console.warn('Browser push cleanup failed', cause);
      }

      // `browser` is an account-wide delivery gate shared by every browser.
      // Turning off this device must not silence subscriptions on a laptop or
      // phone. Close the global gate only after the server confirms this was
      // the last registered endpoint; otherwise leave the persisted prefs
      // untouched and clear only this device's local opt-in below.
      const updated =
        remainingSubscriptions === 0
          ? await notificationService.updatePreferences(
              buildPreferencesUpdate(current, { browser: false }, resolveBrowserTimeZone())
            )
          : current;
      disableLocally();
      return { updated, backgroundPushCleared };
    },
    onMutate: () => {
      setInfo(null);
      setError(null);
    },
    onSuccess: ({ updated, backgroundPushCleared }) => {
      queryClient.setQueryData(prefsKey, updated);
      setBrowserActive(false);
      if (backgroundPushCleared) {
        setInfo(t('notifications.browserDisabled'));
        setError(null);
      } else {
        // Say what actually happened. Claiming "disabled" here sent the user
        // away believing a channel was off while it was still delivering.
        setInfo(null);
        setError(t('notifications.browserDisabledCleanupUnconfirmed'));
      }
    },
    onError: (err) => setError(getErrorMessage(err)),
  });

  if (!householdId) {
    return (
      <Card>
        <CardHeader title="Notifications" description="How you want to be reminded" />
        <Alert variant="info">{t('notifications.householdRequired')}</Alert>
      </Card>
    );
  }

  if (prefsQuery.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!prefsQuery.data) {
    return (
      <Card>
        <CardHeader title="Notifications" description="How you want to be reminded" />
        <div className="space-y-3">
          <Alert variant="error">
            {getErrorMessage(prefsQuery.error) || t('notifications.loadFailed')}
          </Alert>
          <Button
            variant="secondary"
            onClick={() => void prefsQuery.refetch()}
            isLoading={prefsQuery.isFetching}
          >
            {t('common.retry')}
          </Button>
        </div>
      </Card>
    );
  }

  const prefs = prefsQuery.data;
  const smsAvailable = prefs.smsAvailable ?? false;
  const browserSupported = isSupported();
  const canEnableBrowser = browserSupported && permission !== 'denied';
  // Verified status applies to the SAVED number; editing the field to a
  // different number drops back to the unverified flow until confirmed.
  const phoneIsVerified =
    (prefs.phoneVerified ?? false) && prefs.phone !== '' && phoneDraft === prefs.phone;
  const browserMutationPending = enableBrowser.isPending || disableBrowser.isPending;

  return (
    <Card>
      <CardHeader
        title="Notifications"
        description="Choose how you want to be reminded about overdue plant care."
      />
      <div className="space-y-6">
        {error && <Alert variant="error">{error}</Alert>}
        {info && <Alert variant="success">{info}</Alert>}

        {/* Native delivery is deliberately hidden until the APNs/FCM sender
            is live. Showing a permission toggle before reminders can arrive
            would be a misleading, non-functional control in store builds. */}
        {!native && browserSupported && (
          <div className="flex items-center justify-between gap-4 border-b border-primary-100/70 pb-4">
            <div>
              <p className="text-sm font-medium text-gray-900">{t('notifications.browser')}</p>
              <p className="text-sm text-gray-600">
                {browserActive
                  ? 'Pop-ups appear while a tab is open or the app is installed.'
                  : permission === 'denied'
                    ? 'Permission denied — update your browser settings to re-enable.'
                    : 'Enable to be alerted when overdue tasks appear in the dashboard.'}
              </p>
            </div>
            {browserActive ? (
              <Button
                variant="secondary"
                onClick={() => disableBrowser.mutate()}
                isLoading={disableBrowser.isPending}
                disabled={browserMutationPending}
              >
                Turn off
              </Button>
            ) : (
              <Button
                onClick={() => enableBrowser.mutate()}
                isLoading={enableBrowser.isPending}
                disabled={!canEnableBrowser || browserMutationPending}
              >
                Enable
              </Button>
            )}
          </div>
        )}

        {!native && !browserSupported && (
          <div className="border-b border-primary-100/70 pb-4">
            <p className="text-sm font-medium text-gray-900">{t('notifications.browser')}</p>
            <p className="text-sm text-gray-600">{t('notifications.browserUnsupportedDevice')}</p>
          </div>
        )}

        {/* Email */}
        <div className="flex items-center justify-between gap-4 border-b border-primary-100/70 pb-4">
          <div>
            <p className="text-sm font-medium text-gray-900">Email</p>
            <p className="text-sm text-gray-600">
              Daily roll-up to your account email when tasks are due in the next 24 hours.
            </p>
          </div>
          <label className="inline-flex items-center cursor-pointer">
            <span className="sr-only">Email notifications</span>
            <input
              type="checkbox"
              className="h-5 w-5 accent-primary-700"
              checked={prefs.email}
              disabled={saveMutation.isPending}
              onChange={(e) => save({ email: e.target.checked })}
            />
          </label>
        </div>

        {/* Weekly digest */}
        <div className="flex items-center justify-between gap-4 border-b border-primary-100/70 pb-4">
          <div>
            <p className="text-sm font-medium text-gray-900">
              {t('notifications.weeklyDigestTitle')}
            </p>
            <p className="text-sm text-gray-600">
              {prefs.email
                ? t('notifications.weeklyDigestDescription')
                : t('notifications.weeklyDigestRequiresEmail')}
            </p>
          </div>
          <label className="inline-flex items-center cursor-pointer">
            <span className="sr-only">{t('notifications.weeklyDigestTitle')}</span>
            <input
              type="checkbox"
              className="h-5 w-5 accent-primary-700"
              checked={(prefs.weeklyDigest ?? true) && prefs.email}
              disabled={!prefs.email || saveMutation.isPending}
              onChange={(e) => save({ weeklyDigest: e.target.checked })}
            />
          </label>
        </div>

        {/* SMS */}
        <div className="space-y-3 pb-2">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-gray-900">Text message</p>
              <p className="text-sm text-gray-600">
                {!smsAvailable
                  ? t('notifications.smsUnavailableShort')
                  : phoneIsVerified || prefs.sms
                    ? 'Short SMS reminders when tasks are due or overdue. Standard message rates may apply.'
                    : t('notifications.phoneUnverifiedHint')}
              </p>
            </div>
            <label className="inline-flex items-center cursor-pointer">
              <span className="sr-only">SMS notifications</span>
              <input
                type="checkbox"
                className="h-5 w-5 accent-primary-700"
                checked={prefs.sms}
                // Allow turning OFF anytime; turning ON requires a verified number.
                disabled={
                  saveMutation.isPending || (prefs.sms ? false : !smsAvailable || !phoneIsVerified)
                }
                onChange={(e) => save({ sms: e.target.checked, phone: prefs.phone })}
              />
            </label>
          </div>
          {!smsAvailable ? (
            <Alert variant="info">{t('notifications.smsUnavailable')}</Alert>
          ) : (
            <>
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <Input
                    label="Phone number"
                    type="tel"
                    inputMode="tel"
                    placeholder="+15551234567"
                    helperText="E.164 format. Leading + and country code required."
                    value={phoneDraft}
                    disabled={sendCodeMutation.isPending || verifyCodeMutation.isPending}
                    onChange={(e) => {
                      setPhoneDraft(e.target.value.trim());
                      setCodeSent(false);
                    }}
                    error={
                      phoneDraft && !E164.test(phoneDraft)
                        ? 'Use the format +15551234567'
                        : undefined
                    }
                  />
                </div>
                {phoneIsVerified ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-full bg-green-100 px-3 py-1.5 text-sm font-medium text-green-800"
                    data-testid="phone-verified-badge"
                  >
                    ✓ {t('notifications.phoneVerifiedBadge')}
                  </span>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={() => sendCodeMutation.mutate()}
                    isLoading={sendCodeMutation.isPending}
                    disabled={!E164.test(phoneDraft) || verifyCodeMutation.isPending}
                  >
                    {t('notifications.phoneSendCode')}
                  </Button>
                )}
              </div>
              {codeSent && !phoneIsVerified && (
                <div className="flex items-end gap-3">
                  <div className="flex-1">
                    <Input
                      label={t('notifications.phoneCodeLabel')}
                      inputMode="numeric"
                      placeholder="123456"
                      helperText={t('notifications.phoneCodeHelper')}
                      value={codeDraft}
                      disabled={verifyCodeMutation.isPending}
                      onChange={(e) => setCodeDraft(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    />
                  </div>
                  <Button
                    onClick={() => verifyCodeMutation.mutate()}
                    isLoading={verifyCodeMutation.isPending}
                    disabled={codeDraft.length !== 6 || sendCodeMutation.isPending}
                  >
                    {t('notifications.phoneVerifyButton')}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Pest alerts */}
        <div className="flex items-center justify-between gap-4 pt-2">
          <div>
            <p className="text-sm font-medium text-gray-900">Seasonal pest heads-ups</p>
            <p className="text-sm text-gray-600">
              When a plant in your household enters a typical pest season (spider mites, aphids,
              etc.) we&rsquo;ll send one nudge per quarter to check it. Only fires for plants with a
              recognized species.
            </p>
          </div>
          <label className="inline-flex items-center cursor-pointer">
            <span className="sr-only">Pest alerts</span>
            <input
              type="checkbox"
              className="h-5 w-5 accent-primary-700"
              checked={prefs.pestAlerts ?? false}
              disabled={saveMutation.isPending}
              onChange={(e) => save({ pestAlerts: e.target.checked })}
            />
          </label>
        </div>

        {/* Quiet hours */}
        <div className="space-y-3 pt-2">
          <div>
            <p className="text-sm font-medium text-gray-900">Quiet hours</p>
            <p className="text-sm text-gray-600">
              Email + SMS reminders pause during this window. Browser pop-ups follow your OS Do Not
              Disturb settings instead.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 items-end">
            <Input
              label="Start"
              type="time"
              value={dndStartDraft}
              disabled={saveMutation.isPending}
              onChange={(e) => setDndStartDraft(e.target.value)}
              helperText="24-hour, your local time"
            />
            <Input
              label="End"
              type="time"
              value={dndEndDraft}
              disabled={saveMutation.isPending}
              onChange={(e) => setDndEndDraft(e.target.value)}
              helperText="If end is earlier than start, the window wraps past midnight."
            />
            <div>
              <label htmlFor="dnd-tz" className="label">
                Timezone
              </label>
              <input
                id="dnd-tz"
                className="input"
                value={tzDraft}
                disabled={saveMutation.isPending}
                onChange={(e) => setTzDraft(e.target.value)}
                placeholder="America/New_York"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setDndStartDraft('');
                setDndEndDraft('');
                save({ dndStart: '', dndEnd: '' });
              }}
              disabled={saveMutation.isPending || (!dndStartDraft && !dndEndDraft)}
            >
              Clear
            </Button>
            <Button
              onClick={() =>
                save({ dndStart: dndStartDraft, dndEnd: dndEndDraft, timezone: tzDraft })
              }
              isLoading={saveMutation.isPending}
              disabled={
                saveMutation.isPending ||
                ((!!dndStartDraft || !!dndEndDraft) && (!dndStartDraft || !dndEndDraft))
              }
            >
              Save quiet hours
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
