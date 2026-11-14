import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PLAN_PRICES, offeredPrices } from '@/features/pricing/planPrices';
import { PricingPage } from '@/features/pricing/PricingPage';

vi.mock('@/services/billingService', async () => {
  const actual = await vi.importActual<typeof import('@/services/billingService')>(
    '@/services/billingService'
  );
  return { ...actual, billingService: { listPlans: vi.fn(), getCurrentSubscription: vi.fn() } };
});

interface Offer {
  '@type': string;
  name: string;
  price: string;
  priceCurrency: string;
  priceSpecification?: { referenceQuantity?: { unitCode?: string } };
}

interface AppNode {
  '@type': string;
  offers?: Offer[];
  aggregateRating?: unknown;
}

/**
 * Build the payload against a stated commercial status rather than whatever
 * `commercial-status.json` happens to hold today. Both flags are real
 * switches an owner flips, and each one changes what may be advertised.
 */
async function jsonLdWith(flags: { hold: boolean; registration: boolean }) {
  vi.resetModules();
  vi.doMock('@/config/commercialStatus', () => ({
    COMMERCIAL_HOLD_ACTIVE: flags.hold,
    COMMERCIAL_HOLD_EFFECTIVE_DATE: '2026-09-01',
    COMMERCIAL_HOLD_MESSAGE: 'Paid plans are paused.',
    PUBLIC_REGISTRATION_AVAILABLE: flags.registration,
  }));
  const { pricingJsonLd } = await import('@/features/pricing/pricingJsonLd');
  return pricingJsonLd();
}

/** The same, with a translator that returns the key, so a test can read which strings were used. */
async function questionKeysWith(flags: { hold: boolean; registration: boolean }) {
  vi.resetModules();
  vi.doMock('@/config/commercialStatus', () => ({
    COMMERCIAL_HOLD_ACTIVE: flags.hold,
    COMMERCIAL_HOLD_EFFECTIVE_DATE: '2026-09-01',
    COMMERCIAL_HOLD_MESSAGE: 'Paid plans are paused.',
    PUBLIC_REGISTRATION_AVAILABLE: flags.registration,
  }));
  const { pricingJsonLd } = await import('@/features/pricing/pricingJsonLd');
  return faqPairs(pricingJsonLd((key) => key)).map((pair) => pair.question);
}

interface FaqPair {
  question: string;
  answer: string;
}

/** The FAQPage node's questions and answers, in order; empty when there is no node. */
function faqPairs(payload: Record<string, unknown>): FaqPair[] {
  const graph = payload['@graph'] as {
    '@type': string;
    mainEntity?: { name: string; acceptedAnswer: { text: string } }[];
  }[];
  const nodes = graph.filter((node) => node['@type'] === 'FAQPage');
  expect(nodes.length).toBeLessThanOrEqual(1);
  return (nodes[0]?.mainEntity ?? []).map((q) => ({
    question: q.name,
    answer: q.acceptedAnswer.text,
  }));
}

/** Every way the marked-up questions differ from the ones on the page; empty means none. */
function faqFaults(onPage: FaqPair[], markedUp: FaqPair[]): string[] {
  const out: string[] = [];
  if (onPage.length === 0) out.push('the page shows no questions');
  if (onPage.length !== markedUp.length) {
    out.push(`the page shows ${onPage.length} questions, the markup has ${markedUp.length}`);
  }
  onPage.forEach((pair, i) => {
    const other = markedUp[i];
    if (!other) return;
    if (other.question !== pair.question) out.push(`question ${i + 1} is worded differently`);
    if (other.answer !== pair.answer) out.push(`answer ${i + 1} is worded differently`);
  });
  return out;
}

function appNode(payload: Record<string, unknown>): AppNode {
  const graph = payload['@graph'] as AppNode[];
  return graph.find((node) => node['@type'] === 'SoftwareApplication')!;
}

/** Amounts the catalog still carries but no longer sells (ADR 0012). */
const withdrawnAmounts = PLAN_PRICES.flatMap((plan) =>
  plan.withdrawn.flatMap((interval) => {
    const amount =
      interval === 'lifetime' ? plan.lifetime : interval === 'year' ? plan.annual : null;
    return amount === null ? [] : [amount.toFixed(2)];
  })
);

