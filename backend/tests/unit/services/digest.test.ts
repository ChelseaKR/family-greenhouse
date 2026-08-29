import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  DeleteCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/services/householdService.js', () => ({
  getHouseholdMembers: vi.fn(),
  listAllHouseholdIds: vi.fn(),
}));
vi.mock('../../../src/services/taskService.js', () => ({
  getTasksDueBy: vi.fn(),
  getYearInReview: vi.fn(),
}));
vi.mock('../../../src/services/plantService.js', () => ({
  getPlants: vi.fn(),
}));
vi.mock('../../../src/services/notificationPrefs.js', () => ({
  getPreferences: vi.fn(),
  isInDndWindow: vi.fn(() => false),
}));
vi.mock('../../../src/services/emailNotifier.js', () => ({
  // Resolves true = a real delivery (sendEmail returns false only on a dry-run).
  sendEmail: vi.fn().mockResolvedValue(true),
}));

const NOW = new Date('2026-06-11T12:00:00.000Z'); // Thursday, ISO week 2026-W24
const DAY = 24 * 60 * 60 * 1000;
const overdueBy = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const memberA = {
  householdId: 'hh',
  userId: 'u1',
  name: 'A',
  email: 'a@x.com',
  role: 'admin' as const,
  joinedAt: '',
};
const memberB = {
  householdId: 'hh',
  userId: 'u2',
  name: 'B',
  email: 'b@x.com',
  role: 'member' as const,
  joinedAt: '',
};

async function mockActivePlants(plants: Array<{ id: string; name: string }>) {
  const plantService = await import('../../../src/services/plantService.js');
  vi.mocked(plantService.getPlants).mockResolvedValue(plants as never);
}

async function mockPrefs(byUser: Record<string, { email?: boolean; weeklyDigest?: boolean }>) {
  const prefs = await import('../../../src/services/notificationPrefs.js');
  vi.mocked(prefs.getPreferences).mockImplementation(
    async (userId: string) => ({ email: true, weeklyDigest: true, ...byUser[userId] }) as never
  );
}

/** Same conditional-put simulation as reminders.test.ts: second Put on a
 *  PK|SK throws ConditionalCheckFailed, which is what the dedupe relies on. */
async function mockConditionalMarkerStore() {
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  const markers = new Set<string>();
  vi.mocked(dynamodb.send).mockImplementation(async (cmd: unknown) => {
    const { input, kind } = cmd as {
      kind?: 'Put' | 'Get' | 'Delete' | 'Update';
      input: { Item?: { PK: string; SK: string }; Key?: { PK: string; SK: string } };
    };
    // GetCommand: the cheap "already digested this week?" pre-check read.
    if (kind === 'Get' && input.Key) {
      const key = `${input.Key.PK}|${input.Key.SK}`;
      return {
        Item: markers.has(key) ? { PK: input.Key.PK, SK: input.Key.SK } : undefined,
      } as never;
    }
    if (kind === 'Delete' && input.Key) {
      markers.delete(`${input.Key.PK}|${input.Key.SK}`);
      return {} as never;
    }
    if (kind === 'Update' && input.Key) {
      return {} as never;
    }
    // PutCommand: the conditional slot claim — a second Put on the same PK|SK
    // throws ConditionalCheckFailed (what the dedupe relies on).
    const key = `${input.Item!.PK}|${input.Item!.SK}`;
    if (markers.has(key)) {
      const err = new Error('The conditional request failed');
      err.name = 'ConditionalCheckFailedException';
      throw err;
    }
    markers.add(key);
    return {} as never;
  });
  return markers;
}

