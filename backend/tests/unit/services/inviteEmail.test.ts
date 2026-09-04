import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
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
vi.mock('../../../src/services/emailNotifier.js', () => ({
  sendEmail: vi.fn().mockResolvedValue(true),
}));

const NOW = new Date('2026-09-03T12:00:00.000Z');

const input = {
  householdId: 'hh',
  to: 'friend@example.com',
  inviterName: 'Sam',
  householdName: 'The Kim House',
  joinUrl: 'https://app.example.net/join/abc',
  expiresAt: '2026-09-10T00:00:00.000Z',
};

function conditionalFailure(): Error {
  const err = new Error('conditional');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

/** The DDB calls the service made, tagged by which guard they belong to. */
async function sentCommands() {
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  return vi.mocked(dynamodb.send).mock.calls.map(
    (call) =>
      call[0] as unknown as {
        kind: string;
        input: {
          Key?: { SK: string };
          Item?: { SK: string };
          UpdateExpression?: string;
          ExpressionAttributeValues?: Record<string, unknown>;
        };
      }
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  vi.mocked(dynamodb.send).mockResolvedValue({} as never);
  const emailNotifier = await import('../../../src/services/emailNotifier.js');
  vi.mocked(emailNotifier.sendEmail).mockResolvedValue(true);
});

describe('sendInviteEmail — the happy path', () => {
  it('sends a named invitation and reports acceptance', async () => {
    const { sendInviteEmail } = await import('../../../src/services/inviteEmail.js');
    const emailNotifier = await import('../../../src/services/emailNotifier.js');

    expect(await sendInviteEmail(input, NOW)).toBe('accepted');

    expect(emailNotifier.sendEmail).toHaveBeenCalledTimes(1);
    const message = vi.mocked(emailNotifier.sendEmail).mock.calls[0][0];
    expect(message.to).toBe('friend@example.com');
    expect(message.subject).toContain('Sam');
    expect(message.subject).toContain('The Kim House');
    expect(message.text).toContain('https://app.example.net/join/abc');
  });

  it('writes the invitation in the requested language', async () => {
    const { sendInviteEmail } = await import('../../../src/services/inviteEmail.js');
    const emailNotifier = await import('../../../src/services/emailNotifier.js');

    await sendInviteEmail({ ...input, locale: 'es' }, NOW);

    expect(vi.mocked(emailNotifier.sendEmail).mock.calls[0][0].text).toContain('te ha invitado');
  });

  it('falls back to English for a language we do not ship', async () => {
    const { sendInviteEmail } = await import('../../../src/services/inviteEmail.js');
    const emailNotifier = await import('../../../src/services/emailNotifier.js');

    await sendInviteEmail({ ...input, locale: 'de' }, NOW);

    expect(vi.mocked(emailNotifier.sendEmail).mock.calls[0][0].text).toContain(
      'Accept the invitation'
    );
  });
});

describe('sendInviteEmail — refusing to mail an anonymous invitation', () => {
  it('sends nothing when the inviter name could not be read', async () => {
    const { sendInviteEmail } = await import('../../../src/services/inviteEmail.js');
    const emailNotifier = await import('../../../src/services/emailNotifier.js');
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');

    expect(await sendInviteEmail({ ...input, inviterName: null }, NOW)).toBe(
      'identity_unavailable'
    );
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
    // And it consumed nothing: no counter write, no recipient claim.
    expect(dynamodb.send).not.toHaveBeenCalled();
  });

  it('sends nothing when the household name could not be read', async () => {
    const { sendInviteEmail } = await import('../../../src/services/inviteEmail.js');
    const emailNotifier = await import('../../../src/services/emailNotifier.js');
    expect(await sendInviteEmail({ ...input, householdName: '   ' }, NOW)).toBe(
      'identity_unavailable'
    );
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
  });
});

describe('sendInviteEmail — the abuse bounds', () => {
  it('caps a household per day with a conditional counter, not a read-then-write', async () => {
    const { sendInviteEmail, DAILY_INVITE_EMAIL_CAP } =
      await import('../../../src/services/inviteEmail.js');
    await sendInviteEmail(input, NOW);

    const counter = (await sentCommands()).find((c) =>
      c.input.Key?.SK?.startsWith('INVITE_EMAIL_COUNT#')
    );
    expect(counter?.input.UpdateExpression).toContain('ADD #count :one');
    expect(counter?.input.ExpressionAttributeValues?.[':cap']).toBe(DAILY_INVITE_EMAIL_CAP);
    // Keyed by UTC day so the counter cannot be reset by hopping containers.
    expect(counter?.input.Key?.SK).toBe('INVITE_EMAIL_COUNT#2026-09-03');
  });

  it('reports rate_limited and sends nothing when the daily cap is spent', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockRejectedValueOnce(conditionalFailure());
    const { sendInviteEmail } = await import('../../../src/services/inviteEmail.js');
    const emailNotifier = await import('../../../src/services/emailNotifier.js');

    expect(await sendInviteEmail(input, NOW)).toBe('rate_limited');
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
  });

  it('refuses a second invitation to the same address the same day', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({} as never) // counter consumed
      .mockRejectedValueOnce(conditionalFailure()) // recipient already claimed
      .mockResolvedValueOnce({} as never); // refund
    const { sendInviteEmail } = await import('../../../src/services/inviteEmail.js');
    const emailNotifier = await import('../../../src/services/emailNotifier.js');

    expect(await sendInviteEmail(input, NOW)).toBe('recipient_cooldown');
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
    // The blocked attempt gave its allowance back.
    const refund = (await sentCommands()).find((c) =>
      c.input.UpdateExpression?.includes(':minusOne')
    );
    expect(refund).toBeDefined();
  });

  it('does not let address casing walk around the cooldown', async () => {
    const { sendInviteEmail } = await import('../../../src/services/inviteEmail.js');
    await sendInviteEmail(input, NOW);
    const first = (await sentCommands()).find((c) =>
      c.input.Item?.SK?.startsWith('INVITE_EMAIL_TO#')
    )?.input.Item?.SK;

    vi.clearAllMocks();
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({} as never);
    await sendInviteEmail({ ...input, to: '  FRIEND@Example.COM ' }, NOW);
    const second = (await sentCommands()).find((c) =>
      c.input.Item?.SK?.startsWith('INVITE_EMAIL_TO#')
    )?.input.Item?.SK;

    expect(second).toBe(first);
  });

  it('does not put the raw address in a sort key', async () => {
    const { sendInviteEmail } = await import('../../../src/services/inviteEmail.js');
    await sendInviteEmail(input, NOW);
    const marker = (await sentCommands()).find((c) =>
      c.input.Item?.SK?.startsWith('INVITE_EMAIL_TO#')
    )?.input.Item?.SK;
    expect(marker).not.toContain('friend@example.com');
    expect(marker).toMatch(/^INVITE_EMAIL_TO#[0-9a-f]{32}$/);
  });
});

