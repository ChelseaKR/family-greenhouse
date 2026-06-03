import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/householdService.js', () => ({
  getHouseholdMembers: vi.fn(),
  listAllHouseholdIds: vi.fn(),
}));
vi.mock('../../../src/services/taskService.js', () => ({
  getTasks: vi.fn(),
}));
vi.mock('../../../src/services/notifier.js', () => ({
  sendToUser: vi.fn(),
}));

const NOW = new Date('2026-06-01T12:00:00.000Z');
const soon = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(); // +1h
const past = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(); // -1h
const farFuture = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString();

describe('reminders service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('remindHousehold notifies only members with due/overdue tasks', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');

    vi.mocked(household.getHouseholdMembers).mockResolvedValue([
      { householdId: 'hh', userId: 'u1', name: 'A', email: 'a@x.com', role: 'admin', joinedAt: '' },
      {
        householdId: 'hh',
        userId: 'u2',
        name: 'B',
        email: 'b@x.com',
        role: 'member',
        joinedAt: '',
      },
    ] as never);
    vi.mocked(tasks.getTasks).mockImplementation((_hh, filters) => {
      // u1 has one overdue + one due-soon; u2 has only a far-future task.
      if ((filters as { assignedTo?: string })?.assignedTo === 'u1') {
        return Promise.resolve([{ nextDue: past }, { nextDue: soon }] as never);
      }
      return Promise.resolve([{ nextDue: farFuture }] as never);
    });

    const sent = await remindHousehold('hh', NOW);
    expect(sent).toBe(1);
    expect(notifier.sendToUser).toHaveBeenCalledOnce();
    const [recipient, payload] = vi.mocked(notifier.sendToUser).mock.calls[0];
    expect(recipient).toEqual({ userId: 'u1', email: 'a@x.com' });
    expect((payload as { body: string }).body).toBe('1 overdue, 1 due soon');
  });

  it('remindAllHouseholds scans every household and survives one failing', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindAllHouseholds } = await import('../../../src/services/reminders.js');

    vi.mocked(household.listAllHouseholdIds).mockResolvedValue(['hhA', 'hhB']);
    vi.mocked(household.getHouseholdMembers).mockImplementation((id) => {
      if (id === 'hhA') throw new Error('boom'); // hhA fails…
      return Promise.resolve([
        {
          householdId: 'hhB',
          userId: 'u',
          name: 'U',
          email: 'u@x.com',
          role: 'admin',
          joinedAt: '',
        },
      ] as never);
    });
    vi.mocked(tasks.getTasks).mockResolvedValue([{ nextDue: soon }] as never);

    const result = await remindAllHouseholds(NOW);
    // …but hhB is still processed.
    expect(result.households).toBe(2);
    expect(result.sent).toBe(1);
    expect(notifier.sendToUser).toHaveBeenCalledOnce();
  });
});
