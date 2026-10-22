/**
 * Deployment wiring for the trial lifecycle emails (ADR 0039).
 *
 * INERT BY DEFAULT: the variable defaults to false and is false in the
 * committed production tfvars; with it off the digests Lambda has no
 * TRIAL_LIFECYCLE_EMAILS_ENABLED and the daily rule is DISABLED, so merging
 * this and cutting a routine release changes nothing a household can see.
 *
 * Each negative control asserts its sabotage changed the text before asserting
 * the check notices, so a replacement that matched nothing cannot read as a pass.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

const apiModule = read('infrastructure/modules/api/main.tf');
const apiVariables = read('infrastructure/modules/api/variables.tf');
const rootModule = read('infrastructure/main.tf');
const rootVariables = read('infrastructure/variables.tf');
const tfvars = read('infrastructure/environments/production/terraform.tfvars');

const variableBlock = (source: string, name: string): string => {
  const start = source.indexOf(`variable "${name}" {`);
  if (start < 0) return '';
  return source.slice(start, source.indexOf('\n}\n', start) + 3);
};

const ruleBlock = (source: string): string => {
  const start = source.indexOf('resource "aws_cloudwatch_event_rule" "trial_emails" {');
  if (start < 0) return '';
  return source.slice(start, source.indexOf('\n}\n', start) + 3);
};

const defaultsOff = (source: string): boolean =>
  /type\s+=\s+bool/.test(variableBlock(source, 'trial_lifecycle_emails_enabled')) &&
  /default\s+=\s+false/.test(variableBlock(source, 'trial_lifecycle_emails_enabled'));

describe('trial lifecycle emails: off by default', () => {
  it('both variable declarations are bool and default false', () => {
    expect(defaultsOff(rootVariables)).toBe(true);
    expect(defaultsOff(apiVariables)).toBe(true);
  });

  it('the committed production tfvars leave it false, and the root passes it to the api module', () => {
    expect(tfvars).toMatch(/^trial_lifecycle_emails_enabled\s*=\s*false\s*$/m);
    expect(rootModule).toMatch(
      /trial_lifecycle_emails_enabled\s*=\s*var\.trial_lifecycle_emails_enabled/
    );
  });

  it('the rule is disabled unless the flag is on, and carries the trialEmails job', () => {
    const rule = ruleBlock(apiModule);
    expect(rule).toMatch(
      /state\s*=\s*var\.trial_lifecycle_emails_enabled \? "ENABLED" : "DISABLED"/
    );
    expect(apiModule).toContain('input = jsonencode({ job = "trialEmails" })');
    expect(apiModule).toContain('aws_cloudwatch_event_rule.trial_emails.arn,');
  });

  it('the environment variable is set on digests only when the flag is on', () => {
    expect(apiModule).toMatch(
      /digests\s*=\s*merge\(local\.email_environment, var\.trial_lifecycle_emails_enabled \? \{ TRIAL_LIFECYCLE_EMAILS_ENABLED = "true" \} : \{\}\)/
    );
  });
});

describe('the checks notice a regression (negative controls)', () => {
  it('a default flipped to true is caught', () => {
    const sabotaged = rootVariables.replace(
      /(variable "trial_lifecycle_emails_enabled" \{[\s\S]*?default\s+=\s+)false/,
      '$1true'
    );
    expect(sabotaged).not.toBe(rootVariables);
    expect(defaultsOff(sabotaged)).toBe(false);
  });

  it('a rule that is always ENABLED is caught', () => {
    const rule = ruleBlock(apiModule);
    const sabotaged = rule.replace(
      /state\s*=\s*var\.trial_lifecycle_emails_enabled \? "ENABLED" : "DISABLED"/,
      'state = "ENABLED"'
    );
    expect(sabotaged).not.toBe(rule);
    expect(sabotaged).not.toMatch(/var\.trial_lifecycle_emails_enabled \? "ENABLED" : "DISABLED"/);
  });

  it('a tfvars that turns it on is caught', () => {
    const sabotaged = tfvars.replace(
      /^trial_lifecycle_emails_enabled\s*=\s*false\s*$/m,
      'trial_lifecycle_emails_enabled = true'
    );
    expect(sabotaged).not.toBe(tfvars);
    expect(sabotaged).not.toMatch(/^trial_lifecycle_emails_enabled\s*=\s*false\s*$/m);
  });
});
