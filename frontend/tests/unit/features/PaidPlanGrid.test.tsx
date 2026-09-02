import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PaidPlanGrid } from '@/features/pricing/PaidPlanGrid';
import { priceFor } from '@/features/pricing/planPricing';
import type { Plan } from '@/services/billingService';

const seedling: Plan = {
  id: 'seedling',
  name: 'Seedling',
  description: 'Free',
  maxPlants: 10,
  maxMembers: 6,
  monthlyPrice: 0,
  annualPrice: null,
  lifetimePrice: null,
};

const garden: Plan = {
  id: 'garden',
  name: 'Garden',
  description: 'Growing families',
  maxPlants: 500,
  maxMembers: 6,
  monthlyPrice: 4.99,
  annualPrice: 39.99,
  lifetimePrice: 149,
};

describe('priceFor', () => {
  it('reads the amount for each cadence', () => {
    expect(priceFor(garden, 'month')).toBe(4.99);
    expect(priceFor(garden, 'year')).toBe(39.99);
    expect(priceFor(garden, 'lifetime')).toBe(149);
  });

  it('distinguishes "not sold at this cadence" from free', () => {
    // null must never collapse to 0: a blank price id is a deliberate partial
    // launch (see environments/*.tfvars), and rendering it as $0 would
    // advertise a price the API will refuse to honour.
    expect(priceFor(seedling, 'year')).toBeNull();
    expect(priceFor(seedling, 'month')).toBe(0);
    expect(priceFor(seedling, 'month')).not.toBeNull();
  });

  it('treats a withheld price as unsold rather than free', () => {
    // The server omits price fields entirely while payment activity is off.
    const withheld: Plan = { ...garden, monthlyPrice: undefined };
    expect(priceFor(withheld, 'month')).toBeNull();
  });
});

describe('PaidPlanGrid', () => {
  it('hides the interval toggle when only one cadence is on sale', () => {
    // A monthly-only launch should not show a toggle whose other tabs are
    // all-unavailable.
    const monthlyOnly: Plan = { ...garden, annualPrice: null, lifetimePrice: null };
    render(<PaidPlanGrid plans={[seedling, monthlyOnly]} />);

    expect(screen.queryByRole('group', { name: 'Billing interval' })).not.toBeInTheDocument();
    expect(screen.getByText('$4.99')).toBeInTheDocument();
  });

  it('opens on the first cadence actually offered', () => {
    // Annual-and-lifetime-only catalog must not open on an empty Monthly tab.
    const noMonthly: Plan = { ...garden, monthlyPrice: undefined };
    render(<PaidPlanGrid plans={[noMonthly]} />);

    expect(screen.getByRole('button', { name: /Yearly/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('$39.99')).toBeInTheDocument();
  });

  it('marks the household’s current tier', () => {
    render(<PaidPlanGrid plans={[seedling, garden]} currentPlanId="garden" />);
    expect(screen.getByText('Current plan')).toBeInTheDocument();
  });

  it('renders no call to action when the caller supplies none', () => {
    // The public pricing page and Settings pass different CTAs; the grid
    // itself must never invent a purchase path.
    render(<PaidPlanGrid plans={[seedling, garden]} />);
    expect(screen.queryByRole('button', { name: /Switch to|Buy / })).not.toBeInTheDocument();
  });
});
