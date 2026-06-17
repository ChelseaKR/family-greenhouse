/**
 * Phone verification flow (services/notificationPrefs.ts): start stores a
 * hashed 6-digit code on USER#{id}/PHONE_VERIFY and texts it; confirm checks
 * it (constant-time, max 5 attempts, 10-minute expiry) and stamps
 * `phoneVerified` + the verified number on the prefs row.
 */
import { createHash } from 'crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
  DeleteCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
  }),
}));

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

vi.mock('../../../src/services/smsNotifier.js', () => ({
  sendSms: vi.fn().mockResolvedValue(undefined),
}));

const NOW = new Date('2026-06-11T12:00:00.000Z');
const PHONE = '+15551234567';

interface FakeRow {
  [key: string]: unknown;
}

/**
 * Tiny in-memory PK|SK store that understands the four command shapes the
 * service issues (Put / Get / Update-increment / Delete), so the whole
 * start → confirm flow can run against realistic persistence.
 */
async function mockTable(seed: Record<string, FakeRow> = {}) {
  const rows = new Map<string, FakeRow>(Object.entries(seed));
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  vi.mocked(dynamodb.send).mockImplementation(async (cmd: unknown) => {
    const { kind, input } = cmd as { kind: string; input: Record<string, never> };
    const keyOf = (k: { PK: string; SK: string }) => `${k.PK}|${k.SK}`;
    if (kind === 'Put') {
      const item = input.Item as { PK: string; SK: string };
      rows.set(keyOf(item), item);
      return {} as never;
    }
    if (kind === 'Get') {
      return { Item: rows.get(keyOf(input.Key)) } as never;
    }
    if (kind === 'Update') {
      const row = rows.get(keyOf(input.Key));
      if (!row) {
        const err = new Error('does not exist');
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }
      row.attempts = (row.attempts as number) + 1;
      return {} as never;
    }
    if (kind === 'Delete') {
      rows.delete(keyOf(input.Key));
      return {} as never;
    }
    return {} as never;
  });
  return rows;
}

