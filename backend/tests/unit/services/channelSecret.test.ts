import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const kms = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/client-kms', () => ({
  KMSClient: vi.fn(function () {
    return kms;
  }),
  EncryptCommand: vi.fn(function (input) {
    return { input, kind: 'Encrypt' };
  }),
  DecryptCommand: vi.fn(function (input) {
    return { input, kind: 'Decrypt' };
  }),
}));
vi.mock('aws-xray-sdk-core', () => ({
  default: { captureAWSv3Client: <T>(client: T) => client },
}));

const URL = 'https://hooks.slack.com/services/T0123ABC/B0456EFG/abcdefghijklmnop';

async function load() {
  const mod = await import('../../../src/services/channelSecret.js');
  mod.__resetChannelSecretClientForTests();
  return mod;
}

beforeEach(() => {
  kms.send.mockReset();
  process.env.CHANNEL_WEBHOOK_KMS_KEY_ID = 'alias/family-greenhouse-channel-webhooks-test';
});

afterEach(() => {
  delete process.env.CHANNEL_WEBHOOK_KMS_KEY_ID;
});

describe('channelSecret (#674)', () => {
  it('encrypts under the configured key, bound to the household by encryption context', async () => {
    const { sealWebhookUrl } = await load();
    kms.send.mockResolvedValueOnce({ CiphertextBlob: Buffer.from('opaque-ciphertext') });
    const sealed = await sealWebhookUrl('hh-1', URL);
    const command = kms.send.mock.calls[0][0] as { input: Record<string, any> };
    expect(command.input.KeyId).toBe('alias/family-greenhouse-channel-webhooks-test');
    expect(command.input.EncryptionContext).toEqual({
      purpose: 'household-channel-webhook',
      householdId: 'hh-1',
    });
    expect(Buffer.from(command.input.Plaintext).toString('utf8')).toBe(URL);
    // What gets stored is the ciphertext, and the address is not in it.
    expect(sealed).toBe(Buffer.from('opaque-ciphertext').toString('base64'));
    expect(sealed).not.toContain('hooks.slack.com');
  });

  it('decrypts naming the key and the same context — another household’s row will not open', async () => {
    const { openWebhookUrl } = await load();
    kms.send.mockResolvedValueOnce({ Plaintext: Buffer.from(URL) });
    await expect(openWebhookUrl('hh-2', 'b3BhcXVl')).resolves.toBe(URL);
    const command = kms.send.mock.calls[0][0] as { input: Record<string, any> };
    expect(command.input.KeyId).toBe('alias/family-greenhouse-channel-webhooks-test');
    expect(command.input.EncryptionContext).toEqual({
      purpose: 'household-channel-webhook',
      householdId: 'hh-2',
    });
  });

  it('with no key configured there is no feature — and no plaintext fallback', async () => {
    delete process.env.CHANNEL_WEBHOOK_KMS_KEY_ID;
    const { sealWebhookUrl, openWebhookUrl, channelSealingConfigured } = await load();
    expect(channelSealingConfigured()).toBe(false);
    await expect(sealWebhookUrl('hh-1', URL)).rejects.toMatchObject({
      name: 'ChannelSealingUnavailableError',
    });
    await expect(openWebhookUrl('hh-1', 'x')).rejects.toMatchObject({
      name: 'ChannelSealingUnavailableError',
    });
    expect(kms.send).not.toHaveBeenCalled();
  });

  it('a KMS refusal propagates rather than being read as an empty address', async () => {
    const { openWebhookUrl } = await load();
    kms.send.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
    );
    await expect(openWebhookUrl('hh-1', 'x')).rejects.toMatchObject({
      name: 'AccessDeniedException',
    });
    kms.send.mockResolvedValueOnce({});
    await expect(openWebhookUrl('hh-1', 'x')).rejects.toThrow('KMS returned no plaintext');
    kms.send.mockResolvedValueOnce({});
    const { sealWebhookUrl } = await load();
    await expect(sealWebhookUrl('hh-1', URL)).rejects.toThrow('KMS returned no ciphertext');
  });
});
