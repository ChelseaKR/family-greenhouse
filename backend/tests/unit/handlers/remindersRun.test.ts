import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/reminders.js', () => ({
  remindAllHouseholds: vi.fn(),
}));
vi.mock('../../../src/services/householdEmails.js', () => ({
  runHouseholdEmails: vi.fn(),
}));

const REMINDER_SUMMARY = { households: 3, attempted: 3, sent: 2, failed: 0, truncated: false };
const EMAIL_SUMMARY = {
  households: 3,
  attempted: 3,
  truncated: false,
  offered: 1,
  sent: 4,
  deferred: 1,
  expired: 0,
  unknown: 0,
  failed: 0,
};

beforeEach(async () => {
  vi.clearAllMocks();
  const reminders = await import('../../../src/services/reminders.js');
  vi.mocked(reminders.remindAllHouseholds).mockResolvedValue(REMINDER_SUMMARY);
  const householdEmails = await import('../../../src/services/householdEmails.js');
  vi.mocked(householdEmails.runHouseholdEmails).mockResolvedValue(EMAIL_SUMMARY);
});

describe('hourly reminders Lambda', () => {
  it('runs the household-email pass alongside the reminder fan-out', async () => {
    const { handler } = await import('../../../src/handlers/reminders/handler.js');
    const reminders = await import('../../../src/services/reminders.js');
    const householdEmails = await import('../../../src/services/householdEmails.js');

    const result = await handler();

    expect(reminders.remindAllHouseholds).toHaveBeenCalledTimes(1);
    expect(householdEmails.runHouseholdEmails).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ...REMINDER_SUMMARY, householdEmails: EMAIL_SUMMARY });
  });

  // #458. Both passes ride this one 30-second invocation, sequentially. With
  // no clock in either, a reminder fan-out that used the whole invocation was
  // killed by the timeout — and then the household-email pass never ran AT
  // ALL, every hour, with nothing in the summary saying so.
  it('leaves the household-email pass a budget instead of letting reminders take the whole invocation', async () => {
    const reminders = await import('../../../src/services/reminders.js');
    const householdEmails = await import('../../../src/services/householdEmails.js');
    const { handler } = await import('../../../src/handlers/reminders/handler.js');

    const before = Date.now();
    await handler(undefined, { getRemainingTimeInMillis: () => 28_000 });
    const after = Date.now();

    const reminderDeadline = vi.mocked(reminders.remindAllHouseholds).mock.calls[0][1]
      ?.deadlineAt as number;
    const emailDeadline = vi.mocked(householdEmails.runHouseholdEmails).mock.calls[0][1]
      ?.deadlineAt as number;

    // Both passes are bounded at all.
    expect(reminderDeadline).toBeGreaterThan(before);
    expect(emailDeadline).toBeGreaterThan(before);
    // And the reminder pass is bounded SHORT of the invocation, so there is
    // something left for the second pass. 28s remaining, 3s reserved to wind
    // down, 60% share => 15s, well under the 25s the second pass may use.
    expect(reminderDeadline - before).toBeLessThan(16_000);
    expect(emailDeadline - after).toBeGreaterThan(20_000);
    expect(emailDeadline).toBeGreaterThan(reminderDeadline);
  });

  it('reports the household-email pass as unknown — not zero — when it throws', async () => {
    // A zeroed summary would read like a calm hour. `null` says we do not know.
    const householdEmails = await import('../../../src/services/householdEmails.js');
    vi.mocked(householdEmails.runHouseholdEmails).mockRejectedValue(new Error('ddb down'));
    const { handler } = await import('../../../src/handlers/reminders/handler.js');

    const result = await handler();

    expect(result.householdEmails).toBeNull();
    // The reminder half still reports its own real numbers.
    expect(result.sent).toBe(2);
  });

  it('does not swallow a failure of the reminder fan-out itself', async () => {
    const reminders = await import('../../../src/services/reminders.js');
    vi.mocked(reminders.remindAllHouseholds).mockRejectedValue(new Error('reminders down'));
    const { handler } = await import('../../../src/handlers/reminders/handler.js');

    await expect(handler()).rejects.toThrow('reminders down');
  });
});
