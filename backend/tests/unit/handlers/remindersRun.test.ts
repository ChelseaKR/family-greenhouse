import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/reminders.js', () => ({
  remindAllHouseholds: vi.fn(),
}));
vi.mock('../../../src/services/householdEmails.js', () => ({
  runHouseholdEmails: vi.fn(),
}));

const REMINDER_SUMMARY = { households: 3, sent: 2, failed: 0 };
const EMAIL_SUMMARY = {
  households: 3,
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
