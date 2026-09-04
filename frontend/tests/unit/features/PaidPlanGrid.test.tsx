import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { PaidPlanGrid } from '@/features/pricing/PaidPlanGrid';
import { intervalIsOffered, priceFor } from '@/features/pricing/planPricing';
import type { Plan, PlanFeatures } from '@/services/billingService';

/** Feature map with everything off, so a fixture names only what it grants. */
const NO_FEATURES: PlanFeatures = {
  awayKit: false,
  householdToolkit: false,
  plantTags: false,
  crossHomeToday: false,
  kiosk: false,
  caretakerSeats: false,
  moveDay: false,
  chat: false,
  apiKeys: false,
};

// The catalog as the API publishes it after ADR 0014: `limits` and `features`
// alongside the legacy cap fields, with `null` for unlimited.
const seedling: Plan = {
  id: 'seedling',
  name: 'Seedling',
  description: 'A couple and their plants',
  maxPlants: 20,
  maxMembers: 3,
  limits: {
    homes: 1,
    members: 3,
    plants: 20,
    tags: 0,
    analyticsHistoryDays: 30,
    sitterLinkMaxDays: 7,
    sitterLinksActive: 1,
  },
  features: { ...NO_FEATURES },
  monthlyPrice: 0,
  annualPrice: null,
  lifetimePrice: null,
};

const garden: Plan = {
  id: 'garden',
  name: 'Garden',
  description: 'A household that has to coordinate',
  maxPlants: 200,
  maxMembers: null,
  limits: {
    homes: 1,
    members: null,
    plants: 200,
    tags: 50,
    analyticsHistoryDays: null,
    sitterLinkMaxDays: 90,
    sitterLinksActive: null,
  },
  features: {
    ...NO_FEATURES,
    awayKit: true,
    householdToolkit: true,
    plantTags: true,
    moveDay: true,
    chat: true,
  },
  monthlyPrice: 4.99,
  annualPrice: 39.99,
  lifetimePrice: 149,
};

const greenhouse: Plan = {
  id: 'greenhouse',
  name: 'Greenhouse',
  description: 'Many homes, many hands',
  maxPlants: 5000,
  maxMembers: null,
  limits: {
    homes: null,
    members: null,
    plants: 5000,
    tags: null,
    analyticsHistoryDays: null,
    sitterLinkMaxDays: 90,
    sitterLinksActive: null,
  },
  features: {
    ...NO_FEATURES,
    awayKit: true,
    householdToolkit: true,
    plantTags: true,
    crossHomeToday: true,
    kiosk: true,
    caretakerSeats: true,
    moveDay: true,
    chat: true,
    apiKeys: true,
  },
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

  it('lists import, export and the calendar feed under the free tier, not as a paid differentiator', () => {
    // POST /plants/import, GET /me/export and the .ics feed are open to every
    // tier (import is bounded only by the plan's plant cap, which the caps
    // line already shows). The bullets are cumulative, so naming them under
    // Greenhouse claimed the lower tiers lack them — contradicting the
    // "Nothing locked away" band, which promises export to everyone.
    render(<PaidPlanGrid plans={[seedling, garden, greenhouse]} />);
    const card = (name: string) => within(screen.getByRole('heading', { name }).closest('li')!);

    expect(
      card('Seedling').getByText('Import, export and calendar feed (CSV, JSON, .ics)')
    ).toBeInTheDocument();
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
    ...greenhouse,
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

describe('the caps line reads homes, hands and plants (ADR 0014)', () => {
  const card = (name: string) => within(screen.getByRole('heading', { name }).closest('li')!);

  it('states one home, the member cap and the plant cap on the free tier', () => {
    render(<PaidPlanGrid plans={[seedling, garden, greenhouse]} />);
    expect(card('Seedling').getByText('1 home · 3 members · 20 plants')).toBeInTheDocument();
  });

  it('renders an unlimited cap as "unlimited", never as a number and never as 0', () => {
    // `null` is the wire's unlimited (backend/src/models/plans.ts). Rendering
    // it through a numeric path would print "0 members" — a cap of nothing —
    // which is the opposite of what it means.
    render(<PaidPlanGrid plans={[seedling, garden, greenhouse]} />);
    expect(card('Garden').getByText('1 home · Unlimited members · 200 plants')).toBeInTheDocument();
    expect(
      card('Greenhouse').getByText('Unlimited homes · Unlimited members · 5,000 plants')
    ).toBeInTheDocument();
    expect(screen.queryByText(/0 members|0 homes/)).not.toBeInTheDocument();
  });

  it('falls back to the legacy cap fields when an older backend sends no limits map', () => {
    const legacy: Plan = {
      id: 'garden',
      name: 'Garden',
      description: 'Growing families',
      maxPlants: 200,
      maxMembers: 6,
      monthlyPrice: 4.99,
    };
    render(<PaidPlanGrid plans={[legacy]} />);
    // No homes claim at all — the old shape cannot say, so the line does not
    // invent one — but the caps it does carry are still stated.
    expect(card('Garden').getByText('6 members · 200 plants')).toBeInTheDocument();
  });
});

describe('feature bullets follow the catalog flags, and only where the tier gains them', () => {
  const card = (name: string) => within(screen.getByRole('heading', { name }).closest('li')!);

  it('names the assistant on Garden and API keys on Greenhouse, each once', () => {
    render(<PaidPlanGrid plans={[seedling, garden, greenhouse]} />);
    expect(card('Garden').getByText('AI care assistant')).toBeInTheDocument();
    expect(card('Greenhouse').queryByText('AI care assistant')).not.toBeInTheDocument();
    expect(card('Greenhouse').getByText('API access for automation')).toBeInTheDocument();
    expect(card('Seedling').queryByText(/assistant|API access/i)).not.toBeInTheDocument();
  });

  it('claims nothing from the flags when the backend sends no features map', () => {
    const legacy: Plan = {
      id: 'greenhouse',
      name: 'Greenhouse',
      description: 'Serious plant parents',
      maxPlants: 5000,
      maxMembers: 50,
      monthlyPrice: 9.99,
    };
    render(<PaidPlanGrid plans={[legacy]} />);
    expect(card('Greenhouse').queryByText('API access for automation')).not.toBeInTheDocument();
  });

  it('hangs a bullet on the tier that first gains it, whatever order the catalog arrives in', () => {
    // The lists are cumulative, so "new here" has to mean a lower TIER, not
    // an earlier array index. A catalog in another order must not move the
    // assistant bullet up to Greenhouse and leave Garden claiming nothing.
    render(<PaidPlanGrid plans={[greenhouse, seedling, garden]} />);
    const card = (name: string) => within(screen.getByRole('heading', { name }).closest('li')!);
    expect(card('Garden').getByText('AI care assistant')).toBeInTheDocument();
    expect(card('Greenhouse').queryByText('AI care assistant')).not.toBeInTheDocument();
    expect(card('Greenhouse').getByText('API access for automation')).toBeInTheDocument();
  });
});
