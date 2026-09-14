/**
 * The in-app product-analytics opt-out (docs/analytics.md, "Opt-out signals").
 *
 * It is the only opt-out that works inside the iOS shell — WKWebView never
 * sends DNT and WebKit has no Global Privacy Control — so it must actually
 * silence the shim, not just flip a checkbox. The switch reads the shim's own
 * stored flag back after every change, so what the person sees is what the
 * shim will do.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { PreferencesSettings } from '@/features/settings/PreferencesSettings';
import {
  ANALYTICS_OPT_OUT_STORAGE_KEY,
  analyticsOptOutStored,
  analyticsOptedOut,
} from '@/services/analytics';

function renderPanel() {
  return render(
    <MemoryRouter>
      <PreferencesSettings />
    </MemoryRouter>
  );
}

describe('PreferencesSettings: product analytics opt-out', () => {
  beforeEach(() => {
    localStorage.removeItem(ANALYTICS_OPT_OUT_STORAGE_KEY);
    Object.defineProperty(globalThis.navigator, 'doNotTrack', { value: null, configurable: true });
  });
  afterEach(() => {
    localStorage.removeItem(ANALYTICS_OPT_OUT_STORAGE_KEY);
  });

  it('is on by default, and turning it off silences the shim on this device', async () => {
    const user = userEvent.setup();
    renderPanel();
    const box = screen.getByRole('checkbox', { name: /share usage events/i });

    expect(box).toBeChecked();
    expect(analyticsOptedOut()).toBe(false);

    await user.click(box);

    expect(box).not.toBeChecked();
    expect(analyticsOptOutStored()).toBe(true);
    expect(analyticsOptedOut()).toBe(true);
    // The one key the shim ever writes, and nothing else.
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem(ANALYTICS_OPT_OUT_STORAGE_KEY)).toBe('1');
  });

  it('reflects a stored opt-out on mount and clears it when turned back on', async () => {
    localStorage.setItem(ANALYTICS_OPT_OUT_STORAGE_KEY, '1');
    const user = userEvent.setup();
    renderPanel();
    const box = screen.getByRole('checkbox', { name: /share usage events/i });

    expect(box).not.toBeChecked();
    expect(analyticsOptedOut()).toBe(true);

    await user.click(box);

    expect(box).toBeChecked();
    expect(localStorage.getItem(ANALYTICS_OPT_OUT_STORAGE_KEY)).toBeNull();
    expect(analyticsOptedOut()).toBe(false);
  });

  it('links to the privacy page, which names this switch', () => {
    renderPanel();
    expect(screen.getByRole('link', { name: /privacy page/i })).toHaveAttribute('href', '/privacy');
  });
});
