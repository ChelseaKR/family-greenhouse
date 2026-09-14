/**
 * The Cognito CustomMessage trigger
 * (`infrastructure/modules/email/lambda/cognitoMessages.mjs`).
 *
 * It is a Lambda, not backend source, but it renders the one email a
 * locked-out user has to trust, and the failure modes are silent: dropping
 * `{####}` sends a reset email with no code in it; overriding SignUp replaces
 * the pool's own template with nothing; returning a bare string instead of the
 * event makes Cognito fall back to its stock copy. None of those throw.
 */
import { describe, expect, it } from 'vitest';

const MODULE_URL = new URL(
  '../../../../infrastructure/modules/email/lambda/cognitoMessages.mjs',
  import.meta.url
);

interface CustomMessageEvent {
  triggerSource: string;
  request: {
    codeParameter?: string;
    usernameParameter?: string;
    clientMetadata?: Record<string, string>;
  };
  response: { emailSubject?: string; emailMessage?: string };
}

async function load() {
  return (await import(/* @vite-ignore */ MODULE_URL.href)) as {
    handler: (event: CustomMessageEvent) => Promise<CustomMessageEvent>;
    forgotPasswordMessage: (code: string) => string;
    adminInviteMessage: (username: string, code: string) => string;
    confirmReminderMessage: (code: string) => string;
    REMINDER_PURPOSE: string;
  };
}

function event(triggerSource: string): CustomMessageEvent {
  return {
    triggerSource,
    request: { codeParameter: '{####}', usernameParameter: '{username}' },
    response: {},
  };
}

describe('Cognito CustomMessage trigger', () => {
  it('renders the ONE confirm reminder for a resend carrying the reminder switch', async () => {
    const { handler, REMINDER_PURPOSE } = await load();
    const { REMINDER_CLIENT_METADATA } = await import('../../../src/services/confirmReminders.js');
    // The value the backend sends must be the value this trigger reads, or
    // every reminder silently goes out as a second copy of the welcome email.
    expect(REMINDER_PURPOSE).toBe(REMINDER_CLIENT_METADATA.purpose);

    const result = await handler({
      triggerSource: 'CustomMessage_ResendCode',
      request: { codeParameter: '{####}', clientMetadata: { purpose: REMINDER_PURPOSE } },
      response: {},
    });

    expect(result.response.emailSubject).toBe(
      'Finish setting up Family Greenhouse — here is a new code'
    );
    // Losing the placeholder sends a reminder with no code in it.
    expect(result.response.emailMessage).toContain('{####}');
    expect(result.response.emailMessage).toMatch(/^Hi there,/);
    expect(result.response.emailMessage).toContain(
      'open https://familygreenhouse.net/confirm-email and enter the email address'
    );
    expect(result.response.emailMessage).toContain("This is the only reminder we'll send.");
    expect(result.response.emailMessage).toMatch(/safely\s+ignore this email/);
  });

  it('carries no tracking: plain links to our own site, no query string, no image', async () => {
    const { confirmReminderMessage } = await load();
    const body = confirmReminderMessage('{####}');
    const urls = body.match(/https?:\/\/\S+/g) ?? [];

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(new URL(url).hostname).toBe('familygreenhouse.net');
      expect(url).not.toMatch(/[?#&=]/);
    }
    expect(body).not.toMatch(/<img|utm_|pixel|redirect/i);
  });

  it('keeps the pool template for a person pressing Resend, whatever the metadata says', async () => {
    const { handler } = await load();
    const metadataVariants: Array<Record<string, string> | undefined> = [
      undefined,
      {},
      { purpose: 'something-else' },
      { purpose: 'CONFIRM-REMINDER' },
    ];
    for (const clientMetadata of metadataVariants) {
      const result = await handler({
        triggerSource: 'CustomMessage_ResendCode',
        request: { codeParameter: '{####}', clientMetadata },
        response: {},
      });
      expect(result.response.emailMessage).toBeUndefined();
      expect(result.response.emailSubject).toBeUndefined();
    }
    // The switch belongs to ResendCode only: the sign-up email itself never
    // becomes a reminder.
    const signUp = await handler({
      triggerSource: 'CustomMessage_SignUp',
      request: { codeParameter: '{####}', clientMetadata: { purpose: 'confirm-reminder' } },
      response: {},
    });
    expect(signUp.response.emailMessage).toBeUndefined();
  });

  it("renders a branded forgot-password body carrying Cognito's code placeholder", async () => {
    const { handler } = await load();
    const result = await handler(event('CustomMessage_ForgotPassword'));
    expect(result.response.emailSubject).toBe('Reset your Family Greenhouse password');
    // The placeholder is substituted by Cognito. Losing it sends a reset email
    // with no code in it — the worst possible version of this message.
    expect(result.response.emailMessage).toContain('{####}');
    expect(result.response.emailMessage).toContain('Family Greenhouse');
    // Same voice as the sign-up template: greet, explain, reassure.
    expect(result.response.emailMessage).toMatch(/^Hi there,/);
    expect(result.response.emailMessage).toMatch(/safely ignore this email/);
  });

  it('renders the admin invite with BOTH the username and password placeholders', async () => {
    const { handler } = await load();
    const result = await handler(event('CustomMessage_AdminCreateUser'));
    expect(result.response.emailMessage).toContain('{username}');
    expect(result.response.emailMessage).toContain('{####}');
    expect(result.response.emailSubject).toContain('Family Greenhouse');
  });

  it("leaves every other trigger source to the pool's own template", async () => {
    const { handler } = await load();
    for (const source of [
      'CustomMessage_SignUp',
      'CustomMessage_ResendCode',
      'CustomMessage_VerifyUserAttribute',
      'CustomMessage_UpdateUserAttribute',
    ]) {
      const result = await handler(event(source));
      // Writing an empty string here would send an EMPTY email; returning the
      // event untouched is how Cognito is told "no override".
      expect(result.response.emailMessage).toBeUndefined();
      expect(result.response.emailSubject).toBeUndefined();
    }
  });

  it('returns the whole event object, which is the trigger contract', async () => {
    const { handler } = await load();
    const input = event('CustomMessage_ForgotPassword');
    const result = await handler(input);
    expect(result).toBe(input);
    expect(result.triggerSource).toBe('CustomMessage_ForgotPassword');
  });

  it('never hardcodes the placeholder tokens in the renderers themselves', async () => {
    const { forgotPasswordMessage, adminInviteMessage } = await load();
    // Cognito hands the token in on the event. Hardcoding "{####}" would
    // break silently if Cognito ever changed it.
    expect(forgotPasswordMessage('<CODE>')).toContain('<CODE>');
    expect(forgotPasswordMessage('<CODE>')).not.toContain('{####}');
    expect(adminInviteMessage('<USER>', '<PASS>')).toContain('<USER>');
    expect(adminInviteMessage('<USER>', '<PASS>')).toContain('<PASS>');
  });
});
