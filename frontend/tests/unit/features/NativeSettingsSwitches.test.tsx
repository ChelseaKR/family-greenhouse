import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationSettings } from '@/features/settings/NotificationSettings';
import { PreferencesSettings } from '@/features/settings/PreferencesSettings';
import type { NotificationPreferences } from '@/services/notificationService';
import { ANALYTICS_OPT_OUT_STORAGE_KEY, analyticsOptOutStored } from '@/services/analytics';

/**
 * The true on/off settings drawn as iOS switches inside the app's native
 * frame. They are privacy and consent controls (email, SMS, the digests,
 * product analytics), so the proof is behavioral: the same click writes
 * exactly the same value inside the app as on the website. Only the role
 * (and index.css's drawing of it) changes.
 */

vi.mock('@/services/notificationService', async (importOriginal) => ({
  buildPreferencesUpdate: (await importOriginal<typeof import('@/services/notificationService')>())
    .buildPreferencesUpdate,
  notificationService: {
    getPreferences: vi.fn(),
    updatePreferences: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    runReminders: vi.fn(),
    startPhoneVerification: vi.fn(),
    confirmPhoneVerification: vi.fn(),
    clearEmailSuppression: vi.fn(),
  },
}));
vi.mock('@/utils/notifications', () => ({
  isSupported: () => false,
  isEnabledLocally: () => false,
  disableLocally: vi.fn(),
  getPermission: () => 'unsupported',
  requestPermission: vi.fn(),
}));
vi.mock('@/hooks/useActiveHouseholdId', () => ({ useActiveHouseholdId: () => 'hh-1' }));
vi.mock('@/services/nativePush', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/nativePush')>()),
  getNativePushPermission: vi.fn(async () => 'prompt'),
  isNativePushEnabled: () => false,
  registerNativePush: vi.fn(),
}));

function prefs(over: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return {
    userId: 'u-1',
    browser: false,
    email: true,
    sms: false,
    smsAvailable: true,
    phone: '+15551234567',
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
    emailLocale: 'en',
    phoneVerified: true,
    updatedAt: '',
    ...over,
  };
}

/** Every true on/off setting on the Notifications page, by its accessible name. */
const NOTIFICATION_SWITCHES = [
  'Email notifications',
  'Weekly plant digest',
  'Someone joins or leaves the household',
  'A task is up for grabs',
  "You're covering for someone",
  'Someone covered for you',
  'Year in review',
  'SMS notifications',
  'Pest alerts',
];

function inTheApp(framed: boolean) {
  if (!framed) {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    return;
  }
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
    PluginHeaders: [{ name: 'NativeChrome', methods: [] }],
  };
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

async function renderNotifications() {
  const { notificationService } = await import('@/services/notificationService');
  vi.mocked(notificationService.getPreferences).mockResolvedValue(prefs());
  vi.mocked(notificationService.updatePreferences).mockImplementation(async (body) =>
    prefs(body as Partial<NotificationPreferences>)
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <NotificationSettings />
    </QueryClientProvider>
  );
  await screen.findByLabelText('Weekly plant digest');
  return notificationService;
}

/** Click one setting from a fresh page; return what was sent to the server. */
async function clickAndCapture(framed: boolean, name: string): Promise<unknown> {
  vi.clearAllMocks();
  inTheApp(framed);
  const service = await renderNotifications();
  const control = screen.getByLabelText(name);
  await userEvent.click(control);
  await waitFor(() => expect(service.updatePreferences).toHaveBeenCalledOnce());
  const body = vi.mocked(service.updatePreferences).mock.calls[0][0];
  cleanup();
  return body;
}

describe('notification switches in the iOS app', () => {
  // The server's zone is UTC; a different browser zone would add a
  // background time-zone write to every render (NotificationSettings.test.tsx).
  beforeEach(() => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      timeZone: 'UTC',
    } as unknown as Intl.ResolvedDateTimeFormatOptions);
  });
  afterEach(() => vi.restoreAllMocks());

  it('are switches in the app, and plain checkboxes on the website', async () => {
    inTheApp(true);
    await renderNotifications();
    for (const name of NOTIFICATION_SWITCHES) {
      const control = screen.getByLabelText(name);
      expect(control, name).toHaveAttribute('role', 'switch');
      expect(control, name).toHaveAttribute('type', 'checkbox');
      expect(screen.getByRole('switch', { name }), name).toBe(control);
    }
    cleanup();

    inTheApp(false);
    await renderNotifications();
    for (const name of NOTIFICATION_SWITCHES) {
      expect(screen.getByLabelText(name), name).not.toHaveAttribute('role');
      expect(screen.getByRole('checkbox', { name }), name).toBeInTheDocument();
    }
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
  });

  it.each(NOTIFICATION_SWITCHES)('"%s" sends exactly what the website sends', async (name) => {
    const web = await clickAndCapture(false, name);
    const app = await clickAndCapture(true, name);
    expect(web).toBeTruthy();
    expect(app).toEqual(web);
  });

  it('only true on/off settings become switches (the email language stays a picker)', async () => {
    inTheApp(true);
    await renderNotifications();
    expect(screen.getAllByRole('switch')).toHaveLength(NOTIFICATION_SWITCHES.length);
    expect(screen.getByLabelText('Email language').tagName).toBe('SELECT');
  });
});

describe('the product analytics opt-out in the iOS app', () => {
  beforeEach(() => {
    localStorage.removeItem(ANALYTICS_OPT_OUT_STORAGE_KEY);
    Object.defineProperty(globalThis.navigator, 'doNotTrack', { value: null, configurable: true });
  });
  afterEach(() => localStorage.removeItem(ANALYTICS_OPT_OUT_STORAGE_KEY));

  async function flip(framed: boolean) {
    inTheApp(framed);
    render(
      <MemoryRouter>
        <PreferencesSettings />
      </MemoryRouter>
    );
    const control = screen.getByLabelText(/share usage events/i);
    const before = { checked: (control as HTMLInputElement).checked };
    await userEvent.click(control);
    const off = {
      role: control.getAttribute('role'),
      checked: (control as HTMLInputElement).checked,
      stored: localStorage.getItem(ANALYTICS_OPT_OUT_STORAGE_KEY),
      optedOut: analyticsOptOutStored(),
    };
    await userEvent.click(control);
    const on = {
      checked: (control as HTMLInputElement).checked,
      stored: localStorage.getItem(ANALYTICS_OPT_OUT_STORAGE_KEY),
      optedOut: analyticsOptOutStored(),
    };
    cleanup();
    localStorage.removeItem(ANALYTICS_OPT_OUT_STORAGE_KEY);
    return { before, off, on };
  }

  it('is a switch in the app and writes the same opt-out, both ways, as the website', async () => {
    const web = await flip(false);
    const app = await flip(true);
    expect(web.off.role).toBeNull();
    expect(app.off.role).toBe('switch');
    expect(app.before).toEqual(web.before);
    expect({ ...app.off, role: null }).toEqual(web.off);
    expect(app.on).toEqual(web.on);
    // And what that is: off stores the opt-out, on clears it.
    expect(web.off.optedOut).toBe(true);
    expect(web.on.optedOut).toBe(false);
  });
});
