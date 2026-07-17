import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const snsSendMock = vi.fn();
const loggerInfoMock = vi.fn();
vi.mock('@aws-sdk/client-sns', () => ({
  SNSClient: vi.fn(function () {
    return { send: snsSendMock };
  }),
  PublishCommand: vi.fn(function (input) {
    return { input, kind: 'Publish' };
  }),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: loggerInfoMock },
}));

const ORIGINAL = process.env;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

afterEach(() => {
  process.env = ORIGINAL;
});

describe('smsNotifier', () => {
  it('rejects non-E.164 numbers', async () => {
    process.env = { ...ORIGINAL };
    const { sendSms } = await import('../../../src/services/smsNotifier.js');
    await expect(sendSms({ to: '5551234567', text: 'hi' })).rejects.toThrow(/E\.164/);
  });

  it('dry-runs when SMS_NOTIFICATIONS_ENABLED is unset', async () => {
    process.env = { ...ORIGINAL };
    delete process.env.SMS_NOTIFICATIONS_ENABLED;
    const { sendSms } = await import('../../../src/services/smsNotifier.js');
    const sent = await sendSms({ to: '+15551234567', text: 'secret verification 123456' });
    expect(sent).toBe(false);
    expect(snsSendMock).not.toHaveBeenCalled();
    expect(JSON.stringify(loggerInfoMock.mock.calls)).not.toContain('+15551234567');
    expect(JSON.stringify(loggerInfoMock.mock.calls)).not.toContain('123456');
  });

  it('publishes to SNS when enabled, with Transactional attribute', async () => {
    process.env = { ...ORIGINAL, SMS_NOTIFICATIONS_ENABLED: '1' };
    snsSendMock.mockResolvedValueOnce({});
    const { sendSms } = await import('../../../src/services/smsNotifier.js');
    await sendSms({ to: '+15551234567', text: 'hello' });
    expect(snsSendMock).toHaveBeenCalledTimes(1);
    const cmd = snsSendMock.mock.calls[0][0] as {
      input: {
        PhoneNumber: string;
        MessageAttributes: { 'AWS.SNS.SMS.SMSType': { StringValue: string } };
      };
    };
    expect(cmd.input.PhoneNumber).toBe('+15551234567');
    expect(cmd.input.MessageAttributes['AWS.SNS.SMS.SMSType'].StringValue).toBe('Transactional');
  });

  it('truncates long ASCII messages to 140 bytes', async () => {
    process.env = { ...ORIGINAL, SMS_NOTIFICATIONS_ENABLED: '1' };
    snsSendMock.mockResolvedValueOnce({});
    const { sendSms } = await import('../../../src/services/smsNotifier.js');
    await sendSms({ to: '+15551234567', text: 'a'.repeat(200) });
    const cmd = snsSendMock.mock.calls[0][0] as { input: { Message: string } };
    expect(Buffer.byteLength(cmd.input.Message, 'utf8')).toBe(140);
  });

  it('truncates multibyte messages by bytes without splitting a code point', async () => {
    process.env = { ...ORIGINAL, SMS_NOTIFICATIONS_ENABLED: '1' };
    snsSendMock.mockResolvedValueOnce({});
    const { sendSms } = await import('../../../src/services/smsNotifier.js');
    // The app's own streak emoji is 4 UTF-8 bytes; 100 of them is 400 bytes.
    await sendSms({ to: '+15551234567', text: '🌱'.repeat(100) });
    const cmd = snsSendMock.mock.calls[0][0] as { input: { Message: string } };
    const body = cmd.input.Message;
    // At most one 140-byte segment, and no lone/split surrogate at the boundary.
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(140);
    expect(body).toBe('🌱'.repeat(35)); // 35 * 4 bytes = 140, whole emoji only
    expect([...body].every((ch) => ch === '🌱')).toBe(true);
  });
});

describe('truncateToBytes', () => {
  it('keeps a short string unchanged', async () => {
    const { truncateToBytes } = await import('../../../src/services/smsNotifier.js');
    expect(truncateToBytes('hello', 140)).toBe('hello');
  });

  it('never splits a multi-byte code point at the byte boundary', async () => {
    const { truncateToBytes } = await import('../../../src/services/smsNotifier.js');
    // 'é' is 2 UTF-8 bytes; a 3-byte cap must drop the second 'é', not split it.
    const out = truncateToBytes('éé', 3);
    expect(out).toBe('é');
    expect(Buffer.byteLength(out, 'utf8')).toBe(2);
  });
});
