import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationSettings } from '@/features/settings/NotificationSettings';
import type { NotificationPreferences } from '@/services/notificationService';

const notificationApi = vi.hoisted(() => ({
  supported: true,
  enabledLocally: false,
  permission: 'default' as NotificationPermission | 'unsupported',
}));

vi.mock('@/services/notificationService', () => ({
  notificationService: {
    getPreferences: vi.fn(),
    updatePreferences: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    runReminders: vi.fn(),
    startPhoneVerification: vi.fn(),
    confirmPhoneVerification: vi.fn(),
  },
}));

vi.mock('@/utils/notifications', () => ({
  isSupported: () => notificationApi.supported,
  isEnabledLocally: () => notificationApi.enabledLocally,
  disableLocally: vi.fn(),
  getPermission: () => notificationApi.permission,
  requestPermission: vi.fn(),
}));

vi.mock('@/hooks/useActiveHouseholdId', () => ({
  useActiveHouseholdId: () => 'hh-1',
}));

function prefs(over: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return {
    userId: 'u-1',
    browser: false,
    email: true,
    sms: false,
    smsAvailable: true,
    phone: '',
    dndStart: '',
    dndEnd: '',
    timezone: 'UTC',
    // Server-derived: false = the stored 'UTC' above is the read-time
    // fallback, not a zone the user picked (#342).
    timezoneSet: false,
    pestAlerts: false,
    weeklyDigest: true,
    phoneVerified: false,
    updatedAt: '',
    ...over,
  };
}

async function renderSettings(initial: NotificationPreferences) {
  const { notificationService } = await import('@/services/notificationService');
  vi.mocked(notificationService.getPreferences).mockResolvedValue(initial);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <NotificationSettings />
    </QueryClientProvider>
  );
  // Wait for the prefs query to settle (the loading spinner to give way).
  await screen.findByRole('checkbox', { name: 'Weekly plant digest' });
  return { notificationService };
}

