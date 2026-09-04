import { useEffect, useRef, useState } from 'react';
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
type PreferencesUpdate = Parameters<typeof notificationService.updatePreferences>[0];

interface SaveVariables {
  overrides: Partial<PreferencesUpdate>;
  /** A background write the user did not ask for: no "saved" banner on success. */
  quiet?: boolean;
}

/**
 * IANA zone this browser reports, or null when it cannot be resolved (no Intl,
 * a runtime that throws, or one that answers with a placeholder). Null means
 * "leave the stored value alone" — never a guessed zone.
 */
function resolveBrowserTimeZone(): string | null {
  try {
    if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') return null;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof zone !== 'string' || zone.trim() === '' || zone === 'Etc/Unknown') return null;
    return zone;
  } catch {
    return null;
  }
}

/** Zones equivalent to the server's UTC default; persisting one changes nothing. */
const UTC_ALIASES = new Set(['UTC', 'Etc/UTC', 'Etc/GMT', 'GMT']);

/**
 * The API has no "timezone never chosen" state: GET /notifications/prefs
 * answers 'UTC' both for a row that was never written and for one saved as
 * UTC, and PUT stores 'UTC' whenever a client omits the field. UTC is thus the
 * server's own "not provided" sentinel — the only signal this client has that
 * a zone still needs choosing.
 */
function isServerDefaultTimeZone(zone: string): boolean {
  return zone === '' || zone === 'UTC';
}

function buildPreferencesUpdate(
  current: NotificationPreferences,
  overrides: Partial<PreferencesUpdate>
): PreferencesUpdate {
  return {
    browser: current.browser,
    email: current.email,
    sms: current.sms,
    phone: current.phone,
    dndStart: current.dndStart,
    dndEnd: current.dndEnd,
    timezone: current.timezone,
    pestAlerts: current.pestAlerts ?? false,
    weeklyDigest: current.weeklyDigest ?? true,
    // Household emails. `?? true` matches the server's read-time defaulting for
    // rows written before these toggles existed (on iff email is on), so a
    // save from this form never silently flips one off.
    memberJoined: current.memberJoined ?? true,
    taskUpForGrabs: current.taskUpForGrabs ?? true,
    coverageUpdates: current.coverageUpdates ?? true,
    careCredit: current.careCredit ?? true,
    ...overrides,
  };
}

/** The household-email toggles, in the order they appear in the form. Kept as
 *  data so the four rows are one map, not four near-identical JSX blocks. */
