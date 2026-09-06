import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
}));
vi.mock('../../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

const { dynamodb } = await import('../../../../src/utils/dynamodb.js');
const send = dynamodb.send as unknown as ReturnType<typeof vi.fn>;
const capability = await import('../../../../src/services/email/capability.js');

const NOW = new Date('2026-09-03T12:00:00.000Z');
const SECRET = 'a-test-secret';

beforeEach(() => {
  send.mockReset();
});

describe('token round trip', () => {
  it('mints a token the verifier accepts, carrying user and category', async () => {
    send.mockResolvedValueOnce({ Attributes: { secret: SECRET } });
    const minted = await capability.mintUnsubscribeToken('u-1', 'weekly_digest', NOW);
    expect(minted.status).toBe('ok');
    const token = (minted as { token: string }).token;

    send.mockResolvedValueOnce({ Item: { secret: SECRET } });
    await expect(capability.verifyUnsubscribeToken(token, NOW)).resolves.toEqual({
      status: 'ok',
      userId: 'u-1',
      category: 'weekly_digest',
    });
  });

  it('writes the secret to its own row, never onto the preferences row', async () => {
    // A preferences row created just to hold a secret would read back with
    // `email: false` and silently unsubscribe the user from everything.
    send.mockResolvedValueOnce({ Attributes: { secret: SECRET } });
    await capability.mintUnsubscribeToken('u-1', 'weekly_digest', NOW);
    expect(send.mock.calls[0][0].input.Key).toEqual({ PK: 'USER#u-1', SK: 'EMAILCAP' });
  });

  it('rejects a token signed with a different secret (the revocation path)', async () => {
    const token = capability.signToken(SECRET, 'u-1', 'weekly_digest', 9999999999);
    send.mockResolvedValueOnce({ Item: { secret: 'rotated-secret' } });
    await expect(capability.verifyUnsubscribeToken(token, NOW)).resolves.toEqual({
      status: 'invalid',
    });
  });

  it('rejects a token whose category or user was tampered with', async () => {
    const token = capability.signToken(SECRET, 'u-1', 'weekly_digest', 9999999999);
    const parts = token.split('.');
    const tampered = [
      parts[0],
      Buffer.from('u-2', 'utf8').toString('base64url'),
      parts[2],
      parts[3],
      parts[4],
    ].join('.');
    send.mockResolvedValueOnce({ Item: { secret: SECRET } });
    await expect(capability.verifyUnsubscribeToken(tampered, NOW)).resolves.toEqual({
      status: 'invalid',
    });
  });

  it('reports an expired token as expired, not invalid', async () => {
    const expired = capability.signToken(SECRET, 'u-1', 'weekly_digest', 1000);
    send.mockResolvedValueOnce({ Item: { secret: SECRET } });
    await expect(capability.verifyUnsubscribeToken(expired, NOW)).resolves.toEqual({
      status: 'expired',
    });
  });

  it('rejects malformed tokens without reading anything', async () => {
    for (const bad of ['', 'nope', 'v2.a.b.c.d', 'v1.a.b.c', 'v1.a.not-a-category.1.x']) {
      await expect(capability.verifyUnsubscribeToken(bad, NOW)).resolves.toEqual({
        status: 'invalid',
      });
    }
    expect(send).not.toHaveBeenCalled();
  });
});

describe('honest failure', () => {
  it('reports a failed secret READ as unavailable, not as an invalid link', async () => {
    // "We could not look" must never be rendered to a recipient as "your
    // unsubscribe link is bad" — that is this repo's named defect class.
    const token = capability.signToken(SECRET, 'u-1', 'weekly_digest', 9999999999);
    send.mockRejectedValueOnce(new Error('ddb down'));
    await expect(capability.verifyUnsubscribeToken(token, NOW)).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('treats a user with no secret row as invalid, and does not create one', async () => {
    const token = capability.signToken(SECRET, 'u-ghost', 'weekly_digest', 9999999999);
    send.mockResolvedValueOnce({});
    await expect(capability.verifyUnsubscribeToken(token, NOW)).resolves.toEqual({
      status: 'invalid',
    });
    expect(send.mock.calls[0][0].kind).toBe('Get');
  });

  it('reports a failed mint as unavailable rather than handing back an empty key', async () => {
    send.mockRejectedValueOnce(new Error('ddb down'));
    const minted = await capability.mintUnsubscribeToken('u-1', 'weekly_digest', NOW);
    expect(minted).toEqual({ status: 'unavailable', reason: 'write_failed' });
  });

  it('treats a write that returns no secret as unavailable', async () => {
    send.mockResolvedValueOnce({ Attributes: {} });
    const minted = await capability.mintUnsubscribeToken('u-1', 'weekly_digest', NOW);
    expect(minted).toEqual({ status: 'unavailable', reason: 'no_secret_returned' });
  });
});

describe('revocation', () => {
  it('rotates the secret, invalidating every outstanding link', async () => {
    send.mockResolvedValueOnce({});
    await capability.revokeCapabilities('u-1');
    const call = send.mock.calls[0][0];
    expect(call.kind).toBe('Update');
    expect(call.input.Key).toEqual({ PK: 'USER#u-1', SK: 'EMAILCAP' });
    expect(call.input.UpdateExpression).toContain('SET #secret = :fresh');
  });
});

describe('categories', () => {
  it('covers exactly the recurring email types, and no transactional one', () => {
    expect([...capability.EMAIL_CATEGORIES]).toEqual([
      'weekly_digest',
      'year_recap',
      'pest_alerts',
    ]);
    expect(capability.isEmailCategory('welcome')).toBe(false);
    expect(capability.isEmailCategory('weekly_digest')).toBe(true);
  });
});
