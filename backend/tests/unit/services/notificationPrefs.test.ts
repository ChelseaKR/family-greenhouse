import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn((input) => ({ input, kind: 'Put' })),
  GetCommand: vi.fn((input) => ({ input, kind: 'Get' })),
}));

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

describe('notificationPrefs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getPreferences returns defaults when no row exists', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined });
    const { getPreferences } = await import('../../../src/services/notificationPrefs.js');
    const result = await getPreferences('user-1');
    expect(result.userId).toBe('user-1');
    expect(result.email).toBe(true);
    expect(result.sms).toBe(false);
    expect(result.phone).toBe('');
  });

  it('setPreferences clears phone when SMS is off', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    const { setPreferences } = await import('../../../src/services/notificationPrefs.js');
    const updated = await setPreferences({
      userId: 'user-1',
      browser: false,
      email: true,
      sms: false,
      phone: '+15551234567',
    });
    expect(updated.phone).toBe('');
    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { Item: { phone: string } };
    };
    expect(cmd.input.Item.phone).toBe('');
  });

  it('setPreferences keeps phone when SMS is on', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    const { setPreferences } = await import('../../../src/services/notificationPrefs.js');
    const updated = await setPreferences({
      userId: 'user-1',
      browser: false,
      email: false,
      sms: true,
      phone: '+15551234567',
    });
    expect(updated.phone).toBe('+15551234567');
  });
});
