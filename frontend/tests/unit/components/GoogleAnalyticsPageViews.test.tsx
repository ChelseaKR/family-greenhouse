/**
 * SPA route changes register as GA4 page views.
 *
 * GA's own enhanced measurement would count history changes, but from the raw
 * URL and title (docs/analytics.md, "Google Analytics 4"), so the app sends
 * page views itself. This drives the real module through a real router: each
 * navigation must add exactly one scrubbed page_view to the dataLayer that
 * gtag.js drains, and a fragment-only change must add none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import {
  createMemoryRouter,
  RouterProvider,
  useNavigate,
  type NavigateFunction,
} from 'react-router';

const ID = 'G-L2JN3PQ75P';

let navigate: NavigateFunction | null = null;

function NavigateHandle() {
  navigate = useNavigate();
  return null;
}

function pageViewLocations(): string[] {
  const all = (window.dataLayer ?? []).map((entry) => Array.from(entry as ArrayLike<unknown>));
  return all.flatMap((command, index) =>
    command[0] === 'event' && command[1] === 'page_view'
      ? [String((all[index - 1]?.[1] as { page_location?: unknown }).page_location)]
      : []
  );
}

async function renderAt(path: string) {
  vi.resetModules();
  const ga = await import('@/services/googleAnalytics');
  const { GoogleAnalyticsPageViews } = await import('@/components/GoogleAnalyticsPageViews');
  const loaded = ga.initGoogleAnalytics();
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <>
            <NavigateHandle />
            <GoogleAnalyticsPageViews />
          </>
        ),
      },
    ],
    { initialEntries: [path] }
  );
  render(<RouterProvider router={router} />);
  return loaded;
}

function reset() {
  delete window.dataLayer;
  document
    .querySelectorAll('script[src^="https://www.googletagmanager.com/gtag/js"]')
    .forEach((script) => script.remove());
  delete (window as unknown as Record<string, unknown>)[`ga-disable-${ID}`];
  localStorage.clear();
  navigate = null;
}

describe('GoogleAnalyticsPageViews', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', ID);
    Object.defineProperty(navigator, 'doNotTrack', { value: null, configurable: true });
    Object.defineProperty(navigator, 'globalPrivacyControl', {
      value: undefined,
      configurable: true,
    });
    reset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    reset();
  });

  it('sends a page view for the landing route and one per navigation', async () => {
    expect(await renderAt('/?utm_source=mastodon')).toBe(true);
    const origin = window.location.origin;
    expect(pageViewLocations()).toEqual([`${origin}/?utm_source=mastodon`]);

    await act(async () => navigate!('/care/monstera'));
    await act(async () => navigate!('/sit/SeCrEtToKeN/brief'));
    await act(async () => navigate!('/sit/SeCrEtToKeN/brief#main-content'));
    await act(async () => navigate!('/pricing'));

    expect(pageViewLocations()).toEqual([
      `${origin}/?utm_source=mastodon`,
      `${origin}/care/monstera`,
      `${origin}/sit/:token/brief`,
      `${origin}/pricing`,
    ]);
    expect(JSON.stringify(window.dataLayer)).not.toContain('SeCrEtToKeN');
  });

  it('sends nothing when the build carries no measurement ID', async () => {
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', '');
    expect(await renderAt('/pricing')).toBe(false);
    await act(async () => navigate!('/care'));
    expect(window.dataLayer).toBeUndefined();
  });
});
