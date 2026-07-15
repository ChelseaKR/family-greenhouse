import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('@/services/analytics', () => ({ track: vi.fn() }));

import { api } from '@/services/api';
import { billingService } from '@/services/billingService';

describe('billingService.listPlans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves the status-bearing, price-free API contract', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      data: {
        paymentsAvailable: false,
        commercialHold: { active: true, effectiveDate: '2026-07-14' },
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
      commercialHold: { active: true, effectiveDate: '2026-07-14' },
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
