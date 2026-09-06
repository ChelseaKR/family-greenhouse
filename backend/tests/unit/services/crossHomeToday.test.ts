import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(),
}));
vi.mock('../../../src/services/householdService.js');
vi.mock('../../../src/services/taskService.js');

import * as billing from '../../../src/services/billing.js';
import * as householdService from '../../../src/services/householdService.js';
import * as taskService from '../../../src/services/taskService.js';
import {
  buildCrossHomeToday,
  resolveEntitlement,
  type Membership,
} from '../../../src/services/crossHomeToday.js';
import type { Household, Task } from '../../../src/models/types.js';

type Subscription = Awaited<ReturnType<typeof billing.getHouseholdSubscription>>;
const sub = (planId: string) => ({ planId }) as unknown as Subscription;
const subWithStatus = (planId: string, status: string) =>
  ({ planId, status }) as unknown as Subscription;

const CUTOFF = '2026-09-03T23:59:59.999Z';
const NOW = new Date('2026-09-03T15:30:00.000Z');

function household(id: string, name: string): Household {
  return { id, name, createdAt: '', createdBy: '' };
}

function task(id: string, householdId: string, plantName: string, nextDue: string): Task {
  return {
    id,
    householdId,
    plantId: `plant-${id}`,
    plantName,
    type: 'water',
    customType: null,
    frequency: 7,
    lastCompleted: null,
    nextDue,
    assignedTo: null,
    assignedToName: null,
    assignmentSource: null,
    notes: null,
    createdBy: 'u1',
    createdAt: '',
  };
}

const HOME: Membership = { householdId: 'hh-home', role: 'admin' };
const BEACH: Membership = { householdId: 'hh-beach', role: 'member' };

beforeEach(() => {
  vi.resetAllMocks();
});

describe('resolveEntitlement (per user, across every membership)', () => {
  it('is locked with no memberships at all', async () => {
    expect(await resolveEntitlement([])).toBe('locked');
    expect(billing.getHouseholdSubscription).not.toHaveBeenCalled();
  });

  it('is locked when every household is on a plan without the view', async () => {
    vi.mocked(billing.getHouseholdSubscription)
      .mockResolvedValueOnce(sub('garden'))
      .mockResolvedValueOnce(sub('seedling'));
    expect(await resolveEntitlement([HOME, BEACH])).toBe('locked');
  });

  it('is entitled when ANY household is on greenhouse — the entitlement follows the person', async () => {
    vi.mocked(billing.getHouseholdSubscription)
      .mockResolvedValueOnce(sub('seedling'))
      .mockResolvedValueOnce(sub('greenhouse'));
    expect(await resolveEntitlement([HOME, BEACH])).toBe('entitled');
  });

  it('is unverifiable, not locked, when a plan read fails and nothing else grants it', async () => {
    vi.mocked(billing.getHouseholdSubscription)
      .mockRejectedValueOnce(new Error('ddb down'))
      .mockResolvedValueOnce(sub('seedling'));
    expect(await resolveEntitlement([HOME, BEACH])).toBe('unverifiable');
  });

  it('is still entitled when a plan read fails but another household grants it', async () => {
    vi.mocked(billing.getHouseholdSubscription)
      .mockRejectedValueOnce(new Error('ddb down'))
      .mockResolvedValueOnce(sub('greenhouse'));
    expect(await resolveEntitlement([HOME, BEACH])).toBe('entitled');
  });

  it('falls back to the free tier for an unknown plan id (getPlan semantics)', async () => {
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce(sub('enterprise'));
    expect(await resolveEntitlement([HOME])).toBe('locked');
  });

  // #476: entitlement consults payment status, not `planId` alone. Stripe does
  // not cancel on a failed charge — it retries for weeks, and `planId` stays on
  // the paid tier the whole time.
  it('is locked, not entitled, for a household whose card has failed', async () => {
    for (const status of ['past_due', 'unpaid', 'incomplete', 'canceled'] as const) {
      vi.mocked(billing.getHouseholdSubscription).mockReset();
      vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce(
        subWithStatus('greenhouse', status)
      );
      expect(await resolveEntitlement([HOME])).toBe('locked');
    }
  });

  it('stays entitled through the statuses that still grant the plan', async () => {
    for (const status of ['active', 'trialing'] as const) {
      vi.mocked(billing.getHouseholdSubscription).mockReset();
      vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce(
        subWithStatus('greenhouse', status)
      );
      expect(await resolveEntitlement([HOME])).toBe('entitled');
    }
    // An ABSENT status is entitled on purpose (entitlementIsCurrent): it means
    // no subscription state was ever recorded, not that payment failed.
    vi.mocked(billing.getHouseholdSubscription).mockReset();
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce(sub('greenhouse'));
    expect(await resolveEntitlement([HOME])).toBe('entitled');
  });

  it('keeps a lifetime owner entitled whatever a later subscription status says', async () => {
    // A one-time purchase is an entitlement FLOOR with no refund path; a
    // cancelled subscription taken on top of it must not destroy it.
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({
      planId: 'seedling',
      status: 'canceled',
      lifetimePlanId: 'greenhouse',
    } as unknown as Subscription);
    expect(await resolveEntitlement([HOME])).toBe('entitled');
  });

  it('still says unverifiable — not locked — when the read itself fails', async () => {
    // The #476 conversion must not turn "we could not check" into "you do not
    // have it": that is the defect it is meant to avoid, pointed the other way.
    vi.mocked(billing.getHouseholdSubscription).mockRejectedValueOnce(new Error('ddb down'));
    expect(await resolveEntitlement([HOME])).toBe('unverifiable');
  });
});

