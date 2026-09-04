import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/householdService.js');
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(async (householdId: string) => ({
    planId: PLAN_BY_HOUSEHOLD[householdId] ?? 'seedling',
  })),
}));

/** Per-test plan lookup for the billing mock. Reset in beforeEach. */
const PLAN_BY_HOUSEHOLD: Record<string, string> = {};

function memberships(...ids: string[]) {
  return ids.map((householdId) => ({
    householdId,
    role: 'member' as const,
    name: 'x',
    joinedAt: '2026-01-01T00:00:00.000Z',
  }));
}

describe('homesGate (ADR 0014: the one per-user cap)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    for (const key of Object.keys(PLAN_BY_HOUSEHOLD)) delete PLAN_BY_HOUSEHOLD[key];
    const householdService = await import('../../../src/services/householdService.js');
    vi.mocked(householdService.getMembershipsByUser).mockResolvedValue([]);
  });

  it('always allows the first home', async () => {
    const { checkHomesLimit } = await import('../../../src/services/homesGate.js');
    const check = await checkHomesLimit('u1');
    expect(check).toMatchObject({ count: 0, limit: 1, allowed: true });
    expect(check.plan.id).toBe('seedling');
  });

  it('refuses a second home to a Seedling user', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    vi.mocked(householdService.getMembershipsByUser).mockResolvedValue(memberships('hh-a'));
    const { checkHomesLimit, assertCanAddHome } =
      await import('../../../src/services/homesGate.js');
    expect(await checkHomesLimit('u1')).toMatchObject({ count: 1, limit: 1, allowed: false });
    await expect(assertCanAddHome('u1')).rejects.toMatchObject({
      name: 'HomesLimitError',
      count: 1,
      limit: 1,
    });
  });

  it('refuses a second home to a Garden user — Garden is one home, unlimited hands', async () => {
    PLAN_BY_HOUSEHOLD['hh-a'] = 'garden';
    const householdService = await import('../../../src/services/householdService.js');
    vi.mocked(householdService.getMembershipsByUser).mockResolvedValue(memberships('hh-a'));
    const { checkHomesLimit } = await import('../../../src/services/homesGate.js');
    const check = await checkHomesLimit('u1');
    expect(check.plan.id).toBe('garden');
    expect(check).toMatchObject({ count: 1, limit: 1, allowed: false });
  });

  it('a Greenhouse member may belong to any number of homes', async () => {
    PLAN_BY_HOUSEHOLD['hh-gh'] = 'greenhouse';
    const householdService = await import('../../../src/services/householdService.js');
    vi.mocked(householdService.getMembershipsByUser).mockResolvedValue(
      memberships('hh-a', 'hh-gh', 'hh-c', 'hh-d')
    );
    const { checkHomesLimit } = await import('../../../src/services/homesGate.js');
    const check = await checkHomesLimit('u1');
    expect(check.plan.id).toBe('greenhouse');
    expect(check).toMatchObject({ count: 4, limit: null, allowed: true });
  });

  it('joining a Greenhouse household is always allowed — its plan counts for the joiner', async () => {
    PLAN_BY_HOUSEHOLD['hh-gh'] = 'greenhouse';
    const householdService = await import('../../../src/services/householdService.js');
    // The joiner already has a free home of their own.
    vi.mocked(householdService.getMembershipsByUser).mockResolvedValue(memberships('hh-mine'));
    const { checkHomesLimit } = await import('../../../src/services/homesGate.js');
    const check = await checkHomesLimit('u1', { joiningHouseholdId: 'hh-gh' });
    expect(check).toMatchObject({ count: 1, limit: null, allowed: true });
  });

  it('joining a Garden household from an existing free home is refused', async () => {
    PLAN_BY_HOUSEHOLD['hh-garden'] = 'garden';
    const householdService = await import('../../../src/services/householdService.js');
    vi.mocked(householdService.getMembershipsByUser).mockResolvedValue(memberships('hh-mine'));
    const { checkHomesLimit } = await import('../../../src/services/homesGate.js');
    const check = await checkHomesLimit('u1', { joiningHouseholdId: 'hh-garden' });
    expect(check).toMatchObject({ count: 1, limit: 1, allowed: false });
  });

  it('grandfathers a user already in several homes: keeps them all, refuses only the next', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const five = memberships('hh-1', 'hh-2', 'hh-3', 'hh-4', 'hh-5');
    vi.mocked(householdService.getMembershipsByUser).mockResolvedValue(five);
    const { checkHomesLimit } = await import('../../../src/services/homesGate.js');
    const check = await checkHomesLimit('u1');
    // Nothing about the five is touched — the gate only reads the count.
    expect(check.count).toBe(5);
    expect(check.allowed).toBe(false);
    expect(householdService.removeMember).not.toHaveBeenCalled();
    expect(householdService.getMembershipsByUser).toHaveBeenCalledTimes(1);
  });

  it('reuses memberships the caller already fetched instead of re-querying', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const { checkHomesLimit } = await import('../../../src/services/homesGate.js');
    await checkHomesLimit('u1', { memberships: memberships('hh-a') });
    expect(householdService.getMembershipsByUser).not.toHaveBeenCalled();
  });

  it('reads each household plan once, even when the joined household is already held', async () => {
    const billing = await import('../../../src/services/billing.js');
    const { checkHomesLimit } = await import('../../../src/services/homesGate.js');
    await checkHomesLimit('u1', {
      memberships: memberships('hh-a', 'hh-b'),
      joiningHouseholdId: 'hh-a',
    });
    expect(billing.getHouseholdSubscription).toHaveBeenCalledTimes(2);
  });

  it('does not re-read the joined household when the caller already knows its plan', async () => {
    const billing = await import('../../../src/services/billing.js');
    const { checkHomesLimit } = await import('../../../src/services/homesGate.js');
    const check = await checkHomesLimit('u1', {
      memberships: memberships('hh-mine'),
      joiningHouseholdId: 'hh-gh',
      joiningPlanId: 'greenhouse',
    });
    expect(billing.getHouseholdSubscription).toHaveBeenCalledTimes(1);
    expect(billing.getHouseholdSubscription).toHaveBeenCalledWith('hh-mine');
    expect(check).toMatchObject({ limit: null, allowed: true });
  });

  it('phrases the refusal with the plan, the cap and the count', async () => {
    const { HomesLimitError, homesLimitMessage } =
      await import('../../../src/services/homesGate.js');
    const { PLANS } = await import('../../../src/models/plans.js');
    expect(homesLimitMessage(new HomesLimitError(1, 1, PLANS.seedling))).toBe(
      'Your Seedling plan includes 1 home and you already belong to 1 household. Upgrade to Greenhouse for unlimited homes.'
    );
    expect(homesLimitMessage(new HomesLimitError(3, 1, PLANS.garden))).toBe(
      'Your Garden plan includes 1 home and you already belong to 3 households. Upgrade to Greenhouse for unlimited homes.'
    );
  });
});
