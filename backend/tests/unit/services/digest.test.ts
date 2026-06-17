import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn((input) => ({ input, kind: 'Put' })),
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
}));
vi.mock('../../../src/services/emailNotifier.js', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
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
    const { input } = cmd as { input: { Item: { PK: string; SK: string } } };
    const key = `${input.Item.PK}|${input.Item.SK}`;
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

    it('caps the list at the top 5 plants', async () => {
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

      const result = await computePlantsAtRisk('hh', NOW);
      expect(result).toHaveLength(5);
      expect(result.map((r) => r.daysOverdue)).toEqual([7, 6, 5, 4, 3]); // most overdue kept
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

    it('dedupes per user per ISO week; a new week sends again', async () => {
      const household = await import('../../../src/services/householdService.js');
      const email = await import('../../../src/services/emailNotifier.js');
      const { digestHousehold } = await import('../../../src/services/digest.js');
      const markers = await mockConditionalMarkerStore();
      await setupOneOverduePlant();
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
      await mockPrefs({ u1: {} });

      // First run this week: sends and claims the W24 slot.
      expect(await digestHousehold('hh', NOW)).toBe(1);
      expect(markers.has('USER#u1|DIGEST#2026-W24')).toBe(true);

      // Retry two days later, same ISO week: deduped.
      expect(await digestHousehold('hh', new Date(NOW.getTime() + 2 * DAY))).toBe(0);
      expect(email.sendEmail).toHaveBeenCalledOnce();

      // Next week (NOW is Thursday; +7d lands in W25): sends again.
      expect(await digestHousehold('hh', new Date(NOW.getTime() + 7 * DAY))).toBe(1);
      expect(email.sendEmail).toHaveBeenCalledTimes(2);
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
      expect(result).toEqual({ households: 2, sent: 1 });
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
      expect(markers.has('HOUSEHOLD#hh|RECAP#2025')).toBe(true);

      // Retry (e.g. the EventBridge run after a manual trigger): no double-send.
      expect(await recapHousehold('hh', 2025, NOW)).toBe(0);
      expect(email.sendEmail).toHaveBeenCalledOnce();

      // A different year is a fresh slot.
      vi.mocked(tasks.getYearInReview).mockResolvedValue({ ...REVIEW, year: 2026 } as never);
      expect(await recapHousehold('hh', 2026, NOW)).toBe(1);
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
