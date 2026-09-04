import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sesSendMock = vi.fn();
vi.mock('@aws-sdk/client-ses', () => ({
  SESClient: vi.fn(function () {
    return { send: sesSendMock };
  }),
  SendEmailCommand: vi.fn(function (input) {
    return { input, kind: 'SendEmail' };
  }),
}));

const checkAddressMock = vi.fn(async () => ({ status: 'sendable' }));
vi.mock('../../../src/services/emailSuppression.js', () => ({
  checkAddress: (...args: unknown[]) =>
    (checkAddressMock as unknown as (...a: unknown[]) => unknown)(...args),
}));

const ORIGINAL = process.env;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  checkAddressMock.mockResolvedValue({ status: 'sendable' });
});

afterEach(() => {
  process.env = ORIGINAL;
});

describe('emailNotifier', () => {
  it('logs and skips when SES_FROM_EMAIL is unset', async () => {
    process.env = { ...ORIGINAL };
    delete process.env.SES_FROM_EMAIL;
    const { sendEmail } = await import('../../../src/services/emailNotifier.js');
    await sendEmail({ to: 'a@b.com', subject: 'hi', text: 'hello' });
    expect(sesSendMock).not.toHaveBeenCalled();
    // A dry run must not even look at the suppression list — nothing is going
    // out, so there is nothing to check.
    expect(checkAddressMock).not.toHaveBeenCalled();
  });

  it('sends through SES when configured', async () => {
    process.env = { ...ORIGINAL, SES_FROM_EMAIL: 'noreply@x.com' };
    sesSendMock.mockResolvedValueOnce({});
    const { sendEmail } = await import('../../../src/services/emailNotifier.js');
    await sendEmail({ to: 'a@b.com', subject: 'hi', text: 'hello' });
    expect(sesSendMock).toHaveBeenCalledTimes(1);
    const cmd = sesSendMock.mock.calls[0][0] as {
      input: { Source: string; Destination: { ToAddresses: string[] } };
    };
    expect(cmd.input.Source).toBe('noreply@x.com');
    expect(cmd.input.Destination.ToAddresses).toEqual(['a@b.com']);
  });

  it('attaches the configuration set so SES publishes bounce/complaint events', async () => {
    process.env = {
      ...ORIGINAL,
      SES_FROM_EMAIL: 'noreply@x.com',
      SES_CONFIGURATION_SET: 'family-greenhouse-production',
    };
    sesSendMock.mockResolvedValueOnce({});
    const { sendEmail } = await import('../../../src/services/emailNotifier.js');
    await sendEmail({ to: 'a@b.com', subject: 'hi', text: 'hello' });
    const cmd = sesSendMock.mock.calls[0][0] as { input: { ConfigurationSetName?: string } };
    expect(cmd.input.ConfigurationSetName).toBe('family-greenhouse-production');
  });

  it('sets Reply-To to the forwarded support address when configured', async () => {
    process.env = {
      ...ORIGINAL,
      SES_FROM_EMAIL: 'Family Greenhouse <hello@x.com>',
      SES_REPLY_TO: 'support@x.com',
    };
    sesSendMock.mockResolvedValueOnce({});
    const { sendEmail } = await import('../../../src/services/emailNotifier.js');
    await sendEmail({ to: 'a@b.com', subject: 'hi', text: 'hello' });
    const cmd = sesSendMock.mock.calls[0][0] as { input: { ReplyToAddresses?: string[] } };
    expect(cmd.input.ReplyToAddresses).toEqual(['support@x.com']);
  });

  it('omits Reply-To and the configuration set when neither is configured', async () => {
    process.env = { ...ORIGINAL, SES_FROM_EMAIL: 'noreply@x.com' };
    delete process.env.SES_REPLY_TO;
    delete process.env.SES_CONFIGURATION_SET;
    sesSendMock.mockResolvedValueOnce({});
    const { sendEmail } = await import('../../../src/services/emailNotifier.js');
    await sendEmail({ to: 'a@b.com', subject: 'hi', text: 'hello' });
    const cmd = sesSendMock.mock.calls[0][0] as {
      input: { ReplyToAddresses?: string[]; ConfigurationSetName?: string };
    };
    expect(cmd.input.ReplyToAddresses).toBeUndefined();
    expect(cmd.input.ConfigurationSetName).toBeUndefined();
  });

  it('refuses to send to a suppressed address', async () => {
    process.env = { ...ORIGINAL, SES_FROM_EMAIL: 'noreply@x.com' };
    checkAddressMock.mockResolvedValue({
      status: 'suppressed',
      state: { email: 'a@b.com', state: 'suppressed', reason: 'hard_bounce' },
    } as never);
    const { sendEmailAccepted } = await import('../../../src/services/emailNotifier.js');
    await expect(
      sendEmailAccepted({ to: 'a@b.com', subject: 'hi', text: 'hello' })
    ).resolves.toEqual({ accepted: false, reason: 'suppressed' });
    expect(sesSendMock).not.toHaveBeenCalled();
  });

  it('declines to send — without claiming suppression — when the list cannot be read', async () => {
    process.env = { ...ORIGINAL, SES_FROM_EMAIL: 'noreply@x.com' };
    checkAddressMock.mockResolvedValue({ status: 'unknown', reason: 'lookup_failed' } as never);
    const { sendEmailAccepted } = await import('../../../src/services/emailNotifier.js');
    await expect(
      sendEmailAccepted({ to: 'a@b.com', subject: 'hi', text: 'hello' })
    ).resolves.toEqual({ accepted: false, reason: 'suppression_unknown' });
    expect(sesSendMock).not.toHaveBeenCalled();
  });

  it('reports a dry run distinctly from a suppression', async () => {
    process.env = { ...ORIGINAL };
    delete process.env.SES_FROM_EMAIL;
    const { sendEmailAccepted } = await import('../../../src/services/emailNotifier.js');
    await expect(sendEmailAccepted({ to: 'a@b.com', subject: 'hi', text: 'x' })).resolves.toEqual({
      accepted: false,
      reason: 'dry_run',
    });
  });

  it('sendEmail returns true only for an accepted send', async () => {
    process.env = { ...ORIGINAL, SES_FROM_EMAIL: 'noreply@x.com' };
    sesSendMock.mockResolvedValueOnce({});
    const { sendEmail } = await import('../../../src/services/emailNotifier.js');
    await expect(sendEmail({ to: 'a@b.com', subject: 'hi', text: 'x' })).resolves.toBe(true);
  });
});
