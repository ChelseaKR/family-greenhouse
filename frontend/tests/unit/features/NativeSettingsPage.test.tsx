import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import i18n from '@/i18n';
import { ensureLanguageCatalog } from '@/i18n';
import { SettingsPage } from '@/features/settings/SettingsPage';
import {
  NATIVE_SETTINGS_SECTIONS,
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_LABEL,
  settingsSectionPath,
} from '@/features/settings/settingsSections';

/**
 * Settings inside the iOS app's native frame: a native list of sections
 * (More -> Settings, NativeFrameController) whose rows each open one section
 * page. Here, the web half: every row's route lands on its own section, the
 * page is titled with that section (the navigation bar takes the title from
 * the h1), and the web's own section picker and tabs are not drawn. The
 * website keeps its page exactly as it was.
 *
 * Panels are stubbed with markers; About and Plan status are the real ones
 * where the test needs them (#903's About with the memorial line).
 */

vi.mock('@/features/settings/BillingSettings', () => ({
  BillingSettings: () => <div data-testid="panel-billing" />,
}));
vi.mock('@/features/settings/NotificationSettings', () => ({
  NotificationSettings: () => <div data-testid="panel-notifications" />,
}));
vi.mock('@/features/settings/PreferencesSettings', () => ({
  PreferencesSettings: () => <div data-testid="panel-preferences" />,
}));
vi.mock('@/features/settings/ApiKeysSettings', () => ({
  ApiKeysSettings: () => <div data-testid="panel-api-keys" />,
}));
vi.mock('@/features/settings/KioskSettings', () => ({
  KioskSettings: () => <div data-testid="panel-kiosk" />,
}));
vi.mock('@/features/settings/HouseholdChannelSettings', () => ({
  HouseholdChannelSettings: () => <div />,
}));
vi.mock('@/features/settings/AccountSettings', () => ({
  AccountSettings: () => <div data-testid="panel-account" />,
}));
vi.mock('@/features/settings/TrashSettings', () => ({
  TrashSettings: () => <div data-testid="panel-trash" />,
}));
vi.mock('@/features/settings/SecuritySettings', () => ({
  SecuritySettings: () => <div data-testid="panel-security" />,
}));
vi.mock('@/features/settings/ReferralSettings', () => ({
  ReferralSettings: () => <div data-testid="panel-refer" />,
}));
vi.mock('@/features/tags/TagPinSettings', () => ({
  TagPinSettings: () => <div data-testid="panel-plant-tags" />,
}));

const MEMORIAL = 'In loving memory of my mom, Joyce — who taught us to keep growing.';
const MEMORIAL_ES = 'En cariñosa memoria de mi mamá, Joyce, quien nos enseñó a seguir creciendo.';

function inTheFrame() {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
    PluginHeaders: [{ name: 'NativeChrome', methods: [] }],
  };
}

afterEach(async () => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  await i18n.changeLanguage('en');
});

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <SettingsPage />
    </MemoryRouter>
  );
}

describe('Settings in the iOS app', () => {
  it.each(NATIVE_SETTINGS_SECTIONS.map((s) => [s]))(
    'the %s row lands on its own section, titled with its name',
    (section) => {
      inTheFrame();
      renderAt(settingsSectionPath(section));
      const h1 = screen.getByRole('heading', { level: 1 });
      expect(h1).toHaveTextContent(i18n.t(SETTINGS_SECTION_LABEL[section]));
      if (section === 'about') expect(screen.getByText(MEMORIAL)).toBeInTheDocument();
      else expect(screen.getByTestId(`panel-${section}`)).toBeInTheDocument();
    }
  );

  it('draws no section picker and no web eyebrow or description', () => {
    inTheFrame();
    renderAt('/settings?section=notifications');
    // Present for the website's sake, hidden by `native-frame:hidden`.
    expect(screen.getByRole('combobox').closest('label')).toHaveClass('native-frame:hidden');
    expect(screen.getByRole('tablist').closest('div.border-b')).toHaveClass('native-frame:hidden');
    expect(screen.queryByText('Your account')).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t('settings.description'))).not.toBeInTheDocument();
  });

  it('About keeps the memorial line, once, and in Spanish in Spanish', async () => {
    inTheFrame();
    await ensureLanguageCatalog('es');
    await i18n.changeLanguage('es');
    renderAt('/settings?section=about');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Acerca de');
    expect(screen.getAllByText(MEMORIAL_ES)).toHaveLength(1);
    expect(screen.queryByText(MEMORIAL)).not.toBeInTheDocument();
  });
});

describe('Settings on the website (unchanged)', () => {
  it('keeps its title, eyebrow, picker and tabs, and no About', () => {
    renderAt('/settings?section=notifications');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Settings');
    expect(screen.getByText('Your account')).toBeInTheDocument();
    expect(screen.getByRole('combobox').closest('label')).toHaveClass('native-frame:hidden');
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(SETTINGS_SECTIONS.map((s) => i18n.t(SETTINGS_SECTION_LABEL[s])));
    expect(screen.getByTestId('panel-notifications')).toBeInTheDocument();
  });
});
