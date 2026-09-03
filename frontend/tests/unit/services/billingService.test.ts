import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('@/services/analytics', () => ({ track: vi.fn(), setTelemetryAuthToken: vi.fn() }));

import { api } from '@/services/api';
import { track } from '@/services/analytics';
import { billingService } from '@/services/billingService';

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
