import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const { getPreferences, updatePreferences, resolveBrowserTimeZone } = vi.hoisted(() => ({
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
  resolveBrowserTimeZone: vi.fn<() => string | null>(),
}));
vi.mock('@/services/notificationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/notificationService')>();
  return {
    ...actual,
    notificationService: { ...actual.notificationService, getPreferences, updatePreferences },
  };
});

vi.mock('@/utils/timeZone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/timeZone')>();
  return { ...actual, resolveBrowserTimeZone: () => resolveBrowserTimeZone() };
});

import { useAuthStore } from '@/store/authStore';
import {
  __resetDetectedTimeZoneForTests,
  isTimeZoneUnset,
  useDetectedTimeZone,
} from '@/hooks/useDetectedTimeZone';
import type { NotificationPreferences } from '@/services/notificationService';

function prefs(overrides: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return {
    userId: 'u1',
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
    yearRecap: true,
    emailLocale: '',
    phoneVerified: false,
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, ...renderHook(() => useDetectedTimeZone(), { wrapper }) };
}

/** Let the hook's async work settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('useDetectedTimeZone', () => {
  beforeEach(() => {
    __resetDetectedTimeZoneForTests();
    getPreferences.mockReset();
    updatePreferences.mockReset();
    resolveBrowserTimeZone.mockReset().mockReturnValue('America/New_York');
    useAuthStore.setState({
      user: {
        id: 'u1',
        email: 'a@example.com',
        name: 'A',
        householdId: 'hh1',
        householdRole: 'admin',
      },
      activeHouseholdId: null,
    });
  });

  afterEach(() => {
    useAuthStore.setState({ user: null, activeHouseholdId: null });
  });

  it("is the ORIGINAL bug's fix: saves the browser zone when the stored one is the UTC default", async () => {
    getPreferences.mockResolvedValue(prefs());
    updatePreferences.mockResolvedValue(prefs({ timezone: 'America/New_York' }));
    const { queryClient } = mount();

    await waitFor(() => expect(updatePreferences).toHaveBeenCalledTimes(1));
    expect(updatePreferences.mock.calls[0][0]).toMatchObject({
      timezone: 'America/New_York',
      timezoneSource: 'detected',
      // Everything else is the stored record, unchanged.
      email: true,
      dndStart: '',
    });
    await waitFor(() =>
      expect(
        queryClient.getQueryData<NotificationPreferences>(['notification-prefs', 'hh1'])?.timezone
      ).toBe('America/New_York')
    );
  });

  it('never overwrites a zone the member chose, UTC included', async () => {
    getPreferences.mockResolvedValue(prefs({ timezone: 'UTC', timezoneChosen: true }));
    mount();
    await waitFor(() => expect(getPreferences).toHaveBeenCalled());
    await flush();
    expect(updatePreferences).not.toHaveBeenCalled();
  });

  it('leaves an already-set zone alone', async () => {
    getPreferences.mockResolvedValue(prefs({ timezone: 'Europe/Berlin' }));
    mount();
    await waitFor(() => expect(getPreferences).toHaveBeenCalled());
    await flush();
    expect(updatePreferences).not.toHaveBeenCalled();
  });

  it('sends nothing when the browser cannot name its zone or reports UTC', async () => {
    for (const zone of [null, 'UTC', 'Etc/UTC']) {
      __resetDetectedTimeZoneForTests();
      resolveBrowserTimeZone.mockReturnValue(zone);
      const { unmount } = mount();
      await flush();
      unmount();
    }
    expect(getPreferences).not.toHaveBeenCalled();
    expect(updatePreferences).not.toHaveBeenCalled();
  });

  it('does nothing while signed out', async () => {
    useAuthStore.setState({ user: null, activeHouseholdId: null });
    mount();
    await flush();
    expect(getPreferences).not.toHaveBeenCalled();
  });

  it('tries once per page load, even across remounts or a failed request', async () => {
    getPreferences.mockRejectedValue(new Error('offline'));
    const first = mount();
    await waitFor(() => expect(getPreferences).toHaveBeenCalledTimes(1));
    first.unmount();
    mount();
    await flush();
    expect(getPreferences).toHaveBeenCalledTimes(1);
    expect(updatePreferences).not.toHaveBeenCalled();
  });

  it('reads a missing timezoneChosen (older server) as not chosen', () => {
    expect(isTimeZoneUnset({ timezone: 'UTC' })).toBe(true);
    expect(isTimeZoneUnset({ timezone: '' })).toBe(true);
    expect(isTimeZoneUnset({ timezone: 'UTC', timezoneChosen: true })).toBe(false);
    expect(isTimeZoneUnset({ timezone: 'America/Denver' })).toBe(false);
  });
});
