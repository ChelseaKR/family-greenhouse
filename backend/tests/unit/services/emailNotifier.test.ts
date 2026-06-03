import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sesSendMock = vi.fn();
vi.mock('@aws-sdk/client-ses', () => ({
  SESClient: vi.fn(() => ({ send: sesSendMock })),
  SendEmailCommand: vi.fn((input) => ({ input, kind: 'SendEmail' })),
}));

const ORIGINAL = process.env;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
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
});
