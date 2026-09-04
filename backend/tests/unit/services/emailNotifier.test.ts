import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sesSendMock = vi.fn();
vi.mock('@aws-sdk/client-ses', () => ({
  SESClient: vi.fn(function () {
    return { send: sesSendMock };
  }),
  SendRawEmailCommand: vi.fn(function (input) {
    return { input, kind: 'SendRawEmail' };
  }),
}));

const checkAddressMock = vi.fn(async () => ({ status: 'sendable' }));
vi.mock('../../../src/services/emailSuppression.js', () => ({
  checkAddress: (...args: unknown[]) =>
    (checkAddressMock as unknown as (...a: unknown[]) => unknown)(...args),
}));

const ORIGINAL = process.env;

function rawOf(): string {
  const cmd = sesSendMock.mock.calls[0][0] as { input: { RawMessage: { Data: Buffer } } };
  return cmd.input.RawMessage.Data.toString('utf8');
}

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
    await expect(sendEmail({ to: 'a@b.com', subject: 'hi', text: 'hello' })).resolves.toBe(false);
    expect(sesSendMock).not.toHaveBeenCalled();
    // A dry run must not even look at the suppression list — nothing is going
    // out, so there is nothing to check.
    expect(checkAddressMock).not.toHaveBeenCalled();
  });

  it('sends through SES when configured', async () => {
    process.env = { ...ORIGINAL, SES_FROM_EMAIL: 'noreply@x.com' };
    sesSendMock.mockResolvedValueOnce({});
    const { sendEmail } = await import('../../../src/services/emailNotifier.js');
    await expect(sendEmail({ to: 'a@b.com', subject: 'hi', text: 'hello' })).resolves.toBe(true);
    expect(sesSendMock).toHaveBeenCalledTimes(1);
    const cmd = sesSendMock.mock.calls[0][0] as {
      input: { Source: string; Destinations: string[] };
    };
    expect(cmd.input.Source).toBe('noreply@x.com');
    expect(cmd.input.Destinations).toEqual(['a@b.com']);
    expect(rawOf()).toContain('To: a@b.com');
  });

  it('sends both parts when an html body is supplied', async () => {
    process.env = { ...ORIGINAL, SES_FROM_EMAIL: 'noreply@x.com' };
    sesSendMock.mockResolvedValueOnce({});
    const { sendEmail } = await import('../../../src/services/emailNotifier.js');
    await sendEmail({ to: 'a@b.com', subject: 'hi', text: 'hello', html: '<p>hello</p>' });
    const raw = rawOf();
    expect(raw).toContain('multipart/alternative');
    expect(raw).toContain('text/plain; charset=UTF-8');
    expect(raw).toContain('text/html; charset=UTF-8');
  });

  it('stays a single text/plain message when no html is supplied', async () => {
    // Callers that have not adopted the template kit still send valid mail.
    process.env = { ...ORIGINAL, SES_FROM_EMAIL: 'noreply@x.com' };
    sesSendMock.mockResolvedValueOnce({});
    const { sendEmail } = await import('../../../src/services/emailNotifier.js');
    await sendEmail({ to: 'a@b.com', subject: 'hi', text: 'hello' });
    expect(rawOf()).not.toContain('multipart/alternative');
  });

  it('carries custom headers such as List-Unsubscribe', async () => {
    process.env = { ...ORIGINAL, SES_FROM_EMAIL: 'noreply@x.com' };
    sesSendMock.mockResolvedValueOnce({});
    const { sendEmail } = await import('../../../src/services/emailNotifier.js');
    await sendEmail({
      to: 'a@b.com',
      subject: 'hi',
      text: 'hello',
      headers: {
        'List-Unsubscribe': '<https://api.example/u?t=x>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    const raw = rawOf();
    expect(raw).toContain('List-Unsubscribe: <https://api.example/u?t=x>');
    expect(raw).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  });

  it('stamps Reply-To when SES_REPLY_TO_EMAIL is configured', async () => {
    process.env = {
      ...ORIGINAL,
      SES_FROM_EMAIL: 'noreply@x.com',
      SES_REPLY_TO_EMAIL: 'support@x.com',
    };
    sesSendMock.mockResolvedValueOnce({});
    const { sendEmail } = await import('../../../src/services/emailNotifier.js');
    await sendEmail({ to: 'a@b.com', subject: 'hi', text: 'hello' });
    expect(rawOf()).toContain('Reply-To: support@x.com');
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
