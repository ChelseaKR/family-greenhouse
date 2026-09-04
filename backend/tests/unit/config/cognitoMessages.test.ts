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
  request: { codeParameter?: string; usernameParameter?: string };
  response: { emailSubject?: string; emailMessage?: string };
}

async function load() {
  return (await import(/* @vite-ignore */ MODULE_URL.href)) as {
    handler: (event: CustomMessageEvent) => Promise<CustomMessageEvent>;
    forgotPasswordMessage: (code: string) => string;
    adminInviteMessage: (username: string, code: string) => string;
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
