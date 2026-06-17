/**
 * Seeding helpers for the real-handler integration suite.
 *
 * These write household / member / plant rows into the in-memory DynamoDB
 * using the SAME row shapes the production services write (PK/SK/GSI keys,
 * counters). We seed by going through the real service functions where
 * practical so the seeded data can never drift from what the handlers expect;
 * `createHousehold` and `addMember` both write exactly the rows the auth
 * middleware and resource handlers read back.
 *
 * Import this AFTER the test file has `vi.mock`-ed `utils/dynamodb.js` to point
 * at the in-memory store (otherwise the services would bind the real client).
 */
import type { InMemoryDynamo } from './inMemoryDynamo.js';

export interface SeededMember {
  userId: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
}

export interface SeededHousehold {
  householdId: string;
  members: SeededMember[];
}

/**
 * Create a household with an admin creator plus any extra members, and reset
 * the membership cache so the auth middleware re-reads fresh rows. Returns the
 * household id and the seeded member list. Uses the real householdService so
 * the rows match production exactly.
 */
export async function seedHousehold(
  store: InMemoryDynamo,
  opts: {
    name?: string;
    admin: Omit<SeededMember, 'role'>;
    members?: Array<Omit<SeededMember, 'role'> & { role?: 'admin' | 'member' }>;
    /** Plan member cap passed to addMember (defaults high enough to not trip). */
    maxMembers?: number;
  }
): Promise<SeededHousehold> {
  const householdService = await import('../../../src/services/householdService.js');
  const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');

  const household = await householdService.createHousehold(
    { name: opts.name ?? 'Test Household' },
    opts.admin.userId,
    opts.admin.name,
    opts.admin.email
  );

  const members: SeededMember[] = [{ ...opts.admin, role: 'admin' }];

  for (const m of opts.members ?? []) {
    await householdService.addMember(
      household.id,
      m.userId,
      m.name,
      m.email,
      opts.maxMembers ?? 100,
      m.role ?? 'member'
    );
    members.push({ userId: m.userId, email: m.email, name: m.name, role: m.role ?? 'member' });
  }

  __resetMembershipCacheForTests();

  return { householdId: household.id, members };
}

/**
 * Set the household's plan by writing planId onto the METADATA row. The
 * default (no row attribute) resolves to the free "seedling" plan (10-plant
 * cap), so call this only when a test needs a different tier.
 */
export async function setHouseholdPlan(
  store: InMemoryDynamo,
  householdId: string,
  planId: string
): Promise<void> {
  const all = store.all();
  const meta = all.find((i) => i.PK === `HOUSEHOLD#${householdId}` && i.SK === 'METADATA');
  if (!meta) throw new Error(`No METADATA row for household ${householdId}`);
  store.put({ ...meta, planId });
}

/** Seed an active plant row directly via the real plantService. */
export async function seedPlant(
  _store: InMemoryDynamo,
  householdId: string,
  userId: string,
  input: { name: string; species?: string; location?: string },
  maxPlants = 5000
): Promise<{ id: string }> {
  const plantService = await import('../../../src/services/plantService.js');
  const plant = await plantService.createPlant(
    { name: input.name, species: input.species, location: input.location },
    householdId,
    userId,
    maxPlants
  );
  return { id: plant.id };
}
