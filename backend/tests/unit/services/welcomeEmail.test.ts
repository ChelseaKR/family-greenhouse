import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DeleteCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
  }),
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/services/emailNotifier.js');

beforeEach(async () => {
  vi.clearAllMocks();
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  vi.mocked(dynamodb.send).mockResolvedValue({} as never);
});

describe('welcomeEmail.composeWelcomeEmail', () => {
  it('greets the user by name and points at the add-first-plant and care links', async () => {
    const { composeWelcomeEmail } = await import('../../../src/services/welcomeEmail.js');
    const { subject, text } = composeWelcomeEmail('Alice', 'https://app.example.net');
    expect(subject).toMatch(/welcome/i);
    expect(text).toContain('Hi Alice,');
    expect(text).toContain('https://app.example.net/plants/new');
    expect(text).toContain('https://app.example.net/care');
  });

  it('falls back to a generic greeting when the name is blank', async () => {
    const { composeWelcomeEmail } = await import('../../../src/services/welcomeEmail.js');
    const { text } = composeWelcomeEmail('   ', 'https://app.example.net');
    expect(text).toContain('Hi there,');
  });

  it('does not double up the slash when the base url has a trailing slash', async () => {
    const { composeWelcomeEmail } = await import('../../../src/services/welcomeEmail.js');
    const { text } = composeWelcomeEmail('Bo', 'https://app.example.net/');
    expect(text).toContain('https://app.example.net/plants/new');
    expect(text).not.toContain('https://app.example.net//plants/new');
  });
});

describe('welcomeEmail.sendWelcomeEmail', () => {
  it('sends exactly one email through the shared SES sender', async () => {
    const emailNotifier = await import('../../../src/services/emailNotifier.js');
    vi.mocked(emailNotifier.sendEmail).mockResolvedValueOnce(true);
    const { sendWelcomeEmail } = await import('../../../src/services/welcomeEmail.js');

    const ok = await sendWelcomeEmail('user-1', 'a@b.com', 'Alice', 'https://app.example.net');

    expect(ok).toBe(true);
    expect(emailNotifier.sendEmail).toHaveBeenCalledTimes(1);
    expect(emailNotifier.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@b.com', subject: expect.stringMatching(/welcome/i) })
    );
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    expect(
      vi
        .mocked(dynamodb.send)
        .mock.calls.map(([command]) => (command as unknown as { kind: string }).kind)
    ).toEqual(['Put', 'Update']);
  });

  it('reports a dry-run as not delivered', async () => {
    const emailNotifier = await import('../../../src/services/emailNotifier.js');
    vi.mocked(emailNotifier.sendEmail).mockResolvedValueOnce(false);
    const { sendWelcomeEmail } = await import('../../../src/services/welcomeEmail.js');

    await expect(
      sendWelcomeEmail('user-1', 'a@b.com', 'Alice', 'https://app.example.net')
    ).resolves.toBe(false);

    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    expect(
      vi
        .mocked(dynamodb.send)
        .mock.calls.map(([command]) => (command as unknown as { kind: string }).kind)
    ).toEqual(['Put', 'Delete']);
  });

  it('is best-effort: swallows an SES failure and returns false instead of throwing', async () => {
    const emailNotifier = await import('../../../src/services/emailNotifier.js');
    vi.mocked(emailNotifier.sendEmail).mockRejectedValueOnce(new Error('SES down'));
    const { sendWelcomeEmail } = await import('../../../src/services/welcomeEmail.js');

    await expect(
      sendWelcomeEmail('user-1', 'a@b.com', 'Alice', 'https://app.example.net')
    ).resolves.toBe(false);
  });

  it('skips an already-sent or actively-sending welcome before reaching SES', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const emailNotifier = await import('../../../src/services/emailNotifier.js');
    vi.mocked(dynamodb.send).mockRejectedValueOnce(
      Object.assign(new Error('claimed'), { name: 'ConditionalCheckFailedException' }) as never
    );
    const { sendWelcomeEmail } = await import('../../../src/services/welcomeEmail.js');

    await expect(
      sendWelcomeEmail('user-1', 'a@b.com', 'Alice', 'https://app.example.net')
    ).resolves.toBe(false);
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
  });

  it('does not reopen the slot when SES delivered but marker finalization fails', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const emailNotifier = await import('../../../src/services/emailNotifier.js');
    vi.mocked(emailNotifier.sendEmail).mockResolvedValueOnce(true);
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error('marker update failed'));
    const { sendWelcomeEmail } = await import('../../../src/services/welcomeEmail.js');

    await expect(
      sendWelcomeEmail('user-1', 'a@b.com', 'Alice', 'https://app.example.net')
    ).resolves.toBe(true);
    expect(
      vi
        .mocked(dynamodb.send)
        .mock.calls.map(([command]) => (command as unknown as { kind: string }).kind)
    ).toEqual(['Put', 'Update']);
  });

  it('releases an unconfigured dry-run so a later retry can deliver', async () => {
    const emailNotifier = await import('../../../src/services/emailNotifier.js');
    vi.mocked(emailNotifier.sendEmail).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { sendWelcomeEmail } = await import('../../../src/services/welcomeEmail.js');

    await expect(
      sendWelcomeEmail('user-1', 'a@b.com', 'Alice', 'https://app.example.net')
    ).resolves.toBe(false);
    await expect(
      sendWelcomeEmail('user-1', 'a@b.com', 'Alice', 'https://app.example.net')
    ).resolves.toBe(true);
    expect(emailNotifier.sendEmail).toHaveBeenCalledTimes(2);
  });
});