const HOUSEHOLD_EMAIL_TOGGLES = [
  { key: 'memberJoined', titleKey: 'memberJoinedTitle', descriptionKey: 'memberJoinedDescription' },
  {
    key: 'taskUpForGrabs',
    titleKey: 'taskUpForGrabsTitle',
    descriptionKey: 'taskUpForGrabsDescription',
  },
  {
    key: 'coverageUpdates',
    titleKey: 'coverageUpdatesTitle',
    descriptionKey: 'coverageUpdatesDescription',
  },
  { key: 'careCredit', titleKey: 'careCreditTitle', descriptionKey: 'careCreditDescription' },
] as const;

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
  // Resolved once per mount; null when this browser cannot name its zone.
  const [browserTimeZone] = useState(resolveBrowserTimeZone);
  const [tzDraft, setTzDraft] = useState(browserTimeZone ?? 'UTC');
  // The background timezone write below runs at most once per mount.
  const timezoneDefaulted = useRef(false);
  // Last server record mirrored into the drafts, so a write that leaves a
  // field unchanged does not wipe an edit the user has in progress.
  const lastSynced = useRef<NotificationPreferences | null>(null);

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

  const saveMutation = useMutation({
    scope: preferencesMutationScope,
    mutationFn: ({ overrides }: SaveVariables) => {
      const current = currentPreferences();
      if (!current) throw new Error(t('notifications.preferencesUnavailable'));
      return notificationService.updatePreferences(buildPreferencesUpdate(current, overrides));
    },
    onMutate: () => {
      setInfo(null);
      setError(null);
    },
    onSuccess: (updated, { quiet }) => {
      queryClient.setQueryData(prefsKey, updated);
      // A background write the user never asked for earns no "saved" banner;
      // a failure still surfaces through onError so nothing is hidden.
      if (!quiet) setInfo(t('notifications.preferencesSaved'));
      setError(null);
    },
    onError: (err) => setError(getErrorMessage(err)),
  });

  /**
   * Resume email after a bounce or a complaint suppressed the address. Shares
   * the preferences mutation scope so it cannot race a toggle write, and
   * writes the refreshed prefs straight into the cache so the banner clears.
   */
  const resumeEmailMutation = useMutation({
    scope: preferencesMutationScope,
    mutationFn: () => notificationService.clearEmailSuppression(),
    onMutate: () => {
      setInfo(null);
      setError(null);
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(prefsKey, updated);
      setInfo(t('notifications.emailResumed'));
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
    saveMutation.mutate({ overrides });
  }
  // TanStack memoises `mutate` per observer, so the effect below can depend
  // on it without re-running every render.
  const { mutate: persistPreferences } = saveMutation;

  // Mirror the persisted record into the drafts — only the fields the server
  // actually changed, so a write that returns the same phone or quiet hours
  // never wipes an edit in progress.
  //
  // The timezone gets one extra step. Quiet hours are evaluated server-side in
  // `timezone`, and the server defaults it to UTC, so a user who entered
  // "22:00–07:00" without ever touching the Timezone field was silenced on UTC
  // hours, not their own. On the first load that still carries the default,
  // persist this browser's zone through the same write path Save uses —
  // quietly, and at most once per mount, so choosing UTC on purpose in this
  // session is respected rather than overridden on the next refetch.
  useEffect(() => {
    const data = prefsQuery.data;
    if (!data) return;
    const prev = lastSynced.current;
    lastSynced.current = data;
    if (!prev || prev.phone !== data.phone) setPhoneDraft(data.phone);
    if (!prev || prev.dndStart !== data.dndStart) setDndStartDraft(data.dndStart);
    if (!prev || prev.dndEnd !== data.dndEnd) setDndEndDraft(data.dndEnd);

    if (
      !timezoneDefaulted.current &&
      isServerDefaultTimeZone(data.timezone) &&
      browserTimeZone !== null &&
      !UTC_ALIASES.has(browserTimeZone)
    ) {
      timezoneDefaulted.current = true;
      setTzDraft(browserTimeZone);
      persistPreferences({ overrides: { timezone: browserTimeZone }, quiet: true });
      return;
    }
    // Otherwise show what is actually stored. When the browser cannot resolve
    // a zone this leaves the server default visible as "UTC" — the truth —
    // rather than a guess.
    if (!prev || prev.timezone !== data.timezone) setTzDraft(data.timezone || 'UTC');
  }, [prefsQuery.data, browserTimeZone, persistPreferences]);

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
          buildPreferencesUpdate(current, { browser: true })
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
              buildPreferencesUpdate(current, { browser: false })
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
  // Three states, and a fourth: the field being ABSENT means this server
  // predates the contract and never looked, which is different from it having
  // looked and failed (`'unknown'`). Absent renders nothing; `'unknown'`
  // renders "we could not check", because a failed check is not a clean bill
  // of health and must not be shown as one.
  const emailStatus = prefs.emailStatus;
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

        {/* Deliverability. The toggle above can say "on" while nothing is
            arriving; this is the only place that difference is visible. */}
        {emailStatus === 'undeliverable' && (
          <div className="space-y-3 border-b border-primary-100/70 pb-4">
            <Alert variant="warning">
              {prefs.emailSuppressionReason === 'complaint'
                ? t('notifications.emailSuppressedComplaint')
                : t('notifications.emailSuppressedBounce')}
            </Alert>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => resumeEmailMutation.mutate()}
              isLoading={resumeEmailMutation.isPending}
            >
              {t('notifications.emailResume')}
            </Button>
          </div>
        )}
        {emailStatus === 'unknown' && (
          <div className="border-b border-primary-100/70 pb-4">
            <Alert variant="info">{t('notifications.emailStatusUnknown')}</Alert>
          </div>
        )}

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

        {/* Household emails — one switch each. Before these, `weeklyDigest` was
            the only per-email control in the product, so anyone who wanted
            fewer emails had to turn the whole channel off. */}
        <div className="border-b border-primary-100/70 pb-4">
          <p className="text-sm font-medium text-gray-900">
            {t('notifications.householdEmailsTitle')}
          </p>
          <p className="text-sm text-gray-600">
            {prefs.email
              ? t('notifications.householdEmailsDescription')
              : t('notifications.householdEmailsRequiresEmail')}
          </p>
          <div className="mt-3 space-y-3">
            {HOUSEHOLD_EMAIL_TOGGLES.map((toggle) => (
              <div key={toggle.key} className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm text-gray-900">{t(`notifications.${toggle.titleKey}`)}</p>
                  <p className="text-xs text-gray-600">
                    {t(`notifications.${toggle.descriptionKey}`)}
                  </p>
                </div>
                <label className="inline-flex items-center cursor-pointer">
                  <span className="sr-only">{t(`notifications.${toggle.titleKey}`)}</span>
                  <input
                    type="checkbox"
                    className="h-5 w-5 accent-primary-700"
                    checked={(prefs[toggle.key] ?? true) && prefs.email}
                    disabled={!prefs.email || saveMutation.isPending}
                    onChange={(e) => save({ [toggle.key]: e.target.checked })}
                  />
                </label>
              </div>
            ))}
          </div>
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