describe('phone verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('start stores SHA-256(code) + expiry + zeroed attempts and texts the code', async () => {
    const rows = await mockTable();
    const smsNotifier = await import('../../../src/services/smsNotifier.js');
    const { startPhoneVerification } = await import('../../../src/services/notificationPrefs.js');

    await startPhoneVerification('u1', PHONE, NOW);

    const row = rows.get('USER#u1|PHONE_VERIFY')!;
    expect(row).toBeDefined();
    expect(row.phone).toBe(PHONE);
    expect(row.attempts).toBe(0);
    expect(row.expiresAt).toBe('2026-06-11T12:10:00.000Z'); // +10 min
    expect(typeof row.ttl).toBe('number');

    // The code is texted, never stored in plaintext.
    expect(smsNotifier.sendSms).toHaveBeenCalledOnce();
    const sentText = vi.mocked(smsNotifier.sendSms).mock.calls[0][0].text;
    const code = sentText.match(/\d{6}/)?.[0];
    expect(code).toBeDefined();
    expect(row.codeHash).toBe(createHash('sha256').update(code!).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(code);
  });

  it('start rejects non-E.164 numbers without writing or texting', async () => {
    const rows = await mockTable();
    const smsNotifier = await import('../../../src/services/smsNotifier.js');
    const { startPhoneVerification } = await import('../../../src/services/notificationPrefs.js');
    await expect(startPhoneVerification('u1', '555-1234', NOW)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(rows.size).toBe(0);
    expect(smsNotifier.sendSms).not.toHaveBeenCalled();
  });

  it('happy path: correct code stamps phoneVerified + number and deletes the row', async () => {
    const rows = await mockTable();
    const smsNotifier = await import('../../../src/services/smsNotifier.js');
    const { startPhoneVerification, confirmPhoneVerification } =
      await import('../../../src/services/notificationPrefs.js');

    await startPhoneVerification('u1', PHONE, NOW);
    const code = vi.mocked(smsNotifier.sendSms).mock.calls[0][0].text.match(/\d{6}/)![0];

    const prefs = await confirmPhoneVerification('u1', code, NOW);
    expect(prefs.phoneVerified).toBe(true);
    expect(prefs.phone).toBe(PHONE);

    const stored = rows.get('USER#u1|PREFS')!;
    expect(stored.phoneVerified).toBe(true);
    expect(stored.phone).toBe(PHONE);
    // One-shot: the verification row is gone, the code can't be replayed.
    expect(rows.has('USER#u1|PHONE_VERIFY')).toBe(false);
    await expect(confirmPhoneVerification('u1', code, NOW)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('wrong code burns an attempt and returns 400 without verifying', async () => {
    const rows = await mockTable();
    const { startPhoneVerification, confirmPhoneVerification } =
      await import('../../../src/services/notificationPrefs.js');
    await startPhoneVerification('u1', PHONE, NOW);

    await expect(confirmPhoneVerification('u1', '000000', NOW)).rejects.toMatchObject({
      statusCode: 400,
      message: 'Incorrect verification code.',
    });
    expect(rows.get('USER#u1|PHONE_VERIFY')!.attempts).toBe(1);
    expect(rows.has('USER#u1|PREFS')).toBe(false); // nothing stamped
  });

  it('expired code is rejected even when correct', async () => {
    const smsNotifier = await import('../../../src/services/smsNotifier.js');
    const { startPhoneVerification, confirmPhoneVerification } =
      await import('../../../src/services/notificationPrefs.js');
    await mockTable();
    await startPhoneVerification('u1', PHONE, NOW);
    const code = vi.mocked(smsNotifier.sendSms).mock.calls[0][0].text.match(/\d{6}/)![0];

    const after = new Date(NOW.getTime() + 11 * 60 * 1000); // +11 min > 10 min TTL
    await expect(confirmPhoneVerification('u1', code, after)).rejects.toMatchObject({
      statusCode: 400,
      message: 'Verification code expired or not found. Request a new code.',
    });
  });

  it('locks out after 5 wrong attempts — even the right code then fails with 429', async () => {
    const smsNotifier = await import('../../../src/services/smsNotifier.js');
    const { startPhoneVerification, confirmPhoneVerification } =
      await import('../../../src/services/notificationPrefs.js');
    await mockTable();
    await startPhoneVerification('u1', PHONE, NOW);
    const code = vi.mocked(smsNotifier.sendSms).mock.calls[0][0].text.match(/\d{6}/)![0];

    for (let i = 0; i < 5; i++) {
      await expect(confirmPhoneVerification('u1', '000000', NOW)).rejects.toMatchObject({
        statusCode: 400,
      });
    }
    await expect(confirmPhoneVerification('u1', code, NOW)).rejects.toMatchObject({
      statusCode: 429,
    });
  });

  it('requesting a new code replaces the old one and resets attempts', async () => {
    const rows = await mockTable();
    const smsNotifier = await import('../../../src/services/smsNotifier.js');
    const { startPhoneVerification, confirmPhoneVerification } =
      await import('../../../src/services/notificationPrefs.js');
    await startPhoneVerification('u1', PHONE, NOW);
    const first = vi.mocked(smsNotifier.sendSms).mock.calls[0][0].text.match(/\d{6}/)![0];
    await expect(confirmPhoneVerification('u1', '000000', NOW)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(rows.get('USER#u1|PHONE_VERIFY')!.attempts).toBe(1);

    await startPhoneVerification('u1', PHONE, NOW);
    expect(rows.get('USER#u1|PHONE_VERIFY')!.attempts).toBe(0);
    const second = vi.mocked(smsNotifier.sendSms).mock.calls[1][0].text.match(/\d{6}/)![0];
    // The first code only still works if the RNG produced the same 6 digits
    // twice (1 in 10^6) — assert on the stored hash instead of the codes.
    expect(rows.get('USER#u1|PHONE_VERIFY')!.codeHash).toBe(
      createHash('sha256').update(second).digest('hex')
    );
    expect(first).toMatch(/^\d{6}$/);
  });
});
