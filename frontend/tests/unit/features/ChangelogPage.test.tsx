import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ChangelogPage } from '@/features/changelog/ChangelogPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <ChangelogPage />
    </MemoryRouter>
  );
}

function setNative(native: boolean) {
  if (native) {
    // The global the Capacitor bridge injects (lib/platform.ts reads it).
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
  } else {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  }
}

afterEach(() => {
  cleanup();
  setNative(false);
});

describe('ChangelogPage', () => {
  // The control for the test below: on the website the billing entries are
  // there, with their prices and the link to the plans. If this ever stops
  // finding them, the in-app test proves nothing.
  it('on the website: keeps the paid-plans entry, its prices and its link to the plans', () => {
    setNative(false);
    renderPage();

    expect(screen.getByRole('heading', { name: 'Paid plans are open' })).toBeInTheDocument();
    // Two entries name $4.99: the 2026-09-02 opening, and the 2026-11-08 reprice ("It was ...").
    expect(screen.getAllByText(/\$4\.99 a month/)).toHaveLength(2);
    expect(screen.getByText(/can now be bought on the web/)).toBeInTheDocument();
    const planLinks = screen.getAllByRole('link', { name: 'See the plans' });
    expect(planLinks).toHaveLength(2);
    for (const link of planLinks) expect(link).toHaveAttribute('href', '/pricing');
    expect(
      screen.getByRole('heading', { name: 'A cancelled plan now says it is cancelled' })
    ).toBeInTheDocument();
  });

  it('on the website: the newest entries state the current Garden price and free plan', () => {
    setNative(false);
    renderPage();
    expect(
      screen.getByRole('heading', { name: 'Garden is $2.99 a month, or $24.99 a year' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Garden now costs \$2\.99 a month or \$24\.99 a year/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'The free plan is 2 people and 8 plants' })
    ).toBeInTheDocument();
  });

  it('in the app: no price, no "bought on the web", and no link to the plans or to billing help', () => {
    setNative(true);
    const { container } = renderPage();

    expect(screen.queryByRole('heading', { name: 'Paid plans are open' })).toBeNull();
    expect(
      screen.queryByRole('heading', { name: 'A cancelled plan now says it is cancelled' })
    ).toBeNull();
    expect(container).not.toHaveTextContent(/\$\d/);
    expect(container).not.toHaveTextContent(/bought on the web/i);
    expect(container.querySelector('a[href="/pricing"]')).toBeNull();
    expect(container.querySelector('a[href="/gift"]')).toBeNull();
    expect(container.querySelector('a[href="/help/billing"]')).toBeNull();
    // Everything else is still there.
    expect(
      screen.getByRole('heading', { name: 'Help is public, and much bigger' })
    ).toBeInTheDocument();
  });
});
