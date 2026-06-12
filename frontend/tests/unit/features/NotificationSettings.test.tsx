import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationSettings } from '@/features/settings/NotificationSettings';
import type { NotificationPreferences } from '@/services/notificationService';

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
  isSupported: () => true,
  isEnabledLocally: () => false,
  disableLocally: vi.fn(),
  getPermission: () => 'default' as const,
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
    phone: '',
    dndStart: '',
    dndEnd: '',
    timezone: 'UTC',
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
});