describe('/pricing structured data', () => {
  afterEach(() => {
    vi.doUnmock('@/config/commercialStatus');
    vi.resetModules();
  });

  it('publishes one Offer per cadence that a household may actually start', async () => {
    const payload = await jsonLdWith({ hold: false, registration: true });
    const offers = appNode(payload).offers!;

    // Derived from the price mirror, not restated: the mirror is itself gated
    // against the backend catalog (planPrices.test.ts), so a catalog change
    // reaches this assertion instead of leaving the page quietly wrong.
    const expected = PLAN_PRICES.flatMap((plan) =>
      offeredPrices(plan).map((price) => ({ name: plan.name, price: price.amount.toFixed(2) }))
    );
    expect(offers.map((offer) => ({ name: offer.name, price: offer.price }))).toEqual(expected);
    for (const offer of offers) {
      expect(offer['@type']).toBe('Offer');
      expect(offer.priceCurrency).toBe('USD');
    }
  });

  it('says a subscription recurs, so $2.99 is not read as the price of the software', async () => {
    const payload = await jsonLdWith({ hold: false, registration: true });
    const paid = appNode(payload).offers!.filter((offer) => offer.name !== 'Seedling');

    expect(paid.length).toBeGreaterThan(0);
    for (const offer of paid) {
      // Garden now sells monthly AND yearly (ADR 0042): the unit code must
      // match the amount, so $24.99 is never read as a monthly price.
      const unit = offer.priceSpecification?.referenceQuantity?.unitCode;
      expect(unit).toBe(offer.price === '24.99' ? 'ANN' : 'MON');
    }
    expect(paid.map((o) => o.price)).toEqual(expect.arrayContaining(['2.99', '24.99', '9.99']));
  });

  it('never advertises a cadence that has been withdrawn from sale', async () => {
    // Garden's annual and lifetime prices, and Greenhouse's annual, still
    // exist for the households already on them, and checkout refuses all
    // three. A crawler must not be told otherwise.
    expect(withdrawnAmounts.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(await jsonLdWith({ hold: false, registration: true }));
    for (const amount of withdrawnAmounts) {
      expect(serialized, `a withdrawn cadence is advertised at ${amount}`).not.toContain(amount);
    }
  });

  it('publishes only the free tier while the commercial hold is on', async () => {
    const payload = await jsonLdWith({ hold: true, registration: true });
    const offers = appNode(payload).offers!;

    expect(offers).toHaveLength(1);
    expect(offers[0].name).toBe('Seedling');
    expect(offers[0].price).toBe('0.00');
    // Not one paid amount survives: the page renders the status notice and
    // checkout refuses every paid cadence while the hold is on.
    expect(JSON.stringify(payload)).not.toMatch(/"price":"(?!0\.00")/);
  });

  it('offers nothing at all when the hold is on and registration is closed', async () => {
    const payload = await jsonLdWith({ hold: true, registration: false });
    // The key is absent rather than an empty array: an Offer-less
    // SoftwareApplication is still valid, an empty `offers` is noise.
    expect(appNode(payload).offers).toBeUndefined();
  });

  it('drops the free Offer when nobody may sign up, even with paid plans on sale', async () => {
    const offers = appNode(await jsonLdWith({ hold: false, registration: false })).offers!;
    expect(offers.some((offer) => offer.name === 'Seedling')).toBe(false);
    expect(offers.some((offer) => offer.name === 'Garden')).toBe(true);
  });

  it('claims no rating, because there are no reviews to compute one from', async () => {
    // Google's Software App rich result asks for aggregateRating and this page
    // will likely render as a plain result without it. The alternative is
    // inventing one, which is what got the landing page's testimonials deleted.
    const payload = await jsonLdWith({ hold: false, registration: true });
    expect(appNode(payload).aggregateRating).toBeUndefined();
    expect(JSON.stringify(payload)).not.toMatch(/aggregateRating|ratingValue|reviewCount/);
  });
});

