import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n, { ensureLanguageCatalog } from '@/i18n';
import { LandingPage } from '@/features/landing/LandingPage';
import { trackGoogleConversion } from '@/services/googleAnalytics';

vi.mock('@/services/googleAnalytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/googleAnalytics')>();
  return { ...actual, trackGoogleConversion: vi.fn() };
});

/**
 * The arrival step is where Family Greenhouse loses its visitors. GA4, 90
 * days to 2026-10-23: 33 sessions landed on `/`, 1 clicked a hero or header
 * sign-up control, 1 reached /register, 0 signed up. These tests hold the
 * hero to three things that page was missing:
 *
 *  - a headline that says what the product is (it was the quote "I thought
 *    you watered it.", which names no product, no plants and no reminders);
 *  - one call to action, not a sign-up button beside a "See how it works"
 *    scroll link;
 *  - a note beside the button that reassures instead of listing the form's
 *    fields and calling sign-up "about five minutes, start to finish".
 */
function renderLanding() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** The hero's copy column: the block that holds the h1. */
function heroColumn(): HTMLElement {
  const heading = screen.getByRole('heading', { level: 1 });
  const column = heading.parentElement;
  if (!column) throw new Error('the hero heading has no container');
  return column;
}

/** Every control a visitor could act on inside the hero copy. */
function heroControls(column: HTMLElement): HTMLElement[] {
  return Array.from(column.querySelectorAll<HTMLElement>('a, button'));
}

describe('landing hero', () => {
  beforeAll(async () => {
    await ensureLanguageCatalog('es');
  });
  afterEach(async () => {
    cleanup();
    localStorage.clear();
    vi.mocked(trackGoogleConversion).mockClear();
    await i18n.changeLanguage('en');
  });

  it('says what the product is in the headline', () => {
    renderLanding();
    const heading = screen.getByRole('heading', { level: 1 }).textContent ?? '';
    expect(heading).toBe('Plant care for your whole household.');
    // The household quote still appears, now as the subhead's first line, so
    // the ad creative that reuses it still matches the page it lands on.
    expect(heroColumn().textContent).toContain('No more “I thought you watered it.”');
  });

  it('has exactly one call to action, and it goes to sign-up', async () => {
    const user = userEvent.setup();
    renderLanding();
    const controls = heroControls(heroColumn());
    expect(controls).toHaveLength(1);
    const [cta] = controls;
    expect(cta).toHaveAttribute('href', '/register');
    expect(cta).toHaveAccessibleName(/sign up free/i);
    expect(screen.queryByText(/see how it works/i)).not.toBeInTheDocument();

    await user.click(cta);
    expect(trackGoogleConversion).toHaveBeenCalledWith({
      name: 'landing_cta_click',
      cta: 'hero_signup',
    });
  });

  it('puts the reassurance, not the chore list, next to the button', () => {
    renderLanding();
    const text = heroColumn().textContent ?? '';
    expect(text).toMatch(/no credit card/i);
    expect(text).toMatch(/14 days of Garden/);
    expect(text).toMatch(/3 people and 20 plants/);
    // The emailed code is still named, so nobody is surprised by it mid-flow.
    expect(text).toMatch(/code we send/i);
    expect(text).not.toMatch(/five minutes/i);
    expect(text).not.toMatch(/name, email, and password/i);
  });

  it('the Spanish hero has the same single call to action, in Spanish', async () => {
    await i18n.changeLanguage('es');
    renderLanding();
    const heading = screen.getByRole('heading', { level: 1 }).textContent ?? '';
    expect(heading).toBe('Cuidado de plantas para todo tu hogar.');
    const controls = heroControls(heroColumn());
    expect(controls).toHaveLength(1);
    expect(controls[0]).toHaveAttribute('href', '/register');
    expect(heroColumn().textContent).toMatch(/sin tarjeta de crédito/i);
    expect(heroColumn().textContent).not.toMatch(/cinco minutos/i);
  });

  it('negative control: a second hero link is counted, so the one-CTA check can fail', () => {
    renderLanding();
    const column = heroColumn();
    expect(heroControls(column)).toHaveLength(1);
    const extra = document.createElement('a');
    extra.setAttribute('href', '#features');
    extra.textContent = 'See how it works';
    column.appendChild(extra);
    // The sabotage applied: the counter now sees two controls.
    expect(heroControls(column)).toHaveLength(2);
  });
});
