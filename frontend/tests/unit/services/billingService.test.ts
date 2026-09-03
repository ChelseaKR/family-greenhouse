import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('@/services/analytics', () => ({ track: vi.fn(), setTelemetryAuthToken: vi.fn() }));

import { api } from '@/services/api';
import { track } from '@/services/analytics';
import { billingService, evaluatePlanLimits } from '@/services/billingService';

describe('billingService.listPlans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves the status-bearing, price-free API contract', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      data: {
        paymentsAvailable: false,
        commercialHold: { active: false, effectiveDate: '2026-09-01' },
        plans: [
          {
            id: 'garden',
            name: 'Garden',
            description: 'For growing families',
            maxPlants: 500,
            maxMembers: 6,
          },
        ],
      },
    });

    await expect(billingService.listPlans()).resolves.toMatchObject({
      paymentsAvailable: false,
      plans: [{ id: 'garden' }],
    });
  });

  it('fails closed and strips prices from the legacy array during a rolling deploy', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      data: [
        {
          id: 'garden',
          name: 'Garden',
          description: 'For growing families',
          monthlyPrice: 4.99,
          annualPrice: 39.99,
          lifetimePrice: 149,
          maxPlants: 500,
          maxMembers: 6,
        },
      ],
    });

    const catalog = await billingService.listPlans();
    expect(catalog).toMatchObject({
      paymentsAvailable: false,
      commercialHold: { active: false, effectiveDate: '2026-09-01' },
    });
    expect(catalog.plans).toEqual([
      {
        id: 'garden',
        name: 'Garden',
        description: 'For growing families',
        maxPlants: 500,
        maxMembers: 6,
      },
    ]);
    expect(catalog.plans[0]).not.toHaveProperty('monthlyPrice');
    expect(catalog.plans[0]).not.toHaveProperty('annualPrice');
    expect(catalog.plans[0]).not.toHaveProperty('lifetimePrice');
  });
});

describe('billingService.createCheckout upgrade-intent event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records upgrade intent with closed-enum properties once the session exists', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ data: { url: 'https://checkout.stripe.test/s' } });

    await billingService.createCheckout({
      planId: 'greenhouse',
      interval: 'year',
      checkoutAttemptId: 'attempt-1',
    });

    expect(track).toHaveBeenCalledWith('subscription_upgraded', {
      upgradeTo: 'greenhouse',
      interval: 'year',
    });
  });

  it('does not record intent when checkout never opened', async () => {
    // The server re-checks the commercial gate and answers 503 when payment
    // activity is off. A blocked attempt is not a checkout the user reached,
    // so counting it would inflate the intent step of the funnel.
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Request failed with status code 503'));

    await expect(
      billingService.createCheckout({
        planId: 'garden',
        interval: 'month',
        checkoutAttemptId: 'attempt-2',
      })
    ).rejects.toThrow();

    expect(track).not.toHaveBeenCalled();
  });
});

describe('evaluatePlanLimits with an unlimited cap (ADR 0014)', () => {
  it('never reports "over" against a cap of null, however large the count', () => {
    // `null` is unlimited on the wire. A numeric comparison against it
    // coerces to 0 and would report every Garden household with a single
    // member as over its limit.
    expect(
      evaluatePlanLimits({
        plantCount: 12,
        maxPlants: 200,
        memberCount: 40,
        maxMembers: null,
      })
    ).toEqual({ plants: 'within', members: 'within', overall: 'within' });
  });

  it('keeps an unknown COUNTER unknown while an unlimited CAP stays within', () => {
    // Two different nulls: a null count is "we could not read it", a null cap
    // is "there is no ceiling". Conflating them would either invent a limit
    // breach or claim a reading we do not have.
    expect(
      evaluatePlanLimits({
        plantCount: null,
        maxPlants: 200,
        memberCount: 9,
        maxMembers: null,
      })
    ).toEqual({ plants: 'unknown', members: 'within', overall: 'unknown' });
  });

  it('still reports a genuine overage on a capped dimension (grandfathered household)', () => {
    // A household carried over the new plant cap keeps every plant; the UI
    // says so, and the server blocks only the next add.
    expect(
      evaluatePlanLimits({
        plantCount: 300,
        maxPlants: 200,
        memberCount: 4,
        maxMembers: null,
      })
    ).toEqual({ plants: 'over', members: 'within', overall: 'over' });
  });
});

describe('billingService.listPlans legacy-array fallback', () => {
  it('carries limits and features through when the old array shape still has them', async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: [
        {
          id: 'garden',
          name: 'Garden',
          description: 'A household that has to coordinate',
          maxPlants: 200,
          maxMembers: null,
          limits: { members: null },
          features: { chat: true },
          monthlyPrice: 4.99,
        },
      ],
    });
    const catalog = await billingService.listPlans();
    expect(catalog.paymentsAvailable).toBe(false);
    expect(catalog.plans[0]).toMatchObject({
      maxMembers: null,
      limits: { members: null },
      features: { chat: true },
    });
    // The fallback still refuses to publish an amount.
    expect(catalog.plans[0]).not.toHaveProperty('monthlyPrice');
  });
});
