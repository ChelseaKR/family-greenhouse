/**
 * `billing_opened` — the upgrade funnel's "opened billing" stage
 * (docs/analytics.md). It fires from the settings page, keyed on the resolved
 * tab, so a deep link to /settings/billing counts the same as choosing the
 * tab, and it fires for the billing tab only.
 *
 * Every settings panel is stubbed: this test is about the page-level event,
 * and the real BillingSettings needs a query client, a household and a plan
 * catalog it would otherwise have to be given.
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { track } from '@/services/analytics';
import { SettingsPage } from '@/features/settings/SettingsPage';

vi.mock('@/services/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/analytics')>();
  return { ...actual, track: vi.fn() };
});
vi.mock('@/features/settings/BillingSettings', () => ({
  BillingSettings: () => <div data-testid="billing-panel" />,
}));
vi.mock('@/features/settings/NotificationSettings', () => ({
  NotificationSettings: () => <div />,
}));
vi.mock('@/features/settings/PreferencesSettings', () => ({
  PreferencesSettings: () => <div />,
}));
vi.mock('@/features/settings/ApiKeysSettings', () => ({ ApiKeysSettings: () => <div /> }));
vi.mock('@/features/settings/KioskSettings', () => ({ KioskSettings: () => <div /> }));
vi.mock('@/features/settings/AccountSettings', () => ({ AccountSettings: () => <div /> }));
vi.mock('@/features/tags/TagPinSettings', () => ({ TagPinSettings: () => <div /> }));

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <SettingsPage />
    </MemoryRouter>
  );
}

describe('SettingsPage: billing_opened', () => {
  it('fires once when the billing tab is the resolved route', () => {
    vi.mocked(track).mockClear();
    const { getByTestId } = renderAt('/settings/billing');

    expect(getByTestId('billing-panel')).toBeInTheDocument();
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('billing_opened');
  });

  it('does not fire for any other settings tab', () => {
    vi.mocked(track).mockClear();
    renderAt('/settings');
    renderAt('/settings?section=account');
    renderAt('/settings?section=notifications');

    expect(track).not.toHaveBeenCalled();
  });
});