describe('digest service', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('computePlantsAtRisk', () => {
    it('counts CALENDAR days overdue, not elapsed 24h spans (#342 item 4)', async () => {
      const tasks = await import('../../../src/services/taskService.js');
      const { computePlantsAtRisk } = await import('../../../src/services/digest.js');
      await mockActivePlants([{ id: 'p1', name: 'Monstera' }]);
      // Due Wed Jun 10 at 23:00Z; the digest runs Thu Jun 11 at 12:00Z.
      // Thirteen hours elapsed, but it is the NEXT CALENDAR DAY — which is
      // what the task list tells the user ("1 day overdue"). The old
      // `floor(elapsed / 24h)` scored this 0 and `overduePhrase(0)` called it
      // "ready for a little care today", contradicting the app on the same
      // task and under-reporting the neglect.
      vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
        { plantId: 'p1', type: 'water', customType: null, nextDue: '2026-06-10T23:00:00.000Z' },
      ] as never);

      const result = await computePlantsAtRisk('hh', NOW);
      expect(result[0].daysOverdue).toBe(1);
    });

    it('still reports 0 for a task due earlier on the SAME calendar day', async () => {
      const tasks = await import('../../../src/services/taskService.js');
      const { computePlantsAtRisk } = await import('../../../src/services/digest.js');
      await mockActivePlants([{ id: 'p1', name: 'Monstera' }]);
      // Due 01:00Z, digested 12:00Z the same day: genuinely "today".
      vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
        { plantId: 'p1', type: 'water', customType: null, nextDue: '2026-06-11T01:00:00.000Z' },
      ] as never);

      const result = await computePlantsAtRisk('hh', NOW);
      expect(result[0].daysOverdue).toBe(0);
    });

    it('resolves the calendar day in the zone it is given', async () => {
      const tasks = await import('../../../src/services/taskService.js');
      const { computePlantsAtRisk } = await import('../../../src/services/digest.js');
      await mockActivePlants([{ id: 'p1', name: 'Monstera' }]);
      // 2026-06-10T23:00Z is Jun 10, 19:00 EDT and the run instant
      // 2026-06-11T12:00Z is Jun 11, 08:00 EDT — still one calendar day in
      // New York, same as in UTC. Pinning it here so the zone parameter is
      // exercised rather than merely accepted.
      vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
        { plantId: 'p1', type: 'water', customType: null, nextDue: '2026-06-10T23:00:00.000Z' },
      ] as never);

      const result = await computePlantsAtRisk('hh', NOW, 'America/New_York');
      expect(result[0].daysOverdue).toBe(1);
    });

    it('ranks plants by their MAX days overdue across tasks, with task type + days', async () => {
      const tasks = await import('../../../src/services/taskService.js');
      const { computePlantsAtRisk } = await import('../../../src/services/digest.js');
      await mockActivePlants([
        { id: 'p1', name: 'Monstera' },
        { id: 'p2', name: 'Fern' },
      ]);
      vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
        // p1: two overdue tasks — the 7-day water (not the 2-day prune) wins.
        { plantId: 'p1', type: 'water', customType: null, nextDue: overdueBy(7) },
        { plantId: 'p1', type: 'prune', customType: null, nextDue: overdueBy(2) },
        // p2: a custom task overdue 10 days — ranked first, custom label used.
        { plantId: 'p2', type: 'custom', customType: 'mist', nextDue: overdueBy(10) },
      ] as never);

      const result = await computePlantsAtRisk('hh', NOW);
      expect(result).toEqual([
        { plantId: 'p2', plantName: 'Fern', taskType: 'mist', daysOverdue: 10 },
        { plantId: 'p1', plantName: 'Monstera', taskType: 'water', daysOverdue: 7 },
      ]);
      // Cutoff = now ⇒ the query itself returns only overdue tasks.
      expect(tasks.getTasksDueBy).toHaveBeenCalledWith('hh', NOW.toISOString());
    });

    it('returns EVERY at-risk plant ranked, uncapped — the cap is the composer’s job', async () => {
      const tasks = await import('../../../src/services/taskService.js');
      const { computePlantsAtRisk } = await import('../../../src/services/digest.js');
      const plants = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, name: `Plant ${i}` }));
      await mockActivePlants(plants);
      vi.mocked(tasks.getTasksDueBy).mockResolvedValue(
        plants.map((p, i) => ({
          plantId: p.id,
          type: 'water',
          customType: null,
          nextDue: overdueBy(i + 1),
        })) as never
      );

      // This used to `.slice(0, 5)` here, which made the returned length a
      // number that could never exceed 5 — and composeDigestEmail then built
      // the subject from it. The count must stay true; only the email body
      // is allowed to show a subset.
      const result = await computePlantsAtRisk('hh', NOW);
      expect(result).toHaveLength(7);
      expect(result.map((r) => r.daysOverdue)).toEqual([7, 6, 5, 4, 3, 2, 1]); // ranked
    });

    it('returns [] when nothing is overdue, without reading plants', async () => {
      const tasks = await import('../../../src/services/taskService.js');
      const plantService = await import('../../../src/services/plantService.js');
      const { computePlantsAtRisk } = await import('../../../src/services/digest.js');
      vi.mocked(tasks.getTasksDueBy).mockResolvedValue([] as never);

      expect(await computePlantsAtRisk('hh', NOW)).toEqual([]);
      expect(plantService.getPlants).not.toHaveBeenCalled();
    });

    it('ignores overdue tasks for non-active (died/gave-away) plants', async () => {
      const tasks = await import('../../../src/services/taskService.js');
      const { computePlantsAtRisk } = await import('../../../src/services/digest.js');
      await mockActivePlants([{ id: 'p1', name: 'Monstera' }]); // dead plant absent
      vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
        { plantId: 'dead', type: 'water', customType: null, nextDue: overdueBy(30) },
        { plantId: 'p1', type: 'water', customType: null, nextDue: overdueBy(1) },
      ] as never);

      const result = await computePlantsAtRisk('hh', NOW);
      expect(result.map((r) => r.plantId)).toEqual(['p1']);
    });
  });

  describe('composeDigestEmail', () => {
    it('lists each plant with task type and days overdue, most overdue first', async () => {
      const { composeDigestEmail } = await import('../../../src/services/digest.js');
      const { subject, text } = composeDigestEmail([
        { plantId: 'p2', plantName: 'Fern', taskType: 'mist', daysOverdue: 10 },
        { plantId: 'p1', plantName: 'Monstera', taskType: 'water', daysOverdue: 1 },
        { plantId: 'p3', plantName: 'Cactus', taskType: 'repot', daysOverdue: 0 },
      ]);
      expect(subject).toBe('Weekly digest: 3 plants could use some care');
      expect(text).toContain('1. Fern — mist waiting 10 days for some care');
      expect(text).toContain('2. Monstera — water waiting a day for some care');
      expect(text).toContain('3. Cactus — repot ready for a little care today');
      // Nothing was withheld, so the body must not imply it was.
      expect(text).not.toContain('waiting longest:');
    });

    /**
     * Regression: the subject line counted the LISTED plants, not the
     * at-risk plants. Because the list was capped at 5 by construction, a
     * household with 23 neglected plants was told "5 plants could use some
     * care" — false, and false in the reassuring direction, which is the
     * dangerous one for a care-reminder product.
     */
    it('states the TRUE at-risk total in the subject, not the number of rows listed', async () => {
      const { composeDigestEmail } = await import('../../../src/services/digest.js');
      const atRisk = Array.from({ length: 23 }, (_, i) => ({
        plantId: `p${i}`,
        plantName: `Plant ${i}`,
        taskType: 'water',
        daysOverdue: 23 - i,
      }));

      const { subject, text } = composeDigestEmail(atRisk);

      expect(subject).toBe('Weekly digest: 23 plants could use some care');
      expect(subject).not.toContain('5 plants');
      // The body still lists only the top 5 — and says so, so the subject's
      // 23 and the five rows below it don't read as a contradiction.
      expect(text).toContain('23 plants could use some catch-up care. Here are the 5 waiting');
      expect(text).toContain('1. Plant 0 — water waiting 23 days for some care');
      expect(text).toContain('5. Plant 4 — water waiting 19 days for some care');
      expect(text).not.toContain('6. Plant 5');
    });

    it('keeps subject and body agreeing when a household has exactly one at-risk plant', async () => {
      const { composeDigestEmail } = await import('../../../src/services/digest.js');
      const { subject, text } = composeDigestEmail([
        { plantId: 'p1', plantName: 'Monstera', taskType: 'water', daysOverdue: 4 },
      ]);
      expect(subject).toBe('Weekly digest: 1 plant could use some care');
      expect(text).toContain('1 plant could use some catch-up care');
      expect(text).toContain('1. Monstera — water waiting 4 days for some care');
    });
  });

  describe('weekly digest run', () => {
    async function setupOneOverduePlant() {
      const tasks = await import('../../../src/services/taskService.js');
      await mockActivePlants([{ id: 'p1', name: 'Monstera' }]);
      vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
        { plantId: 'p1', type: 'water', customType: null, nextDue: overdueBy(3) },
      ] as never);
    }

    it('sends to members with email + weeklyDigest enabled, skips others', async () => {
      const household = await import('../../../src/services/householdService.js');
      const email = await import('../../../src/services/emailNotifier.js');
      const { digestHousehold } = await import('../../../src/services/digest.js');
      await mockConditionalMarkerStore();
      await setupOneOverduePlant();
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA, memberB] as never);
      await mockPrefs({ u1: {}, u2: { weeklyDigest: false } });

      const sent = await digestHousehold('hh', NOW);
      expect(sent).toBe(1);
      expect(email.sendEmail).toHaveBeenCalledOnce();
      expect(vi.mocked(email.sendEmail).mock.calls[0][0].to).toBe('a@x.com');
    });

    /** End-to-end guard on the same defect: whatever the cap is, the count a
     *  real household receives must be the count of its at-risk plants. */
    it('emails the true at-risk count for a household well past the display cap', async () => {
      const tasks = await import('../../../src/services/taskService.js');
      const household = await import('../../../src/services/householdService.js');
      const email = await import('../../../src/services/emailNotifier.js');
      const { digestHousehold } = await import('../../../src/services/digest.js');
      await mockConditionalMarkerStore();
      const plants = Array.from({ length: 23 }, (_, i) => ({ id: `p${i}`, name: `Plant ${i}` }));
      await mockActivePlants(plants);
      vi.mocked(tasks.getTasksDueBy).mockResolvedValue(
        plants.map((p, i) => ({
          plantId: p.id,
          type: 'water',
          customType: null,
          nextDue: overdueBy(i + 1),
        })) as never
      );
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
      await mockPrefs({ u1: {} });

      expect(await digestHousehold('hh', NOW)).toBe(1);
      const { subject, text } = vi.mocked(email.sendEmail).mock.calls[0][0];
      expect(subject).toBe('Weekly digest: 23 plants could use some care');
      expect(text).toContain('23 plants could use some catch-up care. Here are the 5 waiting');
    });

    it('atomically reserves before SES so overlapping digest runs send once', async () => {
      const household = await import('../../../src/services/householdService.js');
      const email = await import('../../../src/services/emailNotifier.js');
      const { digestHousehold } = await import('../../../src/services/digest.js');
      await mockConditionalMarkerStore();
      await setupOneOverduePlant();
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
      await mockPrefs({ u1: {} });

      let acceptDelivery!: () => void;
      vi.mocked(email.sendEmail).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            acceptDelivery = () => resolve(true);
          })
      );
      const first = digestHousehold('hh', NOW);
      await vi.waitFor(() => expect(email.sendEmail).toHaveBeenCalledOnce());
      const second = digestHousehold('hh', NOW);
      await vi.waitFor(() => expect(household.getHouseholdMembers).toHaveBeenCalledTimes(2));
      acceptDelivery();

      expect(await Promise.all([first, second])).toEqual([1, 0]);
      expect(email.sendEmail).toHaveBeenCalledOnce();
    });

    it('skips members whose email channel is off even if weeklyDigest is on', async () => {
      const household = await import('../../../src/services/householdService.js');
      const email = await import('../../../src/services/emailNotifier.js');
      const { digestHousehold } = await import('../../../src/services/digest.js');
      await mockConditionalMarkerStore();
      await setupOneOverduePlant();
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
      await mockPrefs({ u1: { email: false, weeklyDigest: true } });

      expect(await digestHousehold('hh', NOW)).toBe(0);
      expect(email.sendEmail).not.toHaveBeenCalled();
    });

    it('defers a weekly digest during quiet hours without burning its marker', async () => {
      const household = await import('../../../src/services/householdService.js');
      const prefs = await import('../../../src/services/notificationPrefs.js');
      const email = await import('../../../src/services/emailNotifier.js');
      const { digestHousehold } = await import('../../../src/services/digest.js');
      const markers = await mockConditionalMarkerStore();
      await setupOneOverduePlant();
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
      await mockPrefs({ u1: {} });
      vi.mocked(prefs.isInDndWindow).mockReturnValueOnce(true).mockReturnValueOnce(false);

      expect(await digestHousehold('hh', NOW)).toBe(0);
      expect(markers.size).toBe(0);
      expect(email.sendEmail).not.toHaveBeenCalled();

      expect(await digestHousehold('hh', new Date(NOW.getTime() + 6 * 60 * 60 * 1000))).toBe(1);
      expect(email.sendEmail).toHaveBeenCalledOnce();
    });

    it('skips households with nothing overdue without reading members', async () => {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const email = await import('../../../src/services/emailNotifier.js');
      const { digestHousehold } = await import('../../../src/services/digest.js');
      vi.mocked(tasks.getTasksDueBy).mockResolvedValue([] as never);

      expect(await digestHousehold('hh', NOW)).toBe(0);
      expect(household.getHouseholdMembers).not.toHaveBeenCalled();
      expect(email.sendEmail).not.toHaveBeenCalled();
    });

    it('dedupes per user and household per ISO week; a new week sends again', async () => {
      const household = await import('../../../src/services/householdService.js');
      const email = await import('../../../src/services/emailNotifier.js');
      const { digestHousehold } = await import('../../../src/services/digest.js');
      const markers = await mockConditionalMarkerStore();
      await setupOneOverduePlant();
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
      await mockPrefs({ u1: {} });

      // First run this week: sends and claims the W24 slot.
      expect(await digestHousehold('hh', NOW)).toBe(1);
      expect(markers.has('USER#u1|DIGEST#2026-W24#HOUSEHOLD#hh')).toBe(true);

      // Retry two days later, same ISO week: deduped.
      expect(await digestHousehold('hh', new Date(NOW.getTime() + 2 * DAY))).toBe(0);
      expect(email.sendEmail).toHaveBeenCalledOnce();

      // Next week (NOW is Thursday; +7d lands in W25): sends again.
      expect(await digestHousehold('hh', new Date(NOW.getTime() + 7 * DAY))).toBe(1);
      expect(email.sendEmail).toHaveBeenCalledTimes(2);
    });

    it('sends distinct weekly summaries for a user who belongs to two households', async () => {
      const household = await import('../../../src/services/householdService.js');
      const email = await import('../../../src/services/emailNotifier.js');
      const { digestHousehold } = await import('../../../src/services/digest.js');
      const markers = await mockConditionalMarkerStore();
      await setupOneOverduePlant();
      vi.mocked(household.getHouseholdMembers).mockImplementation(async (householdId: string) => [
        { ...memberA, householdId },
      ]);
      await mockPrefs({ u1: {} });

      expect(await digestHousehold('home', NOW)).toBe(1);
      expect(await digestHousehold('cabin', NOW)).toBe(1);
      expect(email.sendEmail).toHaveBeenCalledTimes(2);
      expect(markers.has('USER#u1|DIGEST#2026-W24#HOUSEHOLD#home')).toBe(true);
      expect(markers.has('USER#u1|DIGEST#2026-W24#HOUSEHOLD#cabin')).toBe(true);
    });

    it('runWeeklyDigests scans every household and survives one failing', async () => {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const email = await import('../../../src/services/emailNotifier.js');
      const { runWeeklyDigests } = await import('../../../src/services/digest.js');
      await mockConditionalMarkerStore();
      await mockActivePlants([{ id: 'p1', name: 'Monstera' }]);
      await mockPrefs({ u1: {} });

      vi.mocked(household.listAllHouseholdIds).mockResolvedValue(['hhA', 'hhB']);
      vi.mocked(tasks.getTasksDueBy).mockImplementation((id: string) => {
        if (id === 'hhA') throw new Error('boom');
        return Promise.resolve([
          { plantId: 'p1', type: 'water', customType: null, nextDue: overdueBy(1) },
        ] as never);
      });
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([
        { ...memberA, householdId: 'hhB' },
      ] as never);

      const result = await runWeeklyDigests(NOW);
      // Attempted 2, delivered 1, and the crashed household is COUNTED as
      // failed rather than folded into "processed".
      expect(result).toEqual({ households: 2, sent: 1, failed: 1 });
      expect(email.sendEmail).toHaveBeenCalledOnce();
    });
  });

  describe('isoWeekKey', () => {
    it('produces stable ISO-8601 week keys across year boundaries', async () => {
      const { isoWeekKey } = await import('../../../src/services/digest.js');
      expect(isoWeekKey(new Date('2026-06-11T12:00:00Z'))).toBe('2026-W24');
      // Mon 2025-12-29 .. Sun 2026-01-04 are all ISO week 2026-W01.
      expect(isoWeekKey(new Date('2025-12-29T00:00:00Z'))).toBe('2026-W01');
      expect(isoWeekKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
      // Sun 2027-01-03 still belongs to 2026's last week (2026-W53).
      expect(isoWeekKey(new Date('2027-01-03T00:00:00Z'))).toBe('2026-W53');
    });
  });

  describe('year recap', () => {
    const REVIEW = {
      year: 2025,
      totalCompletions: 42,
      byMember: [
        { userId: 'u1', name: 'A', count: 30 },
        { userId: 'u2', name: 'B', count: 12 },
      ],
      byTaskType: [
        { type: 'water', count: 35 },
        { type: 'fertilize', count: 7 },
      ],
      topPlants: [{ plantId: 'p1', count: 20 }],
    };

    it('composeRecapEmail celebrates completions by member, type and top plant', async () => {
      const { composeRecapEmail } = await import('../../../src/services/digest.js');
      const { subject, text } = composeRecapEmail(REVIEW, new Map([['p1', 'Monstera']]));
      expect(subject).toContain('2025');
      expect(text).toContain('42 plant-care tasks in 2025');
      expect(text).toContain('- A: 30');
      expect(text).toContain('- B: 12');
      expect(text).toContain('- water: 35');
      expect(text).toContain('- Monstera: 20 tasks');
    });

    it('composeRecapEmail lists at most ten most-pampered plants from a complete per-plant list', async () => {
      // `review.topPlants` is every plant with a completion (the analytics
      // page relies on that to read absence as a real zero); the recap is
      // the one consumer that wants a top list, so it caps for itself.
      const { composeRecapEmail } = await import('../../../src/services/digest.js');
      const topPlants = Array.from({ length: 14 }, (_, i) => ({
        plantId: `p${i}`,
        count: 50 - i,
      }));
      const names = new Map(topPlants.map((p) => [p.plantId, `Plant ${p.plantId}`]));
      const { text } = composeRecapEmail({ ...REVIEW, topPlants }, names);
      expect(text).toContain('- Plant p0: 50 tasks');
      expect(text).toContain('- Plant p9: 41 tasks');
      expect(text).not.toContain('Plant p10:');
      expect(text).not.toContain('Plant p13:');
    });

    it('sends one recap per email-enabled member and honors the once-per-year marker', async () => {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const email = await import('../../../src/services/emailNotifier.js');
      const { recapHousehold } = await import('../../../src/services/digest.js');
      const markers = await mockConditionalMarkerStore();
      await mockActivePlants([{ id: 'p1', name: 'Monstera' }]);
      vi.mocked(tasks.getYearInReview).mockResolvedValue(REVIEW as never);
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA, memberB] as never);
      await mockPrefs({ u1: {}, u2: { email: false } });

      expect(await recapHousehold('hh', 2025, NOW)).toBe(1); // u2 has email off
      expect(markers.has('USER#u1|RECAP#2025#HOUSEHOLD#hh')).toBe(true);

      // Retry (e.g. the EventBridge run after a manual trigger): no double-send.
      expect(await recapHousehold('hh', 2025, NOW)).toBe(0);
      expect(email.sendEmail).toHaveBeenCalledOnce();

      // A different year is a fresh slot.
      vi.mocked(tasks.getYearInReview).mockResolvedValue({ ...REVIEW, year: 2026 } as never);
      expect(await recapHousehold('hh', 2026, NOW)).toBe(1);
    });

    it('atomically reserves before SES so overlapping recap runs send once', async () => {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const email = await import('../../../src/services/emailNotifier.js');
      const { recapHousehold } = await import('../../../src/services/digest.js');
      await mockConditionalMarkerStore();
      await mockActivePlants([{ id: 'p1', name: 'Monstera' }]);
      vi.mocked(tasks.getYearInReview).mockResolvedValue(REVIEW as never);
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
      await mockPrefs({ u1: {} });

      let acceptDelivery!: () => void;
      vi.mocked(email.sendEmail).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            acceptDelivery = () => resolve(true);
          })
      );
      const first = recapHousehold('hh', 2025, NOW);
      await vi.waitFor(() => expect(email.sendEmail).toHaveBeenCalledOnce());
      const second = recapHousehold('hh', 2025, NOW);
      await vi.waitFor(() => expect(tasks.getYearInReview).toHaveBeenCalledTimes(2));
      acceptDelivery();

      expect(await Promise.all([first, second])).toEqual([1, 0]);
      expect(email.sendEmail).toHaveBeenCalledOnce();
    });

    it('does not burn the annual slot on a dry-run and retries later', async () => {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const email = await import('../../../src/services/emailNotifier.js');
      const { recapHousehold } = await import('../../../src/services/digest.js');
      const markers = await mockConditionalMarkerStore();
      await mockActivePlants([{ id: 'p1', name: 'Monstera' }]);
      vi.mocked(tasks.getYearInReview).mockResolvedValue(REVIEW as never);
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
      await mockPrefs({ u1: {} });
      vi.mocked(email.sendEmail).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      expect(await recapHousehold('hh', 2025, NOW)).toBe(0);
      expect(markers.has('USER#u1|RECAP#2025#HOUSEHOLD#hh')).toBe(false);
      expect(await recapHousehold('hh', 2025, NOW)).toBe(1);
      expect(email.sendEmail).toHaveBeenCalledTimes(2);
    });

    it('defers a recap during quiet hours without burning its annual marker', async () => {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const prefs = await import('../../../src/services/notificationPrefs.js');
      const email = await import('../../../src/services/emailNotifier.js');
      const { recapHousehold } = await import('../../../src/services/digest.js');
      const markers = await mockConditionalMarkerStore();
      await mockActivePlants([{ id: 'p1', name: 'Monstera' }]);
      vi.mocked(tasks.getYearInReview).mockResolvedValue(REVIEW as never);
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
      await mockPrefs({ u1: {} });
      vi.mocked(prefs.isInDndWindow).mockReturnValueOnce(true).mockReturnValueOnce(false);

      expect(await recapHousehold('hh', 2025, NOW)).toBe(0);
      expect(markers.size).toBe(0);
      expect(email.sendEmail).not.toHaveBeenCalled();

      expect(await recapHousehold('hh', 2025, new Date(NOW.getTime() + 6 * 60 * 60 * 1000))).toBe(
        1
      );
      expect(email.sendEmail).toHaveBeenCalledOnce();
    });

    it('retries only the recipient whose recap send failed', async () => {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const email = await import('../../../src/services/emailNotifier.js');
      const { recapHousehold } = await import('../../../src/services/digest.js');
      await mockConditionalMarkerStore();
      await mockActivePlants([{ id: 'p1', name: 'Monstera' }]);
      vi.mocked(tasks.getYearInReview).mockResolvedValue(REVIEW as never);
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA, memberB] as never);
      await mockPrefs({ u1: {}, u2: {} });
      vi.mocked(email.sendEmail)
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error('SES throttled'))
        .mockResolvedValueOnce(true);

      expect(await recapHousehold('hh', 2025, NOW)).toBe(1);
      expect(await recapHousehold('hh', 2025, NOW)).toBe(1);
      expect(vi.mocked(email.sendEmail).mock.calls.map(([message]) => message.to)).toEqual([
        'a@x.com',
        'b@x.com',
        'b@x.com',
      ]);
    });

    it('sends distinct annual recaps for a user who belongs to two households', async () => {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const email = await import('../../../src/services/emailNotifier.js');
      const { recapHousehold } = await import('../../../src/services/digest.js');
      const markers = await mockConditionalMarkerStore();
      await mockActivePlants([{ id: 'p1', name: 'Monstera' }]);
      vi.mocked(tasks.getYearInReview).mockResolvedValue(REVIEW as never);
      vi.mocked(household.getHouseholdMembers).mockImplementation(async (householdId: string) => [
        { ...memberA, householdId },
      ]);
      await mockPrefs({ u1: {} });

      expect(await recapHousehold('home', 2025, NOW)).toBe(1);
      expect(await recapHousehold('cabin', 2025, NOW)).toBe(1);
      expect(email.sendEmail).toHaveBeenCalledTimes(2);
      expect(markers.has('USER#u1|RECAP#2025#HOUSEHOLD#home')).toBe(true);
      expect(markers.has('USER#u1|RECAP#2025#HOUSEHOLD#cabin')).toBe(true);
    });

    it('skips households with zero completions BEFORE claiming the marker', async () => {
      const tasks = await import('../../../src/services/taskService.js');
      const email = await import('../../../src/services/emailNotifier.js');
      const { recapHousehold } = await import('../../../src/services/digest.js');
      const markers = await mockConditionalMarkerStore();
      vi.mocked(tasks.getYearInReview).mockResolvedValue({
        ...REVIEW,
        totalCompletions: 0,
        byMember: [],
        byTaskType: [],
        topPlants: [],
      } as never);

      expect(await recapHousehold('hh', 2025, NOW)).toBe(0);
      expect(markers.size).toBe(0); // quiet year doesn't burn the slot
      expect(email.sendEmail).not.toHaveBeenCalled();
    });

    it('runYearRecaps defaults to the previous calendar year', async () => {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const { runYearRecaps } = await import('../../../src/services/digest.js');
      await mockConditionalMarkerStore();
      vi.mocked(household.listAllHouseholdIds).mockResolvedValue(['hh']);
      vi.mocked(tasks.getYearInReview).mockResolvedValue({
        ...REVIEW,
        totalCompletions: 0,
      } as never);

      const result = await runYearRecaps(undefined, NOW);
      expect(result.year).toBe(2025);
      expect(tasks.getYearInReview).toHaveBeenCalledWith('hh', 2025);
    });
  });
});
