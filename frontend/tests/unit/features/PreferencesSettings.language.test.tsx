/**
 * The language picker in Settings → Preferences (#467).
 *
 * It renders for everyone now that Spanish is reachable, so it must not cost
 * the English-first majority anything: the Spanish catalog is a separate chunk
 * (src/i18n/nonEnglishCatalog.ts), and the picker asks for it only once
 * someone reaches for the control, not whenever the panel mounts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import i18n from '@/i18n';
import { PreferencesSettings } from '@/features/settings/PreferencesSettings';

// Record every catalog request the panel makes, then let it through. Asserting
// on the request rather than on `hasResourceBundle` matters: under vitest the
// first transform of the 104 kB catalog takes far longer than any wait a test
// could reasonably make, so "not registered yet" would also hold for a load
// that had already started — and the no-fetch-on-mount assertion would pass
// against the very prefetch it exists to forbid (measured: it did).
const catalogRequests = vi.hoisted(() => [] as string[]);
vi.mock('@/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n')>();
  return {
    ...actual,
    ensureLanguageCatalog: (lng: string) => {
      catalogRequests.push(lng);
      return actual.ensureLanguageCatalog(lng);
    },
  };
});

function renderPanel() {
  return render(
    <MemoryRouter>
      <PreferencesSettings />
    </MemoryRouter>
  );
}

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('PreferencesSettings: language', () => {
  // First in the file on purpose: the i18n instance is shared across this
  // file's tests, and the ones below register the Spanish catalog on it.
  it('fetches the Spanish catalog when the picker is reached for, not when the panel mounts', async () => {
    renderPanel();

    // Effects have flushed by the time render() returns.
    expect(catalogRequests).not.toContain('es');
    expect(i18n.hasResourceBundle('es', 'translation')).toBe(false);

    fireEvent.focus(screen.getByRole('combobox', { name: /language/i }));

    expect(catalogRequests).toContain('es');
    await waitFor(() => expect(i18n.hasResourceBundle('es', 'translation')).toBe(true), {
      timeout: 10_000,
    });
  });

  it('offers Spanish, labelled in Spanish', () => {
    renderPanel();

    const picker = screen.getByRole('combobox', { name: /language/i });
    const options = Array.from((picker as HTMLSelectElement).options).map((o) => o.textContent);

    expect(options).toEqual(['English', 'Español']);
  });

  it('switches the page to Spanish', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.selectOptions(screen.getByRole('combobox', { name: /language/i }), 'es');

    // The panel's own title re-renders from the Spanish catalog once it lands.
    await waitFor(() => expect(i18n.resolvedLanguage).toBe('es'), { timeout: 10_000 });
    expect(
      await screen.findByText(i18n.getResource('es', 'translation', 'settings.preferences.title'))
    ).toBeInTheDocument();
  });
});
