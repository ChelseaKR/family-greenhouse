import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { act, cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
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
    pestAlerts: false,
    weeklyDigest: true,
    memberJoined: true,
    taskUpForGrabs: true,
    coverageUpdates: true,
    careCredit: true,
    phoneVerified: false,
    updatedAt: '',
    ...over,
  };
}

/** Unmount + reset mocks between repeated renders inside one case. */
function cleanupRender() {
  cleanup();
  vi.clearAllMocks();
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

/**
 * Pin the zone this "browser" reports so the suite is deterministic on any
 * machine. 'UTC' matches the server default, so the pre-existing cases see no
 * background timezone write; the quiet-hours cases below override it.
 */
let resolvedOptionsSpy: MockInstance<() => Intl.ResolvedDateTimeFormatOptions>;
function stubBrowserTimeZone(timeZone: string | undefined) {
  resolvedOptionsSpy.mockReturnValue({ timeZone } as unknown as Intl.ResolvedDateTimeFormatOptions);
}

describe('NotificationSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    notificationApi.supported = true;
    notificationApi.enabledLocally = false;
    notificationApi.permission = 'default';
    resolvedOptionsSpy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions');
    stubBrowserTimeZone('UTC');
  });

  afterEach(() => {
    resolvedOptionsSpy.mockRestore();
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
      prefs({ dndStart: '22:00', dndEnd: '07:00', timezone: 'America/New_York' })
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

  describe('quiet-hours timezone default', () => {
    // GET /notifications/prefs answers timezone 'UTC' for a user who has never
    // chosen one, and the reminder run evaluates quiet hours in that zone. So
    // "22:00–07:00" saved by a user who never touched the Timezone field was
    // silently a UTC window. The stored value must be right before Save.

    it('persists the browser timezone on first load while the server still holds the UTC default', async () => {
      stubBrowserTimeZone('America/Chicago');
      const { notificationService } = await import('@/services/notificationService');
      vi.mocked(notificationService.updatePreferences).mockResolvedValue(
        prefs({ timezone: 'America/Chicago' })
      );

      await renderSettings(prefs());

      await waitFor(() => expect(notificationService.updatePreferences).toHaveBeenCalledOnce());
      // Same write path as Save, built from the persisted record: the zone is
      // the only thing that changes and no quiet-hours values are invented.
      expect(vi.mocked(notificationService.updatePreferences).mock.calls[0][0]).toEqual({
        browser: false,
        email: true,
        sms: false,
        phone: '',
        dndStart: '',
        dndEnd: '',
        timezone: 'America/Chicago',
        pestAlerts: false,
        weeklyDigest: true,
        memberJoined: true,
        taskUpForGrabs: true,
        coverageUpdates: true,
        careCredit: true,
      });
      await waitFor(() => expect(screen.getByLabelText('Timezone')).toHaveValue('America/Chicago'));
      // A write the user did not ask for shows no "saved" banner.
      expect(screen.queryByText('Preferences saved.')).not.toBeInTheDocument();
    });

    it('evaluates quiet hours saved without touching the Timezone field in the browser zone', async () => {
      stubBrowserTimeZone('America/Chicago');
      const user = userEvent.setup();
      const { notificationService } = await import('@/services/notificationService');
      vi.mocked(notificationService.updatePreferences).mockImplementation(async (payload) =>
        prefs(payload)
      );

      await renderSettings(prefs());
      await waitFor(() => expect(notificationService.updatePreferences).toHaveBeenCalledOnce());
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Save quiet hours' })).toBeEnabled()
      );

      fireEvent.change(screen.getByLabelText('Start'), { target: { value: '22:00' } });
      fireEvent.change(screen.getByLabelText('End'), { target: { value: '07:00' } });
      await user.click(screen.getByRole('button', { name: 'Save quiet hours' }));

      await waitFor(() => expect(notificationService.updatePreferences).toHaveBeenCalledTimes(2));
      expect(vi.mocked(notificationService.updatePreferences).mock.calls[1][0]).toMatchObject({
        dndStart: '22:00',
        dndEnd: '07:00',
        timezone: 'America/Chicago',
      });
      expect(await screen.findByText('Preferences saved.')).toBeInTheDocument();
    });

    it('leaves an explicitly saved timezone alone even when the browser disagrees', async () => {
      stubBrowserTimeZone('America/Chicago');
      const { notificationService } = await renderSettings(prefs({ timezone: 'Europe/Berlin' }));

      expect(screen.getByLabelText('Timezone')).toHaveValue('Europe/Berlin');
      expect(notificationService.updatePreferences).not.toHaveBeenCalled();
    });

    it('writes nothing when the browser zone is UTC or an alias of it', async () => {
      for (const zone of ['UTC', 'Etc/UTC']) {
        stubBrowserTimeZone(zone);
        const { notificationService } = await renderSettings(prefs());

        expect(screen.getByLabelText('Timezone')).toHaveValue('UTC');
        expect(notificationService.updatePreferences).not.toHaveBeenCalled();
        cleanupRender();
      }
    });

    it('falls back to the stored zone, without a write, when the browser cannot resolve one', async () => {
      // Runtime that throws.
      resolvedOptionsSpy.mockImplementation(() => {
        throw new RangeError('time zone unavailable');
      });
      let rendered = await renderSettings(prefs());
      expect(screen.getByLabelText('Timezone')).toHaveValue('UTC');
      expect(rendered.notificationService.updatePreferences).not.toHaveBeenCalled();
      cleanupRender();

      // Runtime that answers with no zone at all.
      stubBrowserTimeZone(undefined);
      rendered = await renderSettings(prefs());
      expect(screen.getByLabelText('Timezone')).toHaveValue('UTC');
      expect(rendered.notificationService.updatePreferences).not.toHaveBeenCalled();
    });

    it('surfaces a rejected default write and keeps the browser zone in the field', async () => {
      // The server validates IANA names against its own ICU data, which can
      // lag the browser's. Hiding that rejection would let a later Save fall
      // back to UTC silently; showing it and keeping the draft means Save
      // re-sends the same zone and gets the same, visible answer.
      stubBrowserTimeZone('America/Chicago');
      const { notificationService } = await import('@/services/notificationService');
      vi.mocked(notificationService.updatePreferences).mockRejectedValue(
        new Error('Unknown timezone: America/Chicago')
      );

      await renderSettings(prefs());

      expect(await screen.findByText('Unknown timezone: America/Chicago')).toBeInTheDocument();
      expect(screen.getByLabelText('Timezone')).toHaveValue('America/Chicago');
    });

    it('defaults at most once per mount and respects a deliberate choice of UTC', async () => {
      stubBrowserTimeZone('America/Chicago');
      const user = userEvent.setup();
      const { notificationService } = await import('@/services/notificationService');
      vi.mocked(notificationService.updatePreferences).mockImplementation(async (payload) =>
        prefs(payload)
      );

      await renderSettings(prefs());
      await waitFor(() => expect(notificationService.updatePreferences).toHaveBeenCalledOnce());
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Save quiet hours' })).toBeEnabled()
      );

      // The user genuinely wants UTC: the server now answers 'UTC' again, and
      // the page must not treat that as "unset" and write the browser zone back.
      await user.clear(screen.getByLabelText('Timezone'));
      await user.type(screen.getByLabelText('Timezone'), 'UTC');
      await user.click(screen.getByRole('button', { name: 'Save quiet hours' }));
      await waitFor(() => expect(notificationService.updatePreferences).toHaveBeenCalledTimes(2));
      expect(vi.mocked(notificationService.updatePreferences).mock.calls[1][0]).toMatchObject({
        timezone: 'UTC',
      });

      // Let any stray follow-up write surface before asserting there is none.
      await act(async () => {
        await Promise.resolve();
      });
      expect(notificationService.updatePreferences).toHaveBeenCalledTimes(2);
      expect(screen.getByLabelText('Timezone')).toHaveValue('UTC');
    });

    it('does not wipe a quiet-hours edit in progress when the background write returns', async () => {
      stubBrowserTimeZone('America/Chicago');
      const { notificationService } = await import('@/services/notificationService');
      let finishDefaultWrite!: (value: NotificationPreferences) => void;
      vi.mocked(notificationService.updatePreferences).mockImplementationOnce(
        () =>
          new Promise<NotificationPreferences>((resolve) => {
            finishDefaultWrite = resolve;
          })
      );

      await renderSettings(prefs());
      await waitFor(() => expect(notificationService.updatePreferences).toHaveBeenCalledOnce());

      // The user starts on quiet hours while the timezone write is in flight.
      fireEvent.change(screen.getByLabelText('Start'), { target: { value: '23:15' } });
      expect(screen.getByLabelText('Start')).toHaveValue('23:15');

      await act(async () => {
        finishDefaultWrite(prefs({ timezone: 'America/Chicago' }));
        await Promise.resolve();
      });

      // The response changed only the zone; the unchanged dndStart must not
      // clobber what the user is typing.
      expect(screen.getByLabelText('Start')).toHaveValue('23:15');
      await waitFor(() => expect(screen.getByLabelText('Timezone')).toHaveValue('America/Chicago'));
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

  it('offers a separate switch for each household email', async () => {
    await renderSettings(prefs());
    for (const label of [
      'Someone joins the household',
      'A task is up for grabs',
      "You're covering for someone",
      'Someone covered for you',
    ]) {
      const toggle = screen.getByRole('checkbox', { name: label });
      expect(toggle).toBeChecked();
      expect(toggle).toBeEnabled();
    }
  });

  it('turns one household email off without touching the others', async () => {
    const user = userEvent.setup();
    const { notificationService } = await renderSettings(prefs());
    vi.mocked(notificationService.updatePreferences).mockResolvedValue(
      prefs({ taskUpForGrabs: false })
    );

    await user.click(screen.getByRole('checkbox', { name: 'A task is up for grabs' }));

    await waitFor(() => expect(notificationService.updatePreferences).toHaveBeenCalledOnce());
    expect(vi.mocked(notificationService.updatePreferences).mock.calls[0][0]).toMatchObject({
      taskUpForGrabs: false,
      memberJoined: true,
      coverageUpdates: true,
      careCredit: true,
      weeklyDigest: true,
    });
  });

  it('disables every household email switch when the email channel is off', async () => {
    await renderSettings(prefs({ email: false }));
    expect(screen.getByRole('checkbox', { name: 'Someone covered for you' })).toBeDisabled();
    expect(
      screen.getByText('Turn on email notifications to receive household emails.')
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
