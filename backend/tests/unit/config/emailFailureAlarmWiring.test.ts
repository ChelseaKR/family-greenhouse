/**
 * The alarm on email that did not go out, and the contract it has with the code.
 *
 * From v0.24.0 to v0.53.1 nearly every app email failed: SES refused 1,427
 * messages and 529 household-email queue writes were rejected in the last 30
 * days of logs alone. Every failure was caught where it happened, logged at
 * WARN, and the run returned normally, so no alarm fired and no metric moved.
 *
 * The alarm counts those per-attempt log lines. That makes the message names a
 * contract between two languages that neither compiler can see across:
 *
 *   - a counted message the code no longer logs is an alarm that can never
 *     fire (a rename un-alarms a path with no other symptom), and
 *   - a failure message the code logs but nobody counted is the next silent
 *     outage, added by omission.
 *
 * Both directions are checked here, against the committed source, along with
 * the wiring that puts the filters on every handler's log group and the
 * threshold that decides what pages.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const monitoring = read('infrastructure/modules/monitoring/main.tf');
const monitoringVariables = read('infrastructure/modules/monitoring/variables.tf');
const apiOutputs = read('infrastructure/modules/api/outputs.tf');
const terraformRoot = read('infrastructure/main.tf');

/** The body of one `resource "TYPE" "NAME" { ... }` block, or '' if absent. */
function tfResource(source: string, type: string, name: string): string {
  const header = `resource "${type}" "${name}" {`;
  const start = source.indexOf(header);
  if (start === -1) return '';
  let depth = 0;
  for (let i = start + header.length - 1; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return '';
}

/** The quoted strings of a `name = [ ... ]` list in a locals block. */
function tfStringList(source: string, name: string): string[] {
  const match = new RegExp(`\\n\\s*${name}\\s*=\\s*\\[([^\\]]*)\\]`, 'u').exec(source);
  if (!match) return [];
  return [...match[1].matchAll(/^\s*"([^"]+)",?/gmu)].map(([, message]) => message);
}

const sendMessages = tfStringList(monitoring, 'email_send_failure_messages');
const queueMessages = tfStringList(monitoring, 'email_queue_failure_messages');
const counted = new Set([...sendMessages, ...queueMessages]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Comments removed, so prose that names a message cannot satisfy a check. */
const stripComments = (source: string) =>
  source.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/^\s*\/\/.*$/gmu, '');

const backend = sourceFiles(join(ROOT, 'backend/src')).map((path) => ({
  path: relative(ROOT, path),
  code: stripComments(readFileSync(path, 'utf8')),
}));

const escape = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * Whether some backend file logs `message` as a pino message: the string
 * argument after the fields object, at any level. The fields object in every
 * logger call this alarm reads is flat, so `[^{};]*` spans it exactly.
 */
const isLogged = (message: string) =>
  backend.some(({ code }) =>
    new RegExp(
      `logger\\.(?:info|warn|error)\\(\\s*\\{[^{};]*\\}\\s*,\\s*'${escape(message)}'\\s*,?\\s*\\)`,
      'u'
    ).test(code)
  );

/**
 * A message that, by its name, says an email was not sent: it ends in
 * `send_failed` or `email_failed`, or it belongs to the household-email queue
 * or the suppression store. Deliberately a name rule, so it needs no list of
 * its own to stay current.
 */
const looksLikeEmailFailure = (message: string) =>
  /(?:^|[._])(?:send|email)_failed$/u.test(message) ||
  /^household_email\.[a-z_]+_failed$/u.test(message) ||
  /^email_suppression[._][a-z_]+_failed$/u.test(message);

/**
 * Email-failure messages the alarm does NOT count, each with the reason. Adding
 * a message here is a decision, which is the point: the default for a new one
 * is to fail this test until somebody makes it.
 */
const NOT_COUNTED: Record<string, string> = {
  apns_send_failed: 'An iOS push, not an email.',
  'household_email.finalize_failed':
    'SES already accepted the email; only the dedupe marker write failed, so the risk is a duplicate, not a missing email.',
  'household_email.item_parse_failed':
    'One queued item could not be parsed and is left out of a body that is still sent.',
  email_outage_notice_send_failed:
    'The one-time outage notice runs from an operator terminal, not a Lambda, so it never reaches a log group; the script exits 1 and names the failed count.',
};

/** What the 2026-09 to 2026-11 outage actually logged (production, 30 days). */
const OUTAGE_MESSAGES = [
  'email_failed',
  'digest.send_failed',
  'welcome_email_failed',
  'trial_email.send_failed',
  'household_email.up_for_grabs_failed',
  'household_email.care_credit_failed',
  'email_suppression.batch_failed',
];

describe('email failure alarm', () => {
  it('reads both message lists out of the monitoring module', () => {
    // Guards the parser: an empty list would make every check below vacuous.
    expect(sendMessages.length).toBeGreaterThan(5);
    expect(queueMessages.length).toBeGreaterThan(5);
    expect(counted.size).toBe(sendMessages.length + queueMessages.length);
  });

  it('counts every message the outage logged', () => {
    for (const message of OUTAGE_MESSAGES) {
      expect(counted, message).toContain(message);
    }
  });

  it('counts only messages the backend still logs', () => {
    for (const message of counted) {
      expect(isLogged(message), `${message} is counted but no logger call emits it`).toBe(true);
    }
  });

  it('counts or explicitly excludes every email-failure message the backend logs', () => {
    const logged = new Set(
      backend.flatMap(({ code }) =>
        [...code.matchAll(/'([a-z][a-z0-9_.]*)'/gu)]
          .map(([, message]) => message)
          .filter((message) => looksLikeEmailFailure(message) && isLogged(message))
      )
    );
    // The rule has to find something, or it proves nothing.
    expect(logged.size).toBeGreaterThan(10);
    for (const message of logged) {
      expect(
        counted.has(message) || message in NOT_COUNTED,
        `${message} is logged as an email failure but neither counted by the EmailFailures filters nor listed in NOT_COUNTED`
      ).toBe(true);
    }
    // And the exclusions stay real, so the list cannot rot into cover.
    for (const message of Object.keys(NOT_COUNTED)) {
      expect(isLogged(message), `${message} is excluded but no longer logged`).toBe(true);
      expect(counted, message).not.toContain(message);
    }
  });

  it('puts both filters on every handler log group and publishes one metric', () => {
    expect(apiOutputs).toMatch(
      /output "lambda_log_group_names" \{[\s\S]*?value\s*=\s*\{ for handler, group in aws_cloudwatch_log_group\.lambda : handler => group\.name \}/u
    );
    expect(terraformRoot).toMatch(
      /lambda_log_group_names\s*=\s*module\.api\.lambda_log_group_names/u
    );
    expect(monitoringVariables).toMatch(
      /variable "lambda_log_group_names" \{[\s\S]*?map\(string\)/u
    );
    for (const name of ['email_send_failed', 'email_queue_failed']) {
      const filter = tfResource(monitoring, 'aws_cloudwatch_log_metric_filter', name);
      expect(filter, name).toMatch(/for_each\s*=\s*var\.lambda_log_group_names/u);
      expect(filter, name).toMatch(/log_group_name\s*=\s*each\.value/u);
      expect(filter, name).toMatch(/name\s*=\s*"EmailFailures"/u);
      expect(filter, name).toContain('namespace     = "FamilyGreenhouse/Email/${var.environment}"');
      expect(filter, name).toMatch(/value\s*=\s*"1"/u);
    }
  });

  it('keeps each filter pattern within the CloudWatch Logs limit, and says so at plan', () => {
    // Built the way the locals block builds it.
    const pattern = (messages: string[]) =>
      `{ ${messages.map((message) => `$.msg = "${message}"`).join(' || ')} }`;
    expect(monitoring).toContain(
      'email_send_failure_pattern  = "{ ${join(" || ", [for message in local.email_send_failure_messages : "$.msg = \\"${message}\\""])} }"'
    );
    expect(monitoring).toMatch(/metric_filter_pattern_max_length = 1024/u);
    for (const messages of [sendMessages, queueMessages]) {
      expect(pattern(messages).length).toBeLessThanOrEqual(1024);
    }
    for (const name of ['email_send_failed', 'email_queue_failed']) {
      expect(tfResource(monitoring, 'aws_cloudwatch_log_metric_filter', name), name).toMatch(
        /precondition \{\s*condition\s*=\s*length\(local\.email_(?:send|queue)_failure_pattern\) <= local\.metric_filter_pattern_max_length/u
      );
    }
  });

  it('pages the alerts topic on five failures in a day, not on one', () => {
    const alarm = tfResource(monitoring, 'aws_cloudwatch_metric_alarm', 'email_failures');
    expect(alarm).not.toBe('');
    expect(alarm).toMatch(
      /count\s*=\s*var\.enable_alarms && length\(var\.lambda_log_group_names\) > 0 \? 1 : 0/u
    );
    expect(alarm).toMatch(/metric_name\s*=\s*"EmailFailures"/u);
    expect(alarm).toContain('namespace           = "FamilyGreenhouse/Email/${var.environment}"');
    expect(alarm).toMatch(/statistic\s*=\s*"Sum"/u);
    expect(alarm).toMatch(/comparison_operator\s*=\s*"GreaterThanThreshold"/u);
    // A rolling day: wide enough for the rare senders, and the outage this is
    // for ran at about 65 failures a day.
    expect(alarm).toMatch(/\n\s+period\s*=\s*86400\n/u);
    expect(alarm).toMatch(/evaluation_periods\s*=\s*1\n/u);
    // GreaterThan 4: five pages, one throttled send or a bad request does not.
    expect(alarm).toMatch(/threshold\s*=\s*4\n/u);
    expect(alarm).toMatch(/alarm_actions\s*=\s*\[aws_sns_topic\.alerts\.arn\]/u);
    expect(alarm).toMatch(/ok_actions\s*=\s*\[aws_sns_topic\.alerts\.arn\]/u);
    // No failure lines is the healthy answer, not a missing signal.
    expect(alarm).toMatch(/treat_missing_data\s*=\s*"notBreaching"/u);
  });
});
