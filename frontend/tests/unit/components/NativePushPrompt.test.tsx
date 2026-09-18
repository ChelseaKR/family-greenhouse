/**
 * The native push opt-in: where it appears, and the one thing it must never
 * do, which is ask the OS for permission before the person taps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NativePushPrompt } from '@/components/NativePushPrompt';
import type { NotificationPreferences } from '@/services/notificationService';

const push = vi.hoisted(() => ({
  permission: 'prompt' as 'prompt' | 'granted' | 'denied',
  enabled: false,
  registerNativePush: vi.fn(),
  unregisterNativePush: vi.fn(),
}));

vi.mock('@/services/nativePush', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/nativePush')>()),
  getNativePushPermission: vi.fn(async () => push.permission),
  isNativePushEnabled: () => push.enabled,
  registerNativePush: push.registerNativePush,
  unregisterNativePush: push.unregisterNativePush,
}));

vi.mock('@/services/notificationService', async (importOriginal) => ({
  buildPreferencesUpdate: (await importOriginal<typeof import('@/services/notificationService')>())
    .buildPreferencesUpdate,
  notificationService: { getPreferences: vi.fn(), updatePreferences: vi.fn() },
}));

vi.mock('@/hooks/useActiveHouseholdId', () => ({ useActiveHouseholdId: () => 'hh-1' }));

import { notificationService } from '@/services/notificationService';

function prefs(devicePush: { ios: boolean; android: boolean }): NotificationPreferences {
  return {
    userId: 'u-1',
    browser: false,
    email: true,
    sms: false,
    smsAvailable: false,
    devicePush,
    phone: '',
    dndStart: '',
    dndEnd: '',
    timezone: 'America/Los_Angeles',
    pestAlerts: false,
    weeklyDigest: true,
    memberJoined: true,
    taskUpForGrabs: true,
    coverageUpdates: true,
    careCredit: true,
    yearRecap: true,
    emailLocale: 'en',
    phoneVerified: false,
    updatedAt: '',
  };
}

function renderPrompt(hasUpcomingCare = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NativePushPrompt hasUpcomingCare={hasUpcomingCare} />
    </QueryClientProvider>
  );
}

describe('NativePushPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    push.permission = 'prompt';
    push.enabled = false;
    vi.stubEnv('VITE_NATIVE_PUSH_ENABLED', 'true');
    (window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
    vi.mocked(notificationService.getPreferences).mockResolvedValue(
      prefs({ ios: true, android: true })
    );
    vi.mocked(notificationService.updatePreferences).mockImplementation(
      async (update) => ({ ...prefs({ ios: true, android: true }), ...update }) as never
    );
    push.registerNativePush.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  it('asks for nothing until "Turn on notifications" is tapped, then turns reminders on', async () => {
    const user = userEvent.setup();
    renderPrompt();

    const button = await screen.findByRole('button', { name: 'Turn on notifications' });
    expect(push.registerNativePush).not.toHaveBeenCalled();

    await user.click(button);

    await waitFor(() => expect(push.registerNativePush).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(notificationService.updatePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ browser: true, email: true })
      )
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Turn on notifications' })).toBeNull()
    );
  });

  it('shows nothing while the deployment switch is off', async () => {
    vi.mocked(notificationService.getPreferences).mockResolvedValue(
      prefs({ ios: false, android: false })
    );
    renderPrompt();
    await waitFor(() => expect(notificationService.getPreferences).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Turn on notifications' })).toBeNull();
  });

  it('shows nothing in a build without push, on the website, or with no care on the list', async () => {
    vi.stubEnv('VITE_NATIVE_PUSH_ENABLED', 'false');
    const { unmount } = renderPrompt();
    await waitFor(() => expect(notificationService.getPreferences).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Turn on notifications' })).toBeNull();
    unmount();

    vi.stubEnv('VITE_NATIVE_PUSH_ENABLED', 'true');
    renderPrompt(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('button', { name: 'Turn on notifications' })).toBeNull();
  });

  it('never asks again once the OS said no, and "Not now" holds', async () => {
    push.permission = 'denied';
    const { unmount } = renderPrompt();
    await waitFor(() => expect(notificationService.getPreferences).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('button', { name: 'Turn on notifications' })).toBeNull();
    unmount();

    push.permission = 'prompt';
    const user = userEvent.setup();
    const second = renderPrompt();
    await user.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('button', { name: 'Turn on notifications' })).toBeNull();
    second.unmount();

    renderPrompt();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('button', { name: 'Turn on notifications' })).toBeNull();
    expect(push.registerNativePush).not.toHaveBeenCalled();
  });
});
