import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n, { ensureLanguageCatalog } from '@/i18n';
import { AboutSettings } from '@/features/settings/AboutSettings';

/**
 * Settings → About (ADR 0036): the "Rate Family Greenhouse" row is in the
 * apps only, and it is a plain link to the store's review form: the App
 * Store's on iOS, the Google Play listing on Android.
 */
function pretendShell(platform: 'ios' | 'android') {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
  };
}

afterEach(async () => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  await i18n.changeLanguage('en');
});

describe('AboutSettings: the Rate row', () => {
  it('opens the App Store review form, inside the iOS app', () => {
    pretendShell('ios');
    render(<AboutSettings />);
    const row = screen.getByRole('link', { name: /Rate Family Greenhouse/ });
    expect(row).toHaveAttribute(
      'href',
      'https://apps.apple.com/app/id6812185914?action=write-review'
    );
    expect(row).toHaveAttribute('target', '_blank');
    expect(row).toHaveTextContent('Opens the App Store');
    // No reward, no question first: the row says what it does and nothing else.
    expect(row.textContent).not.toMatch(/\$|free|reward|gift|trial|love|enjoy/i);
  });

  it('is in Spanish in Spanish', async () => {
    pretendShell('ios');
    await ensureLanguageCatalog('es');
    await i18n.changeLanguage('es');
    render(<AboutSettings />);
    expect(screen.getByRole('link', { name: /Califica Family Greenhouse/ })).toBeInTheDocument();
  });

  it('opens the Google Play listing, inside the Android app', () => {
    pretendShell('android');
    render(<AboutSettings />);
    const row = screen.getByRole('link', { name: /Rate Family Greenhouse/ });
    expect(row).toHaveAttribute(
      'href',
      'https://play.google.com/store/apps/details?id=net.familygreenhouse.app'
    );
    expect(row).toHaveAttribute('target', '_blank');
    expect(row).toHaveTextContent('Opens Google Play');
    expect(row.textContent).not.toMatch(/App Store|\$|free|reward|gift|trial|love|enjoy/i);
  });

  it('says Google Play in Spanish on Android', async () => {
    pretendShell('android');
    await ensureLanguageCatalog('es');
    await i18n.changeLanguage('es');
    render(<AboutSettings />);
    expect(screen.getByRole('link', { name: /Califica Family Greenhouse/ })).toHaveTextContent(
      'Abre Google Play'
    );
  });

  it('is not shown on the website', () => {
    render(<AboutSettings />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
