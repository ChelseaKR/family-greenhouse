import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/reminders.js', () => ({
  remindAllHouseholds: vi.fn(),
}));
vi.mock('../../../src/services/householdEmails.js', () => ({
  runHouseholdEmails: vi.fn(),
}));
vi.mock('../../../src/services/confirmReminders.js', () => ({
  runConfirmReminders: vi.fn(),
}));
vi.mock('../../../src/services/householdChannelRun.js', () => ({
  runHouseholdChannels: vi.fn(),
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

const CONFIRM_SUMMARY = {
  due: 1,
  sent: 1,
  confirmedAfterReminder: 0,
  skippedNotUnconfirmed: 0,
  skippedDeleted: 0,
  skippedFixture: 0,
  skippedSuppressed: 0,
  alreadyClaimed: 0,
  deferred: 0,
  throttled: 0,
  failed: 0,
  errors: 0,
  truncated: false,
};

const CHANNEL_SUMMARY = {
  channels: 2,
  attempted: 2,
  posted: 1,
  held: 1,
  backingOff: 0,
  disabled: 0,
  failedDelivery: 0,
  unknown: 0,
  failed: 0,
  truncated: false,
};

beforeEach(async () => {
  vi.clearAllMocks();
  const reminders = await import('../../../src/services/reminders.js');
  vi.mocked(reminders.remindAllHouseholds).mockResolvedValue(REMINDER_SUMMARY);
  const householdEmails = await import('../../../src/services/householdEmails.js');
  vi.mocked(householdEmails.runHouseholdEmails).mockResolvedValue(EMAIL_SUMMARY);
  const confirmReminders = await import('../../../src/services/confirmReminders.js');
  vi.mocked(confirmReminders.runConfirmReminders).mockResolvedValue(CONFIRM_SUMMARY);
  const channels = await import('../../../src/services/householdChannelRun.js');
  vi.mocked(channels.runHouseholdChannels).mockResolvedValue(CHANNEL_SUMMARY);
});

describe('hourly reminders Lambda', () => {
  it('runs the household-email and confirm-reminder passes alongside the reminder fan-out', async () => {
    const { handler } = await import('../../../src/handlers/reminders/handler.js');
    const reminders = await import('../../../src/services/reminders.js');
    const householdEmails = await import('../../../src/services/householdEmails.js');
    const confirmReminders = await import('../../../src/services/confirmReminders.js');

    const result = await handler();

    expect(reminders.remindAllHouseholds).toHaveBeenCalledTimes(1);
    expect(householdEmails.runHouseholdEmails).toHaveBeenCalledTimes(1);
    expect(confirmReminders.runConfirmReminders).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ...REMINDER_SUMMARY,
      householdEmails: EMAIL_SUMMARY,
      confirmReminders: CONFIRM_SUMMARY,
      householdChannels: CHANNEL_SUMMARY,
    });
  });

  it('runs the chat-channel pass last (#674), after the confirm-reminder pass', async () => {
    const confirmReminders = await import('../../../src/services/confirmReminders.js');
    const channels = await import('../../../src/services/householdChannelRun.js');
    const { handler } = await import('../../../src/handlers/reminders/handler.js');

    await handler(undefined, { getRemainingTimeInMillis: () => 28_000 });

    const confirmCall = vi.mocked(confirmReminders.runConfirmReminders).mock;
    const channelCall = vi.mocked(channels.runHouseholdChannels).mock;
    expect(channelCall.invocationCallOrder[0]).toBeGreaterThan(confirmCall.invocationCallOrder[0]);
    expect(channelCall.calls[0][1]?.deadlineAt).toBeGreaterThan(Date.now());
  });

  it('reports the chat-channel pass as unknown — not zero — when it throws', async () => {
    const channels = await import('../../../src/services/householdChannelRun.js');
    vi.mocked(channels.runHouseholdChannels).mockRejectedValue(new Error('kms down'));
    const { handler } = await import('../../../src/handlers/reminders/handler.js');

    const result = await handler();

    expect(result.householdChannels).toBeNull();
    expect(result.confirmReminders).toEqual(CONFIRM_SUMMARY);
    expect(result.sent).toBe(2);
  });

  it('runs the confirm-reminder pass last, on whatever time the first two left', async () => {
    const householdEmails = await import('../../../src/services/householdEmails.js');
    const confirmReminders = await import('../../../src/services/confirmReminders.js');
    const { handler } = await import('../../../src/handlers/reminders/handler.js');

    await handler(undefined, { getRemainingTimeInMillis: () => 28_000 });

    const emailCall = vi.mocked(householdEmails.runHouseholdEmails).mock;
    const confirmCall = vi.mocked(confirmReminders.runConfirmReminders).mock;
    expect(confirmCall.invocationCallOrder[0]).toBeGreaterThan(emailCall.invocationCallOrder[0]);
    const emailDeadline = emailCall.calls[0][1]?.deadlineAt as number;
    const confirmDeadline = confirmCall.calls[0][1]?.deadlineAt as number;
    expect(confirmDeadline).toBeGreaterThanOrEqual(emailDeadline);
  });

  it('reports the confirm-reminder pass as unknown, not zero, without failing the invocation', async () => {
    const confirmReminders = await import('../../../src/services/confirmReminders.js');
    vi.mocked(confirmReminders.runConfirmReminders).mockRejectedValue(new Error('cognito down'));
    const { handler } = await import('../../../src/handlers/reminders/handler.js');

    const result = await handler();

    expect(result.confirmReminders).toBeNull();
    // The other two passes still report their own real numbers.
    expect(result.householdEmails).toEqual(EMAIL_SUMMARY);
    expect(result.sent).toBe(2);
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
