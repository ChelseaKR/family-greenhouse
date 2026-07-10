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

  it('truncates long messages to 140 bytes', async () => {
    process.env = { ...ORIGINAL, SMS_NOTIFICATIONS_ENABLED: '1' };
    snsSendMock.mockResolvedValueOnce({});
    const { sendSms } = await import('../../../src/services/smsNotifier.js');
    await sendSms({ to: '+15551234567', text: 'a'.repeat(200) });
    const cmd = snsSendMock.mock.calls[0][0] as { input: { Message: string } };
    expect(cmd.input.Message.length).toBe(140);
  });
});
