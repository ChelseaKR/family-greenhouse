/**
 * Deployment wiring for reply-to-act (#667, ADR 0031).
 *
 * Two properties are pinned here, and both fail silently if they drift:
 *
 *   1. INERT BY DEFAULT. Every resource that makes SES deliver replies to the
 *      Lambda — the receipt rule, the SES invoke permission, the S3 grant — is
 *      counted on `email_reply_actions_enabled`, whose default is false, and the
 *      reminders Lambda only mints reply addresses when the same flag is on. So
 *      merging this and cutting a routine `v*` tag (which runs `terraform
 *      apply -auto-approve`) changes nothing a user can see.
 *   2. CONTAINED WHEN ON. The rule matches only `care@` (and so every
 *      `care+<token>@`), `care` is never a forwarded mailbox, and the Lambda
 *      can read only `replies/*` of the inbound bucket.
 *
 * Each negative control asserts its sabotage actually changed the text before
 * asserting that the check notices, so a replacement that silently matched
 * nothing cannot read as a pass.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repositoryRoot = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repositoryRoot), 'utf8');

const apiModule = read('infrastructure/modules/api/main.tf');
const apiVariables = read('infrastructure/modules/api/variables.tf');
const rootModule = read('infrastructure/main.tf');
const rootVariables = read('infrastructure/variables.tf');
const inbound = read('infrastructure/modules/email/inbound.tf');
const emailOutputs = read('infrastructure/modules/email/outputs.tf');
const monitoring = read('infrastructure/modules/monitoring/main.tf');

/** The body of one `resource "<type>" "<name>" { ... }` block. */
function resourceBlock(source: string, type: string, name: string): string | null {
  const start = source.indexOf(`resource "${type}" "${name}" {`);
  if (start === -1) return null;
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

const GATED = [
  ['aws_ses_receipt_rule', 'email_replies'],
  ['aws_lambda_permission', 'email_replies_ses'],
  ['aws_iam_role_policy', 'email_replies_inbound'],
] as const;

function isGated(source: string, type: string, name: string): boolean {
  const block = resourceBlock(source, type, name);
  return (
    block !== null && /^\s*count\s*=\s*var\.email_reply_actions_enabled \? 1 : 0$/m.test(block)
  );
}

function defaultIsFalse(source: string, variable: string): boolean {
  const start = source.indexOf(`variable "${variable}" {`);
  if (start === -1) return false;
  const block = source.slice(start, source.indexOf('\n}', start));
  return /type\s*=\s*bool/.test(block) && /default\s*=\s*false/.test(block);
}

describe('reply-to-act is inert until the owner turns it on', () => {
  it.each(GATED)('%s.%s is counted on email_reply_actions_enabled', (type, name) => {
    expect(isGated(apiModule, type, name)).toBe(true);
  });

  it('negative control: an ungated receipt rule is caught', () => {
    const sabotaged = apiModule.replace(
      /(resource "aws_ses_receipt_rule" "email_replies" \{\n)\s*count\s*=\s*var\.email_reply_actions_enabled \? 1 : 0\n/,
      '$1'
    );
    expect(sabotaged).not.toBe(apiModule);
    expect(isGated(sabotaged, 'aws_ses_receipt_rule', 'email_replies')).toBe(false);
  });

  it('defaults the switch to false at the root and in the api module', () => {
    expect(defaultIsFalse(rootVariables, 'email_reply_actions_enabled')).toBe(true);
    expect(defaultIsFalse(apiVariables, 'email_reply_actions_enabled')).toBe(true);
    const sabotaged = rootVariables.replace(
      /(variable "email_reply_actions_enabled" \{[\s\S]*?default\s*=\s*)false/,
      '$1true'
    );
    expect(sabotaged).not.toBe(rootVariables);
    expect(defaultIsFalse(sabotaged, 'email_reply_actions_enabled')).toBe(false);
  });

  it('never turns on without the email module', () => {
    expect(rootModule).toMatch(
      /email_reply_actions_enabled\s*=\s*var\.email_reply_actions_enabled && var\.domain_name != ""/
    );
  });

  it('mints reply addresses only from the same flag that creates the rule', () => {
    expect(apiModule).toMatch(
      /EMAIL_REPLY_ACTIONS_ENABLED = var\.email_reply_actions_enabled \? "true" : "false"/
    );
    expect(apiModule).toMatch(
      /EMAIL_REPLY_DOMAIN\s*=\s*var\.email_reply_actions_enabled \? var\.email_reply_domain : ""/
    );
    expect(apiModule).toMatch(/reminders\s*=\s*merge\([^\n]*local\.reply_environment\)/);
  });
});

describe('reply-to-act is contained when it is on', () => {
  const rule = resourceBlock(apiModule, 'aws_ses_receipt_rule', 'email_replies') ?? '';

  it('matches only care@ (SES then matches every care+<label>@)', () => {
    expect(rule).toMatch(/recipients\s*=\s*\["care@\$\{var\.email_reply_domain\}"\]/);
    expect(rule).toMatch(/object_key_prefix\s*=\s*"replies\/"/);
    expect(rule).toMatch(/function_arn\s*=\s*aws_lambda_function\.handlers\["emailReplies"\]\.arn/);
    expect(rule).toMatch(/invocation_type\s*=\s*"Event"/);
    expect(rule).toMatch(/scan_enabled\s*=\s*true/);
    expect(rule).toMatch(/after\s*=\s*var\.inbound_forward_rule_name/);
  });

  it('never forwards a care@ reply to the maintainer', () => {
    const mailboxes = /inbound_mailboxes\s*=\s*\[([^\]]*)\]/.exec(inbound)?.[1] ?? '';
    expect(mailboxes).toContain('"support"');
    expect(mailboxes).not.toContain('"care"');
  });

  it('lets the Lambda read and delete only replies/*', () => {
    const policy = resourceBlock(apiModule, 'aws_iam_role_policy', 'email_replies_inbound') ?? '';
    expect(policy).toMatch(/Resource = "\$\{var\.inbound_mail_bucket_arn\}\/replies\/\*"/);
    expect(policy).toMatch(/Action\s*=\s*\["s3:GetObject", "s3:DeleteObject"\]/);
  });

  it('expires stored replies after a few days even if the Lambda never runs', () => {
    expect(inbound).toMatch(
      /id\s*=\s*"expire-task-replies"[\s\S]*?prefix = "replies\/"[\s\S]*?days = 3/
    );
  });

  it('builds the invoke permission against the exact rule name', () => {
    expect(apiModule).toMatch(/email_reply_rule_name = "reply-to-act"/);
    const permission = resourceBlock(apiModule, 'aws_lambda_permission', 'email_replies_ses') ?? '';
    expect(permission).toMatch(/principal\s*=\s*"ses\.amazonaws\.com"/);
    expect(permission).toMatch(/receipt-rule\/\$\{local\.email_reply_rule_name\}/);
  });

  it('exposes the inbound rule set and bucket from the email module', () => {
    for (const output of [
      'inbound_rule_set_name',
      'inbound_forward_rule_name',
      'inbound_mail_bucket_name',
      'inbound_mail_bucket_arn',
    ]) {
      expect(emailOutputs).toContain(`output "${output}"`);
      expect(rootModule).toMatch(new RegExp(`${output}\\s*=.*module\\.email\\[0\\]\\.${output}`));
    }
  });
});

describe('the emailReplies function ships like every other handler', () => {
  it('is a handler in the fleet with the reply bucket in its environment', () => {
    expect(apiModule).toMatch(/"emailReplies" = "emailReplies"/);
    expect(apiModule).toMatch(/EMAIL_REPLY_BUCKET = var\.inbound_mail_bucket_name/);
  });

  it('is deployed by every deploy loop', () => {
    for (const workflow of [
      '.github/workflows/cd-staging.yml',
      '.github/workflows/cd-production.yml',
    ]) {
      const loops = read(workflow).match(/for handler in [^\n]*; do/g) ?? [];
      expect(loops.length).toBeGreaterThan(0);
      for (const loop of loops) expect(loop).toMatch(/\bemailReplies\b/);
    }
    expect(read('scripts/deploy.sh')).toMatch(/HANDLERS=\([^)]*\bemailReplies\b[^)]*\)/);
  });

  it('alarms on a single error, like the other functions nobody is watching', () => {
    expect(monitoring).toMatch(/-\([^)]*\bemailReplies\b[^)]*\)-/);
  });
});
