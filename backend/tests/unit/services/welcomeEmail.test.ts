import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/emailNotifier.js');

beforeEach(() => {
  vi.clearAllMocks();
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
    vi.mocked(emailNotifier.sendEmail).mockResolvedValueOnce(undefined);
    const { sendWelcomeEmail } = await import('../../../src/services/welcomeEmail.js');

    const ok = await sendWelcomeEmail('user-1', 'a@b.com', 'Alice', 'https://app.example.net');

    expect(ok).toBe(true);
    expect(emailNotifier.sendEmail).toHaveBeenCalledTimes(1);
    expect(emailNotifier.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@b.com', subject: expect.stringMatching(/welcome/i) })
    );
  });

  it('is best-effort: swallows an SES failure and returns false instead of throwing', async () => {
    const emailNotifier = await import('../../../src/services/emailNotifier.js');
    vi.mocked(emailNotifier.sendEmail).mockRejectedValueOnce(new Error('SES down'));
    const { sendWelcomeEmail } = await import('../../../src/services/welcomeEmail.js');

    await expect(
      sendWelcomeEmail('user-1', 'a@b.com', 'Alice', 'https://app.example.net')
    ).resolves.toBe(false);
  });
});
