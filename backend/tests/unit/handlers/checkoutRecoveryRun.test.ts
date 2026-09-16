import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/checkoutRecoveryEmails.js', () => ({
  runCheckoutRecoveryEmails: vi.fn(),
}));

const SUMMARY = {
  households: 3,
  attempted: 3,
  truncated: false,
  stale: 1,
  sent: 1,
  alreadySent: 0,
  noRecipient: 0,
  failed: 0,
  errors: 0,
};

beforeEach(async () => {
  vi.clearAllMocks();
  const service = await import('../../../src/services/checkoutRecoveryEmails.js');
  vi.mocked(service.runCheckoutRecoveryEmails).mockResolvedValue(SUMMARY);
});

describe('checkoutRecovery scheduled Lambda', () => {
  it('runs the fan-out with a deadline derived from the Lambda context', async () => {
    const { handler } = await import('../../../src/handlers/checkoutRecovery/handler.js');
    const service = await import('../../../src/services/checkoutRecoveryEmails.js');

    const result = await handler(undefined, { getRemainingTimeInMillis: () => 25_000 });

    expect(service.runCheckoutRecoveryEmails).toHaveBeenCalledTimes(1);
    const [, options] = vi.mocked(service.runCheckoutRecoveryEmails).mock.calls[0];
    expect(options?.deadlineAt).toBeGreaterThan(Date.now());
    expect(result).toEqual(SUMMARY);
  });

  it('does not throw with no Lambda context (local/manual invocation)', async () => {
    const { handler } = await import('../../../src/handlers/checkoutRecovery/handler.js');
    await expect(handler()).resolves.toEqual(SUMMARY);
  });
});
