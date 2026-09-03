import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { PaidPlanGrid } from '@/features/pricing/PaidPlanGrid';
import { intervalIsOffered, priceFor } from '@/features/pricing/planPricing';
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

const greenhouse: Plan = {
  id: 'greenhouse',
  name: 'Greenhouse',
  description: 'Serious plant parents',
  maxPlants: 5000,
  maxMembers: 50,
  monthlyPrice: 9.99,
  annualPrice: 79.99,
  lifetimePrice: null,
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

  it('lists import and export under the free tier, not as a paid differentiator', () => {
    // POST /plants/import and GET /me/export are open to every tier (import is
    // bounded only by the plan's plant cap, which the caps line already shows).
    // The bullets are cumulative, so naming them under Greenhouse claimed the
    // lower tiers lack them — contradicting the "Nothing locked away" band,
    // which promises export to everyone.
    render(<PaidPlanGrid plans={[seedling, garden, greenhouse]} />);
    const card = (name: string) => within(screen.getByRole('heading', { name }).closest('li')!);

    expect(card('Seedling').getByText('Import and export (CSV and JSON)')).toBeInTheDocument();
    expect(card('Garden').queryByText(/import|export/i)).not.toBeInTheDocument();
    expect(card('Greenhouse').queryByText(/import|export/i)).not.toBeInTheDocument();
    // The one paid-only bullet that is actually enforced stays.
    expect(card('Greenhouse').getByText('API access for automation')).toBeInTheDocument();
  });

  it('renders no call to action when the caller supplies none', () => {
    // The public pricing page and Settings pass different CTAs; the grid
    // itself must never invent a purchase path.
    render(<PaidPlanGrid plans={[seedling, garden]} />);
    expect(screen.queryByRole('button', { name: /Switch to|Buy / })).not.toBeInTheDocument();
  });
});

describe('withdrawn cadences (annual and lifetime withdrawn from sale)', () => {
  // The API publishes a withdrawn cadence as a null price — the same signal
  // as "this tier never had that cadence" — so the grid must collapse to
  // monthly without any client-side knowledge of the decision.
  const gardenMonthlyOnly: Plan = { ...garden, annualPrice: null, lifetimePrice: null };
  const greenhouseMonthlyOnly: Plan = {
    id: 'greenhouse',
    name: 'Greenhouse',
    description: 'Serious plant parents',
    maxPlants: 5000,
    maxMembers: 50,
    monthlyPrice: 9.99,
    annualPrice: null,
    lifetimePrice: null,
  };
  const catalog = [seedling, gardenMonthlyOnly, greenhouseMonthlyOnly];

  it('reports year and lifetime as not offered when every paid tier withdraws them', () => {
    expect(intervalIsOffered(catalog, 'month')).toBe(true);
    expect(intervalIsOffered(catalog, 'year')).toBe(false);
    expect(intervalIsOffered(catalog, 'lifetime')).toBe(false);
  });

  it('renders no interval toggle and no yearly or one-time price text, only monthly amounts', () => {
    render(<PaidPlanGrid plans={catalog} />);

    // No toggle at all — not a disabled tab, not a "coming back" note.
    expect(screen.queryByRole('group', { name: 'Billing interval' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Yearly|Lifetime/ })).not.toBeInTheDocument();
    // Nothing on the page describes a cadence that cannot be bought.
    expect(screen.queryByText(/per year/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^once$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Not available/)).not.toBeInTheDocument();
    // Both paid tiers still sell monthly, at their monthly amounts.
    expect(screen.getByText('$4.99')).toBeInTheDocument();
    expect(screen.getByText('$9.99')).toBeInTheDocument();
    expect(screen.getAllByText('per month')).toHaveLength(3);
  });

  it('still shows the toggle when the API re-offers a cadence, so re-listing is a backend change', () => {
    // The client is deliberately generic: if the catalog ever publishes an
    // annual price again, the toggle returns with no frontend release.
    render(<PaidPlanGrid plans={[seedling, garden, greenhouseMonthlyOnly]} />);
    expect(screen.getByRole('group', { name: 'Billing interval' })).toBeInTheDocument();
  });
});
