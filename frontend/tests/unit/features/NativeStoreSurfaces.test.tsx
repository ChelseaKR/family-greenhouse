import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PricingPage } from '@/features/pricing/PricingPage';
import { HelpPage } from '@/features/help/HelpPage';
import { AccountDeletionPage } from '@/features/legal/AccountDeletionPage';

describe('native store policy surfaces', () => {
  beforeEach(() => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
  });

  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  it('replaces public checkout pricing with neutral, purchase-free plan information', () => {
    render(
      <MemoryRouter>
        <PricingPage />
      </MemoryRouter>
    );
    expect(
      screen.getByRole('heading', { name: 'Your Family Greenhouse plan' })
    ).toBeInTheDocument();
    expect(screen.getByText(/No payment is collected in this app/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /upgrade/i })).not.toBeInTheDocument();
    expect(screen.queryByText('$39.99')).not.toBeInTheDocument();
  });

  it('removes web-only billing and cancellation instructions from native help', () => {
    render(
      <MemoryRouter>
        <HelpPage />
      </MemoryRouter>
    );
    expect(screen.queryByText('Billing')).not.toBeInTheDocument();
    expect(screen.queryByText('How do I cancel my subscription?')).not.toBeInTheDocument();
  });

  it('provides a public account-deletion request path', () => {
    render(
      <MemoryRouter>
        <AccountDeletionPage />
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { name: 'Delete your account' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in to delete your account' })).toHaveAttribute(
      'href',
      '/login'
    );
    expect(screen.getByRole('link', { name: 'support@familygreenhouse.net' })).toHaveAttribute(
      'href',
      expect.stringContaining('mailto:support@familygreenhouse.net')
    );
  });
});
