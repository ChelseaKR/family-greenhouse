/**
 * The public "Opt out of analytics" footer control.
 *
 * One switch for both vendors: the tests drive the real PostHog shim and the
 * real Google Analytics loader, then read what each would send — `fetch` calls
 * to PostHog's `/capture/`, and `page_view` commands on the dataLayer gtag.js
 * drains (plus Google's `ga-disable-<id>` kill switch, which gtag.js reads
 * before every hit, automatic ones included). A positive control runs first in
 * the same test, so "nothing was sent after opting out" cannot pass because
 * nothing was ever being sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import en from '@/i18n/locales/en/translation.json';
import es from '@/i18n/locales/es/translation.json';
import enLegal from '@/i18n/locales/en/legal.json';
import esLegal from '@/i18n/locales/es/legal.json';

const GA_ID = 'G-L2JN3PQ75P';
const USER = 'u0000000-0000-4000-8000-000000000009';

type Analytics = typeof import('@/services/analytics');
type GoogleAnalytics = typeof import('@/services/googleAnalytics');
type Toggle = typeof import('@/components/AnalyticsOptOutToggle');

async function load(): Promise<{
  analytics: Analytics;
  ga: GoogleAnalytics;
  AnalyticsOptOutToggle: Toggle['AnalyticsOptOutToggle'];
  fetchMock: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();
  const fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
  const analytics = await import('@/services/analytics');
  const ga = await import('@/services/googleAnalytics');
  const { AnalyticsOptOutToggle } = await import('@/components/AnalyticsOptOutToggle');
  return { analytics, ga, AnalyticsOptOutToggle, fetchMock };
}

function postHogCaptures(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('/capture/')).length;
}

function gaPageViews(): number {
  return (window.dataLayer ?? [])
    .map((entry) => Array.from(entry as ArrayLike<unknown>))
    .filter((command) => command[0] === 'event' && command[1] === 'page_view').length;
}

const gaDisabled = () => (window as unknown as Record<string, unknown>)[`ga-disable-${GA_ID}`];

function reset() {
  localStorage.clear();
  delete window.dataLayer;
  document
    .querySelectorAll('script[src^="https://www.googletagmanager.com/gtag/js"]')
    .forEach((script) => script.remove());
  delete (window as unknown as Record<string, unknown>)[`ga-disable-${GA_ID}`];
  for (const pair of document.cookie.split(';')) {
    const name = pair.split('=', 1)[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; path=/`;
  }
}

beforeEach(() => {
  vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test_key');
  vi.stubEnv('VITE_GA_MEASUREMENT_ID', GA_ID);
  Object.defineProperty(navigator, 'doNotTrack', { value: null, configurable: true });
  Object.defineProperty(navigator, 'globalPrivacyControl', {
    value: undefined,
    configurable: true,
  });
  reset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'globalPrivacyControl', {
    value: undefined,
    configurable: true,
  });
  reset();
});

describe('AnalyticsOptOutToggle', () => {
  it('opting out stops PostHog and Google Analytics, and drops the GA cookies', async () => {
    const { analytics, ga, AnalyticsOptOutToggle, fetchMock } = await load();
    analytics.identify(USER);
    expect(ga.initGoogleAnalytics()).toBe(true);
    ga.trackGooglePageView('/pricing', '', 'Pricing');
    analytics.track('plant_added');
    await Promise.resolve();

    // Positive control: both rails are live before the click.
    const captures = postHogCaptures(fetchMock);
    expect(captures).toBeGreaterThan(0);
    expect(gaPageViews()).toBe(1);
    expect(gaDisabled()).toBe(false);
    document.cookie = '_ga=GA1.1.123.456; path=/';
    document.cookie = `_ga_${GA_ID.slice(2)}=GS2.1.s1; path=/`;
    expect(document.cookie).toContain('_ga=');

    const user = userEvent.setup();
    render(<AnalyticsOptOutToggle />);
    await user.click(await screen.findByRole('button', { name: 'Opt out of analytics' }));

    // The one per-device flag, shared with Settings → Preferences.
    expect(localStorage.getItem(analytics.ANALYTICS_OPT_OUT_STORAGE_KEY)).toBe('1');
    expect(analytics.analyticsOptedOut()).toBe(true);
    expect(gaDisabled()).toBe(true);
    expect(document.cookie).not.toContain('_ga');

    analytics.track('task_completed');
    ga.trackGooglePageView('/care', '', 'Care');
    await Promise.resolve();
    expect(postHogCaptures(fetchMock)).toBe(captures);
    expect(gaPageViews()).toBe(1);

    expect(screen.getByText('Analytics is off on this device.')).toBeInTheDocument();
    const optBackIn = screen.getByRole('button', { name: 'Opt back in' });
    // Same element, so keyboard focus is not dropped by the relabel.
    expect(optBackIn).toHaveFocus();
  });

  it('opting back in resumes both, and starts GA if it never loaded this visit', async () => {
    localStorage.setItem('fg-analytics-opt-out', '1');
    const { analytics, ga, AnalyticsOptOutToggle, fetchMock } = await load();
    analytics.identify(USER);
    // Opted out at boot: GA does not load at all.
    expect(ga.initGoogleAnalytics()).toBe(false);
    expect(window.dataLayer).toBeUndefined();

    const user = userEvent.setup();
    render(<AnalyticsOptOutToggle />);
    expect(await screen.findByText('Analytics is off on this device.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Opt back in' }));

    expect(localStorage.getItem(analytics.ANALYTICS_OPT_OUT_STORAGE_KEY)).toBeNull();
    expect(gaDisabled()).toBe(false);
    // The page being viewed is counted once GA starts.
    expect(gaPageViews()).toBe(1);
    analytics.track('plant_added');
    await Promise.resolve();
    expect(postHogCaptures(fetchMock)).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Opt out of analytics' })).toBeInTheDocument();
  });

  it('under a browser privacy signal says so, and offers nothing to switch back on', async () => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
    const { analytics, AnalyticsOptOutToggle } = await load();
    expect(analytics.analyticsOptedOut()).toBe(true);
    expect(analytics.analyticsOptOutStored()).toBe(false);

    render(<AnalyticsOptOutToggle />);
    expect(
      await screen.findByText('Analytics is off: your browser sends a privacy signal.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders in Spanish', async () => {
    const { AnalyticsOptOutToggle } = await load();
    const spanish = createInstance();
    await spanish.init({
      lng: 'es',
      resources: { es: { translation: es } },
      interpolation: { escapeValue: false },
    });
    const user = userEvent.setup();
    render(
      <I18nextProvider i18n={spanish}>
        <AnalyticsOptOutToggle />
      </I18nextProvider>
    );
    await user.click(await screen.findByRole('button', { name: 'Desactivar la analítica' }));
    expect(
      screen.getByText('La analítica está desactivada en este dispositivo.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Volver a activarla' })).toBeInTheDocument();
  });

  it('is named on the privacy page exactly as it is labelled, in both locales', () => {
    type Catalog = {
      settings: { preferences: { analyticsOptOutLink: string; analyticsOptBackIn: string } };
    };
    const labels = (catalog: Catalog) => [
      catalog.settings.preferences.analyticsOptOutLink,
      catalog.settings.preferences.analyticsOptBackIn,
    ];
    for (const label of labels(en)) expect(enLegal.legal.privacy.collect.optOut).toContain(label);
    for (const label of labels(es)) expect(esLegal.legal.privacy.collect.optOut).toContain(label);
  });
});
