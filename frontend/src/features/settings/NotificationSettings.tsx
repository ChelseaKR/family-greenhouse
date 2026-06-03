import { useEffect, useState } from 'react';
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
import { notificationService } from '@/services/notificationService';
import { getErrorMessage } from '@/services/api';

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
  const queryClient = useQueryClient();
  const [permission, setPermission] = useState<ReturnType<typeof getPermission>>(getPermission());
  const [browserActive, setBrowserActive] = useState(isEnabledLocally());
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phoneDraft, setPhoneDraft] = useState('');
  const [dndStartDraft, setDndStartDraft] = useState('');
  const [dndEndDraft, setDndEndDraft] = useState('');
  // Default to the user's actual timezone if the server doesn't have one
  // recorded yet — far better UX than UTC for first-time DND setup.
  const [tzDraft, setTzDraft] = useState(
    typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC'
  );

  useEffect(() => {
    setPermission(getPermission());
    setBrowserActive(isEnabledLocally());
  }, []);

  const prefsQuery = useQuery({
    queryKey: ['notification-prefs'],
    queryFn: notificationService.getPreferences,
  });

  useEffect(() => {
    if (prefsQuery.data) {
      setPhoneDraft(prefsQuery.data.phone);
      setDndStartDraft(prefsQuery.data.dndStart);
      setDndEndDraft(prefsQuery.data.dndEnd);
      if (prefsQuery.data.timezone) setTzDraft(prefsQuery.data.timezone);
    }
  }, [prefsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: notificationService.updatePreferences,
    onSuccess: (updated) => {
      queryClient.setQueryData(['notification-prefs'], updated);
      setInfo('Preferences saved.');
      setError(null);
    },
    onError: (err) => setError(getErrorMessage(err)),
  });

  /**
   * Helper that always sends the full prefs payload built from current draft
   * state + an `overrides` patch. Lets each toggle/input fire one mutation
   * call without having to re-list every field — and keeps DND, timezone,
   * etc. correctly preserved when other fields change.
   */
  function save(
    overrides: Partial<{
      browser: boolean;
      email: boolean;
      sms: boolean;
      phone: string;
      dndStart: string;
      dndEnd: string;
      timezone: string;
      pestAlerts: boolean;
    }>
  ): void {
    const current = prefsQuery.data;
    if (!current) return;
    saveMutation.mutate({
      browser: current.browser,
      email: current.email,
      sms: current.sms,
      phone: current.phone,
      dndStart: dndStartDraft,
      dndEnd: dndEndDraft,
      timezone: tzDraft,
      pestAlerts: current.pestAlerts ?? false,
      ...overrides,
    });
  }

  const enableBrowser = useMutation({
    mutationFn: async () => {
      const result = await requestPermission();
      if (result === 'unsupported') {
        throw new Error('This browser does not support notifications.');
      }
      if (result === 'denied') {
        throw new Error(
          'Notification permission was denied. Update your browser settings to enable.'
        );
      }
      try {
        const sub = await registerPushSubscription();
        if (sub) {
          const json = sub.toJSON();
          await notificationService.subscribe({
            endpoint: json.endpoint!,
            keys: { p256dh: json.keys!.p256dh!, auth: json.keys!.auth! },
          });
        }
      } catch (e) {
        // Local browser notifications still work even if push registration failed.
        console.warn('Push subscription failed', e);
      }
    },
    onSuccess: () => {
      setBrowserActive(true);
      setPermission(getPermission());
      setInfo("You'll now get browser reminders for overdue plants.");
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  const disableBrowser = useMutation({
    mutationFn: async () => {
      disableLocally();
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        if (sub) {
          await notificationService.unsubscribe(sub.endpoint);
          await sub.unsubscribe();
        }
      }
    },
    onSuccess: () => {
      setBrowserActive(false);
      setInfo('Browser notifications disabled.');
    },
  });

  if (!isSupported()) {
    return (
      <Card>
        <CardHeader title="Notifications" description="How you want to be reminded" />
        <Alert variant="info">Notifications aren't supported in this browser.</Alert>
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

  const prefs = prefsQuery.data!;
  const canEnableBrowser = permission !== 'denied';

  return (
    <Card>
      <CardHeader
        title="Notifications"
        description="Choose how you want to be reminded about overdue plant care."
      />
      <div className="space-y-6">
        {error && <Alert variant="error">{error}</Alert>}
        {info && <Alert variant="success">{info}</Alert>}

        {/* Browser */}
        <div className="flex items-center justify-between gap-4 border-b border-gray-200 pb-4">
          <div>
            <p className="text-sm font-medium text-gray-900">Browser</p>
            <p className="text-sm text-gray-500">
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
            >
              Turn off
            </Button>
          ) : (
            <Button
              onClick={() => enableBrowser.mutate()}
              isLoading={enableBrowser.isPending}
              disabled={!canEnableBrowser}
            >
              Enable
            </Button>
          )}
        </div>

        {/* Email */}
        <div className="flex items-center justify-between gap-4 border-b border-gray-200 pb-4">
          <div>
            <p className="text-sm font-medium text-gray-900">Email</p>
            <p className="text-sm text-gray-500">
              Daily roll-up to your account email when tasks are due in the next 24 hours.
            </p>
          </div>
          <label className="inline-flex items-center cursor-pointer">
            <span className="sr-only">Email notifications</span>
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={prefs.email}
              onChange={(e) => save({ email: e.target.checked })}
            />
          </label>
        </div>

        {/* SMS */}
        <div className="space-y-3 pb-2">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-gray-900">Text message</p>
              <p className="text-sm text-gray-500">
                Short SMS reminders when tasks slip past due. Standard message rates may apply.
              </p>
            </div>
            <label className="inline-flex items-center cursor-pointer">
              <span className="sr-only">SMS notifications</span>
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={prefs.sms}
                disabled={prefs.sms ? false : !E164.test(phoneDraft)}
                onChange={(e) => save({ sms: e.target.checked, phone: phoneDraft })}
              />
            </label>
          </div>
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <Input
                label="Phone number"
                type="tel"
                inputMode="tel"
                placeholder="+15551234567"
                helperText="E.164 format. Leading + and country code required."
                value={phoneDraft}
                onChange={(e) => setPhoneDraft(e.target.value.trim())}
                error={
                  phoneDraft && !E164.test(phoneDraft) ? 'Use the format +15551234567' : undefined
                }
              />
            </div>
            <Button
              variant="secondary"
              onClick={() => save({ phone: phoneDraft })}
              isLoading={saveMutation.isPending}
              disabled={!!phoneDraft && !E164.test(phoneDraft)}
            >
              Save phone
            </Button>
          </div>
        </div>

        {/* Pest alerts */}
        <div className="flex items-center justify-between gap-4 pt-2">
          <div>
            <p className="text-sm font-medium text-gray-900">Seasonal pest heads-ups</p>
            <p className="text-sm text-gray-500">
              When a plant in your household enters a typical pest season (spider mites, aphids,
              etc.) we&rsquo;ll send one nudge per quarter to check it. Only fires for plants with a
              recognized species.
            </p>
          </div>
          <label className="inline-flex items-center cursor-pointer">
            <span className="sr-only">Pest alerts</span>
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={prefs.pestAlerts ?? false}
              onChange={(e) => save({ pestAlerts: e.target.checked })}
            />
          </label>
        </div>

        {/* Quiet hours */}
        <div className="space-y-3 pt-2">
          <div>
            <p className="text-sm font-medium text-gray-900">Quiet hours</p>
            <p className="text-sm text-gray-500">
              Email + SMS reminders pause during this window. Browser pop-ups follow your OS Do Not
              Disturb settings instead.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <Input
              label="Start"
              type="time"
              value={dndStartDraft}
              onChange={(e) => setDndStartDraft(e.target.value)}
              helperText="24-hour, your local time"
            />
            <Input
              label="End"
              type="time"
              value={dndEndDraft}
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
              disabled={!dndStartDraft && !dndEndDraft}
            >
              Clear
            </Button>
            <Button
              onClick={() => save({})}
              isLoading={saveMutation.isPending}
              disabled={(!!dndStartDraft || !!dndEndDraft) && (!dndStartDraft || !dndEndDraft)}
            >
              Save quiet hours
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