describe('/pricing questions in the structured data', () => {
  afterEach(() => {
    vi.doUnmock('@/config/commercialStatus');
    vi.resetModules();
  });

  it('marks up the buying questions while plans are on sale', async () => {
    expect(await questionKeysWith({ hold: false, registration: true })).toEqual([
      'pricingStatus.freeAccountQuestion',
      'pricingStatus.householdQuestion',
      'pricingStatus.trialQuestion',
      'pricingStatus.cardQuestion',
      'pricingStatus.changeQuestion',
      'pricingStatus.whereQuestion',
      'pricingStatus.dataQuestion',
    ]);
  });

  it('swaps them for the paused-plans questions while the hold is on', async () => {
    const held = await questionKeysWith({ hold: true, registration: true });
    expect(held).toEqual([
      'pricingStatus.freeAccountQuestion',
      'pricingStatus.paidOfferQuestion',
      'pricingStatus.reactivationQuestion',
      'pricingStatus.dataQuestion',
    ]);
    // No trial or card answer is published for plans nobody can buy.
    expect(held).not.toContain('pricingStatus.trialQuestion');
  });

  it('drops the account question when nobody may sign up', async () => {
    const closed = await questionKeysWith({ hold: false, registration: false });
    expect(closed).not.toContain('pricingStatus.freeAccountQuestion');
    expect(closed).toContain('pricingStatus.householdQuestion');
  });

  it('publishes no FAQPage without the page\u2019s own text to put in it', async () => {
    expect(faqPairs(await jsonLdWith({ hold: false, registration: true }))).toEqual([]);
  });
});

describe('PricingPage', () => {
  it('marks up exactly the questions and answers it shows, word for word', async () => {
    const { billingService } = await import('@/services/billingService');
    vi.mocked(billingService.listPlans).mockResolvedValue({
      paymentsAvailable: false,
      commercialHold: { active: false, effectiveDate: '2026-09-01' },
      plans: [],
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <PricingPage />
        </MemoryRouter>
      </QueryClientProvider>
    );

    // What a person reads: every <dt>/<dd> pair on the page, in order.
    const onPage: FaqPair[] = [...container.querySelectorAll('dl > div')].map((row) => ({
      question: row.querySelector('dt')!.textContent!,
      answer: row.querySelector('dd')!.textContent!,
    }));
    const script = document.head.querySelector('script[type="application/ld+json"]');
    const markedUp = faqPairs(JSON.parse(script!.textContent!));

    expect(onPage.length).toBeGreaterThanOrEqual(4);
    // Real sentences, not catalog keys: a missing translation renders its key.
    for (const pair of onPage) {
      expect(pair.question).not.toMatch(/^pricingStatus\./);
      expect(pair.answer).not.toMatch(/^pricingStatus\./);
      expect(pair.answer.length).toBeGreaterThan(20);
    }
    expect(faqFaults(onPage, markedUp)).toEqual([]);

    // Negative controls: each sabotage changes the markup, and each is named.
    const reworded = markedUp.map((pair, i) =>
      i === 1 ? { ...pair, answer: `${pair.answer} Guaranteed.` } : pair
    );
    expect(reworded).not.toEqual(markedUp);
    expect(faqFaults(onPage, reworded)).toEqual(['answer 2 is worded differently']);

    const extra = [...markedUp, { question: 'Is it the best plant app?', answer: 'Yes.' }];
    expect(extra).not.toEqual(markedUp);
    expect(faqFaults(onPage, extra)).toEqual([
      `the page shows ${onPage.length} questions, the markup has ${onPage.length + 1}`,
    ]);

    expect(faqFaults([], [])).toEqual(['the page shows no questions']);
  });

  it('emits the structured data into the head, where a crawler reads it', async () => {
    // The grid's own query is not what is under test here; give it a catalog
    // to settle on so the assertion is about the head and nothing else.
    const { billingService } = await import('@/services/billingService');
    vi.mocked(billingService.listPlans).mockResolvedValue({
      paymentsAvailable: false,
      commercialHold: { active: false, effectiveDate: '2026-09-01' },
      plans: [],
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <PricingPage />
        </MemoryRouter>
      </QueryClientProvider>
    );

    const script = document.head.querySelector('script[type="application/ld+json"]');
    expect(script, '/pricing publishes no structured data at all').not.toBeNull();
    const payload = JSON.parse(script!.textContent!);
    const graph = payload['@graph'] as { '@type': string }[];
    expect(graph.map((node) => node['@type'])).toContain('SoftwareApplication');
    expect(graph.map((node) => node['@type'])).toContain('Organization');
    // True in every commercial state, so this assertion does not move when
    // the hold flips.
    expect(appNode(payload).aggregateRating).toBeUndefined();
  });
});
