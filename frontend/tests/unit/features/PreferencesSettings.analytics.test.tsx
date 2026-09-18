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
    // Rendering the settings tree also mounts whatever reads auth state, and
    // the shared test harness's own store reset (tests/setup.ts) already
    // left an `auth-storage` key behind before this test runs. That key is
    // not the shim's concern; what is under test is that opting out adds
    // exactly one key beyond whatever was already there.
    const keysBeforeClick = new Set<string>();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null) keysBeforeClick.add(key);
    }

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
    const keysAfterClick = new Set<string>();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null) keysAfterClick.add(key);
    }
    expect(keysAfterClick).toEqual(new Set([...keysBeforeClick, ANALYTICS_OPT_OUT_STORAGE_KEY]));
    expect(localStorage.getItem(ANALYTICS_OPT_OUT_STORAGE_KEY)).toBe('1');
  });

  it('also drops the Google Analytics cookies when turned off', async () => {
    document.cookie = '_ga=GA1.1.123.456; path=/';
    document.cookie = '_ga_L2JN3PQ75P=GS2.1.s1; path=/';
    // The sabotage landed: both identifiers exist before the click.
    expect(document.cookie).toContain('_ga=');
    expect(document.cookie).toContain('_ga_L2JN3PQ75P=');

    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('checkbox', { name: /share usage events/i }));

    expect(analyticsOptedOut()).toBe(true);
    expect(document.cookie).not.toContain('_ga=');
    expect(document.cookie).not.toContain('_ga_L2JN3PQ75P=');
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