describe('sendInviteEmail — honest failure', () => {
  it('reports unavailable on a dry run and refunds everything it took', async () => {
    const emailNotifier = await import('../../../src/services/emailNotifier.js');
    // sendEmail returns false when SES is unconfigured. That is not a delivery.
    vi.mocked(emailNotifier.sendEmail).mockResolvedValue(false);
    const { sendInviteEmail } = await import('../../../src/services/inviteEmail.js');

    expect(await sendInviteEmail(input, NOW)).toBe('unavailable');

    const commands = await sentCommands();
    expect(commands.some((c) => c.input.UpdateExpression?.includes(':minusOne'))).toBe(true);
    expect(
      commands.some((c) => c.kind === 'Delete' && c.input.Key?.SK?.startsWith('INVITE_EMAIL_TO#'))
    ).toBe(true);
  });

  it('rethrows a provider error after releasing the allowance, so a retry can work', async () => {
    const emailNotifier = await import('../../../src/services/emailNotifier.js');
    vi.mocked(emailNotifier.sendEmail).mockRejectedValue(new Error('ses exploded'));
    const { sendInviteEmail } = await import('../../../src/services/inviteEmail.js');

    await expect(sendInviteEmail(input, NOW)).rejects.toThrow('ses exploded');

    const commands = await sentCommands();
    expect(commands.some((c) => c.input.UpdateExpression?.includes(':minusOne'))).toBe(true);
    expect(commands.some((c) => c.kind === 'Delete')).toBe(true);
  });
});