describe('NotificationSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    notificationApi.supported = true;
    notificationApi.enabledLocally = false;
    notificationApi.permission = 'default';
  });

  it('shows the weekly digest toggle (checked by default) and saves an opt-out', async () => {
    const user = userEvent.setup();
    const { notificationService } = await renderSettings(prefs());
    vi.mocked(notificationService.updatePreferences).mockResolvedValue(
      prefs({ weeklyDigest: false })
    );

    const toggle = screen.getByRole('checkbox', { name: 'Weekly plant digest' });
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();

    await user.click(toggle);
    await waitFor(() => expect(notificationService.updatePreferences).toHaveBeenCalledOnce());
    // mutationFn receives (variables, context) — assert on the payload only.
    expect(vi.mocked(notificationService.updatePreferences).mock.calls[0][0]).toMatchObject({
      weeklyDigest: false,
      email: true,
    });
  });

  it('disables the weekly digest toggle when email notifications are off', async () => {
    await renderSettings(prefs({ email: false }));
    const toggle = screen.getByRole('checkbox', { name: 'Weekly plant digest' });
    expect(toggle).toBeDisabled();
    expect(
      screen.getByText('Turn on email notifications to receive the weekly digest.')
    ).toBeInTheDocument();
  });

  it('keeps the SMS toggle disabled until the phone is verified', async () => {
    const user = userEvent.setup();
    await renderSettings(prefs());

    const smsToggle = screen.getByRole('checkbox', { name: 'SMS notifications' });
    expect(smsToggle).toBeDisabled();

    // Typing a valid E.164 number is NOT enough — verification is required.
    await user.type(screen.getByLabelText('Phone number'), '+15551234567');
    expect(smsToggle).toBeDisabled();
    expect(
      screen.getByText('Verify your phone number to enable SMS reminders.')
    ).toBeInTheDocument();
  });

  it('walks through send-code → verify → verified badge and enables SMS', async () => {
    const user = userEvent.setup();
    const { notificationService } = await renderSettings(prefs());
    vi.mocked(notificationService.startPhoneVerification).mockResolvedValue({ sent: true });
    vi.mocked(notificationService.confirmPhoneVerification).mockResolvedValue(
      prefs({ phone: '+15551234567', phoneVerified: true })
    );

    // Send the code.
    const sendCode = screen.getByRole('button', { name: 'Send code' });
    expect(sendCode).toBeDisabled(); // no phone yet
    await user.type(screen.getByLabelText('Phone number'), '+15551234567');
    expect(sendCode).toBeEnabled();
    await user.click(sendCode);
    await waitFor(() =>
      expect(notificationService.startPhoneVerification).toHaveBeenCalledWith('+15551234567')
    );

    // Enter + confirm the code.
    const codeInput = await screen.findByLabelText('Verification code');
    const verify = screen.getByRole('button', { name: 'Verify' });
    expect(verify).toBeDisabled(); // 6 digits required
    await user.type(codeInput, '123456');
    expect(verify).toBeEnabled();
    await user.click(verify);
    await waitFor(() =>
      expect(notificationService.confirmPhoneVerification).toHaveBeenCalledWith('123456')
    );

    // Verified badge appears, SMS becomes toggleable.
    expect(await screen.findByTestId('phone-verified-badge')).toHaveTextContent('Verified');
    expect(screen.getByRole('checkbox', { name: 'SMS notifications' })).toBeEnabled();
  });

  it('shows the verified badge straight away for an already-verified number', async () => {
    await renderSettings(prefs({ phone: '+15551234567', phoneVerified: true, sms: true }));
    expect(screen.getByTestId('phone-verified-badge')).toBeInTheDocument();
    const smsToggle = screen.getByRole('checkbox', { name: 'SMS notifications' });
    expect(smsToggle).toBeChecked();
    expect(smsToggle).toBeEnabled(); // can always turn OFF
  });

  it('explains unavailable SMS and hides phone verification controls', async () => {
    await renderSettings(prefs({ smsAvailable: false }));
    expect(screen.getByText('SMS reminders are temporarily unavailable.')).toBeInTheDocument();
    expect(screen.getByText(/SMS delivery is not enabled right now/u)).toBeInTheDocument();
    expect(screen.queryByLabelText('Phone number')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'SMS notifications' })).toBeDisabled();
  });

  it('does not submit an unsaved quiet-hours draft when an unrelated toggle is flipped', async () => {
    const user = userEvent.setup();
    const { notificationService } = await renderSettings(
      prefs({
        dndStart: '22:00',
        dndEnd: '07:00',
        timezone: 'America/New_York',
        // This user set quiet hours, which is the panel that persists a zone.
        // Without this the assertion below passed only because the vitest
        // config happens to pin TZ to America/New_York, so the adopted
        // browser zone coincided with the stored one.
        timezoneSet: true,
      })
    );
    vi.mocked(notificationService.updatePreferences).mockResolvedValue(
      prefs({
        dndStart: '22:00',
        dndEnd: '07:00',
        timezone: 'America/New_York',
        pestAlerts: true,
      })
    );

    // Start editing the quiet-hours Start field but never click "Save quiet hours".
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '23:15' } });
    expect(screen.getByLabelText('Start')).toHaveValue('23:15');

    // Toggle an unrelated setting instead.
    await user.click(screen.getByRole('checkbox', { name: 'Pest alerts' }));

    await waitFor(() => expect(notificationService.updatePreferences).toHaveBeenCalledOnce());
    expect(vi.mocked(notificationService.updatePreferences).mock.calls[0][0]).toMatchObject({
      dndStart: '22:00',
      dndEnd: '07:00',
      timezone: 'America/New_York',
      pestAlerts: true,
    });
  });

  it('persists the browser delivery preference when enabling reminders', async () => {
    const user = userEvent.setup();
    const { notificationService } = await renderSettings(prefs());
    const { requestPermission } = await import('@/utils/notifications');
    vi.mocked(requestPermission).mockImplementation(async () => {
      notificationApi.permission = 'granted';
      notificationApi.enabledLocally = true;
      return 'granted';
    });
    vi.mocked(notificationService.updatePreferences).mockResolvedValue(prefs({ browser: true }));

    await user.click(screen.getByRole('button', { name: 'Enable' }));

    await waitFor(() => expect(notificationService.updatePreferences).toHaveBeenCalledOnce());
    expect(vi.mocked(notificationService.updatePreferences).mock.calls[0][0]).toMatchObject({
      browser: true,
      email: true,
    });
    expect(
      await screen.findByText(/Browser reminders are enabled while the app is open/u)
    ).toBeInTheDocument();
  });

  it('does not enable browser delivery when the permission prompt is dismissed', async () => {
    const user = userEvent.setup();
    const { notificationService } = await renderSettings(prefs());
    const { requestPermission } = await import('@/utils/notifications');
    vi.mocked(requestPermission).mockResolvedValue('default');

    await user.click(screen.getByRole('button', { name: 'Enable' }));

    expect(await screen.findByText(/permission prompt was dismissed/i)).toBeInTheDocument();
    expect(notificationService.updatePreferences).not.toHaveBeenCalled();
  });

  it('refreshes browser permission when the user returns from site settings', async () => {
    notificationApi.permission = 'denied';
    notificationApi.enabledLocally = false;
    await renderSettings(prefs({ browser: true }));

    const deniedEnable = screen.getByRole('button', { name: 'Enable' });
    expect(deniedEnable).toBeDisabled();
    expect(
      screen.getByText(/Permission denied — update your browser settings/u)
    ).toBeInTheDocument();

    // The user changes the site permission outside the app, then focuses this
    // still-mounted page. It should become actionable without a full reload.
    notificationApi.permission = 'default';
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(deniedEnable).toBeEnabled());
    expect(
      screen.getByText('Enable to be alerted when overdue tasks appear in the dashboard.')
    ).toBeInTheDocument();

    // A restored grant plus the existing local/server opt-ins should likewise
    // restore the active state on visibility reconciliation.
    notificationApi.permission = 'granted';
    notificationApi.enabledLocally = true;
    fireEvent(document, new Event('visibilitychange'));
    expect(await screen.findByRole('button', { name: 'Turn off' })).toBeInTheDocument();
  });

  it('serializes browser and toggle writes and builds the queued write from fresh preferences', async () => {
    const user = userEvent.setup();
    const { notificationService } = await renderSettings(prefs());
    const { requestPermission } = await import('@/utils/notifications');
    vi.mocked(requestPermission).mockImplementation(async () => {
      notificationApi.permission = 'granted';
      notificationApi.enabledLocally = true;
      return 'granted';
    });

    let finishBrowserWrite!: (value: NotificationPreferences) => void;
    vi.mocked(notificationService.updatePreferences)
      .mockImplementationOnce(
        () =>
          new Promise<NotificationPreferences>((resolve) => {
            finishBrowserWrite = resolve;
          })
      )
      .mockImplementationOnce(async (payload) =>
        prefs({ ...payload, browser: true, email: false })
      );

    await user.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(notificationService.updatePreferences).toHaveBeenCalledTimes(1));

    // This control remains independently usable while browser setup is in
    // flight. The shared mutation scope queues it behind the browser write.
    await user.click(screen.getByRole('checkbox', { name: 'Email notifications' }));
    expect(notificationService.updatePreferences).toHaveBeenCalledTimes(1);

    finishBrowserWrite(prefs({ browser: true }));
    await waitFor(() => expect(notificationService.updatePreferences).toHaveBeenCalledTimes(2));
    expect(vi.mocked(notificationService.updatePreferences).mock.calls[1][0]).toMatchObject({
      browser: true,
      email: false,
    });
  });

  it('persists browser=false before reporting that reminders are disabled', async () => {
    notificationApi.permission = 'granted';
    notificationApi.enabledLocally = true;
    const user = userEvent.setup();
    const { notificationService } = await renderSettings(prefs({ browser: true }));
    const { disableLocally } = await import('@/utils/notifications');
    const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: vi.fn().mockResolvedValue({
          pushManager: {
            getSubscription: vi.fn().mockResolvedValue({
              endpoint: 'https://fcm.googleapis.com/fcm/send/current-device',
              unsubscribe: vi.fn().mockResolvedValue(true),
            }),
          },
        }),
      },
    });
    vi.mocked(notificationService.unsubscribe).mockResolvedValue({
      ok: true,
      remainingSubscriptions: 0,
    });
    vi.mocked(notificationService.updatePreferences).mockResolvedValue(prefs({ browser: false }));

    try {
      await user.click(screen.getByRole('button', { name: 'Turn off' }));

      await waitFor(() => expect(notificationService.updatePreferences).toHaveBeenCalledOnce());
      expect(vi.mocked(notificationService.updatePreferences).mock.calls[0][0]).toMatchObject({
        browser: false,
      });
      expect(disableLocally).toHaveBeenCalledOnce();
      expect(
        await screen.findByText('Browser notifications disabled on this device.')
      ).toBeInTheDocument();
    } finally {
      if (originalServiceWorker) {
        Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
      } else {
        delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
      }
    }
  });

  it('turns off only this browser while another subscription remains active', async () => {
    notificationApi.permission = 'granted';
    notificationApi.enabledLocally = true;
    const user = userEvent.setup();
    const { notificationService } = await renderSettings(prefs({ browser: true }));
    const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: vi.fn().mockResolvedValue({
          pushManager: {
            getSubscription: vi.fn().mockResolvedValue({
              endpoint: 'https://fcm.googleapis.com/fcm/send/current-device',
              unsubscribe: vi.fn().mockResolvedValue(true),
            }),
          },
        }),
      },
    });
    vi.mocked(notificationService.unsubscribe).mockResolvedValue({
      ok: true,
      remainingSubscriptions: 1,
    });

    try {
      await user.click(screen.getByRole('button', { name: 'Turn off' }));
      expect(
        await screen.findByText('Browser notifications disabled on this device.')
      ).toBeInTheDocument();
      expect(notificationService.updatePreferences).not.toHaveBeenCalled();
    } finally {
      if (originalServiceWorker) {
        Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
      } else {
        delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
      }
    }
  });

  it('does not claim notifications are disabled when the server cleanup failed', async () => {
    // Turning browser reminders off used to report success unconditionally.
    // When the teardown failed, this device kept a live push subscription and
    // the account-wide `browser` gate stayed open (correctly — it is shared
    // with the user's other devices), so background reminders kept arriving
    // at a device the user had just been told was silenced.
    notificationApi.permission = 'granted';
    notificationApi.enabledLocally = true;
    const user = userEvent.setup();
    const { notificationService } = await renderSettings(prefs({ browser: true }));
    const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: vi.fn().mockResolvedValue({
          pushManager: {
            getSubscription: vi.fn().mockResolvedValue({
              endpoint: 'https://fcm.googleapis.com/fcm/send/current-device',
              // The browser-side unsubscribe went through; the server never
              // heard about it, so the endpoint is still registered.
              unsubscribe: vi.fn().mockResolvedValue(true),
            }),
          },
        }),
      },
    });
    vi.mocked(notificationService.unsubscribe).mockRejectedValue(new Error('offline'));

    try {
      await user.click(screen.getByRole('button', { name: 'Turn off' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/couldn.t confirm that background push was turned off/u);
      expect(
        screen.queryByText('Browser notifications disabled on this device.')
      ).not.toBeInTheDocument();
    } finally {
      if (originalServiceWorker) {
        Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
      } else {
        delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
      }
    }
  });

  it('does not claim notifications are disabled when the browser refused to unsubscribe', async () => {
    notificationApi.permission = 'granted';
    notificationApi.enabledLocally = true;
    const user = userEvent.setup();
    const { notificationService } = await renderSettings(prefs({ browser: true }));
    const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: vi.fn().mockResolvedValue({
          pushManager: {
            getSubscription: vi.fn().mockResolvedValue({
              endpoint: 'https://fcm.googleapis.com/fcm/send/current-device',
              // `PushSubscription.unsubscribe()` resolving false means it did
              // NOT unsubscribe. The result used to be discarded entirely.
              unsubscribe: vi.fn().mockResolvedValue(false),
            }),
          },
        }),
      },
    });
    vi.mocked(notificationService.unsubscribe).mockResolvedValue({
      ok: true,
      remainingSubscriptions: 0,
    });

    try {
      await user.click(screen.getByRole('button', { name: 'Turn off' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/couldn.t confirm that background push was turned off/u);
    } finally {
      if (originalServiceWorker) {
        Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
      } else {
        delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
      }
    }
  });

  it('a device that never had a push subscription still reports a clean disable', async () => {
    notificationApi.permission = 'granted';
    notificationApi.enabledLocally = true;
    const user = userEvent.setup();
    const { notificationService } = await renderSettings(prefs({ browser: true }));
    const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: vi.fn().mockResolvedValue({
          pushManager: { getSubscription: vi.fn().mockResolvedValue(null) },
        }),
      },
    });

    try {
      await user.click(screen.getByRole('button', { name: 'Turn off' }));

      expect(
        await screen.findByText('Browser notifications disabled on this device.')
      ).toBeInTheDocument();
      expect(notificationService.unsubscribe).not.toHaveBeenCalled();
    } finally {
      if (originalServiceWorker) {
        Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
      } else {
        delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
      }
    }
  });

  it('keeps email and SMS settings available when this browser lacks Notification API support', async () => {
    notificationApi.supported = false;
    notificationApi.permission = 'unsupported';

    await renderSettings(prefs());

    expect(
      screen.getByText(/Browser reminders are not supported on this device/u)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Email notifications' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'SMS notifications' })).toBeInTheDocument();
  });

  it('shows a recoverable error instead of spinning forever when preferences fail to load', async () => {
    const user = userEvent.setup();
    const { notificationService } = await import('@/services/notificationService');
    vi.mocked(notificationService.getPreferences).mockRejectedValueOnce(new Error('Network down'));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <NotificationSettings />
      </QueryClientProvider>
    );

    expect(await screen.findByText('Network down')).toBeInTheDocument();
    vi.mocked(notificationService.getPreferences).mockResolvedValueOnce(prefs());
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByRole('checkbox', { name: 'Weekly plant digest' })
    ).toBeInTheDocument();
  });

  it('hides the nonfunctional device-push control in native shells', async () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
    try {
      await renderSettings(prefs());
      expect(screen.queryByText('Browser')).not.toBeInTheDocument();
      expect(screen.queryByText('This device')).not.toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Email notifications' })).toBeInTheDocument();
    } finally {
      delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    }
  });
});
