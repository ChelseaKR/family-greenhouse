/**
 * Deployment wiring for the confirm-email reminder (services/confirmReminders.ts).
 *
 * Each item here fails silently when it is missing. Without the SES grant every
 * suppression lookup is AccessDenied, which the pass reads as "unknown" and so
 * defers every account forever: no reminder ever goes out and nothing errors.
 * Without the pass in the hourly handler the service exists and never runs.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repositoryRoot = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repositoryRoot), 'utf8');

describe('confirm-reminder deployment wiring', () => {
  it('lets the Lambda role read the SES account-level suppression list', () => {
    const apiModule = read('infrastructure/modules/api/main.tf');
    expect(apiModule).toMatch(/Action\s*=\s*\["ses:GetSuppressedDestination"\]/);
  });

  it('does not widen the shared Lambda role to list the user pool', () => {
    // The pass finds accounts through its own sign-up rows precisely so that no
    // handler sharing this role can enumerate every user's address.
    const apiModule = read('infrastructure/modules/api/main.tf');
    expect(apiModule).not.toContain('cognito-idp:ListUsers');
  });

  it('runs the pass from the hourly handler the deploy workflows actually publish', () => {
    const handler = read('backend/src/handlers/reminders/handler.ts');
    expect(handler).toMatch(/await runConfirmReminders\(/);
    for (const workflow of [
      '.github/workflows/cd-production.yml',
      '.github/workflows/cd-staging.yml',
    ]) {
      expect(read(workflow)).toMatch(/for handler in [^\n]*\breminders\b/);
    }
    const apiModule = read('infrastructure/modules/api/main.tf');
    expect(apiModule).toMatch(/resource "aws_cloudwatch_event_rule" "reminders"/);
  });

  it('records every sign-up the auth handler creates', () => {
    const auth = read('backend/src/handlers/auth/handler.ts');
    expect(auth).toMatch(/await recordSignup\(created\?\.UserSub/);
    // The auth bundle must not pull in the SES client with the reminder pass.
    // Import lines only: the handler's comments name that service on purpose.
    expect(auth).toMatch(
      /^import \{ recordSignup \} from '\.\.\/\.\.\/services\/signupConfirmRecord\.js';$/m
    );
    expect(auth).not.toMatch(/^import[^;]*services\/confirmReminders/m);
  });
});