describe('buildCrossHomeToday', () => {
  it('groups by household, names every row, keeps each membership role, and filters to the cutoff', async () => {
    vi.mocked(householdService.getHousehold).mockImplementation(async (id) =>
      id === 'hh-home' ? household('hh-home', 'Home') : household('hh-beach', 'Beach Cottage')
    );
    vi.mocked(taskService.getUpcomingTasks).mockImplementation(async (id) =>
      id === 'hh-home'
        ? [task('t-monstera', 'hh-home', 'Monstera', '2026-09-03T09:00:00.000Z')]
        : [
            task('t-fern', 'hh-beach', 'Fern', '2026-09-01T09:00:00.000Z'), // overdue
            task('t-cactus', 'hh-beach', 'Cactus', '2026-09-08T09:00:00.000Z'), // next week: out
          ]
    );

    const result = await buildCrossHomeToday([HOME, BEACH], CUTOFF, NOW);

    expect(result.generatedAt).toBe(NOW.toISOString());
    expect(result.cutoff).toBe(CUTOFF);
    expect(result.households.map((h) => h.householdId)).toEqual(['hh-home', 'hh-beach']);

    const [home, beach] = result.households;
    expect(home).toMatchObject({ name: 'Home', role: 'admin', status: 'ok' });
    expect(beach).toMatchObject({ name: 'Beach Cottage', role: 'member', status: 'ok' });
    if (home.status !== 'ok' || beach.status !== 'ok') throw new Error('expected ok groups');
    expect(home.tasks.map((t) => t.id)).toEqual(['t-monstera']);
    expect(beach.tasks.map((t) => t.id)).toEqual(['t-fern']);
    // The home is on every row, not only on the group.
    for (const row of home.tasks) expect(row.householdName).toBe('Home');
    for (const row of beach.tasks) expect(row.householdName).toBe('Beach Cottage');
    // Grouped, never merged: there is no flat list in the contract.
    expect((result as unknown as { tasks?: unknown }).tasks).toBeUndefined();
  });

  it('returns a household whose reads fail as an explicit unavailable entry and keeps the others', async () => {
    vi.mocked(householdService.getHousehold).mockImplementation(async (id) => {
      if (id === 'hh-beach') throw new Error('throttled');
      return household('hh-home', 'Home');
    });
    vi.mocked(taskService.getUpcomingTasks).mockImplementation(async (id) => {
      if (id === 'hh-beach') throw new Error('throttled');
      return [task('t-monstera', 'hh-home', 'Monstera', '2026-09-03T09:00:00.000Z')];
    });

    const result = await buildCrossHomeToday([HOME, BEACH], CUTOFF, NOW);

    expect(result.households).toHaveLength(2);
    expect(result.households[0]).toMatchObject({ householdId: 'hh-home', status: 'ok' });
    expect(result.households[1]).toEqual({
      householdId: 'hh-beach',
      name: null,
      role: 'member',
      status: 'unavailable',
    });
    // Never an empty task list standing in for a failed read.
    expect('tasks' in result.households[1]).toBe(false);
  });

  it('keeps the name on an unavailable entry when only the task read failed', async () => {
    vi.mocked(householdService.getHousehold).mockResolvedValue(
      household('hh-beach', 'Beach Cottage')
    );
    vi.mocked(taskService.getUpcomingTasks).mockRejectedValue(new Error('gsi throttled'));

    const result = await buildCrossHomeToday([BEACH], CUTOFF, NOW);

    expect(result.households).toEqual([
      { householdId: 'hh-beach', name: 'Beach Cottage', role: 'member', status: 'unavailable' },
    ]);
  });

  it('treats a membership whose household row is missing as unavailable, not as empty', async () => {
    vi.mocked(householdService.getHousehold).mockResolvedValue(null);
    vi.mocked(taskService.getUpcomingTasks).mockResolvedValue([]);

    const result = await buildCrossHomeToday([BEACH], CUTOFF, NOW);

    expect(result.households).toEqual([
      { householdId: 'hh-beach', name: null, role: 'member', status: 'unavailable' },
    ]);
  });

  it('turns an unexpected throw inside one household into that household’s unavailable entry', async () => {
    vi.mocked(householdService.getHousehold).mockResolvedValue(
      household('hh-beach', 'Beach Cottage')
    );
    // A malformed task read: not an array, so the row mapping itself throws.
    vi.mocked(taskService.getUpcomingTasks).mockResolvedValue(undefined as never);

    const result = await buildCrossHomeToday([BEACH], CUTOFF, NOW);

    expect(result.households).toEqual([
      { householdId: 'hh-beach', name: null, role: 'member', status: 'unavailable' },
    ]);
  });

  it('yields no groups for no memberships (and never a flat list)', async () => {
    const result = await buildCrossHomeToday([], CUTOFF, NOW);
    expect(result.households).toEqual([]);
    expect(householdService.getHousehold).not.toHaveBeenCalled();
  });
});
