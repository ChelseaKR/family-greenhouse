#!/usr/bin/env node
/**
 * Turns a CloudWatch alarm snapshot into a redacted GitHub-issue report.
 *
 * ## Why this exists
 *
 * Every alarm in `infrastructure/modules/monitoring` routes its
 * `alarm_actions` to one SNS topic, and that topic's only destination is an
 * email subscription. Measured on 2026-09-12, the production chain is four
 * hops long:
 *
 *     alarm -> SNS family-greenhouse-alerts-production
 *           -> support@familygreenhouse.net
 *           -> SES inbound receipt rule (MX points at inbound-smtp, not a mailbox)
 *           -> the mail-forwarder Lambda
 *           -> the maintainer's real inbox
 *
 * Two properties of that chain are why this script exists rather than another
 * address being added somewhere:
 *
 *   1. It is self-referential. `family-greenhouse-mail-forwarder-dlq-not-empty`
 *      and `family-greenhouse-mail-not-relayed-unverified` are alarms ABOUT the
 *      forwarder, and their only route to a human runs THROUGH the forwarder.
 *      When the relay is the thing that broke, the alarm saying so cannot
 *      arrive.
 *   2. Every SNS notification email carries a one-click unsubscribe link. One
 *      misclick silences all of it, permanently and silently. The
 *      `alarms_have_a_notification_destination` check in the monitoring module
 *      catches an alerts topic with no subscriber, but only at plan time —
 *      between applies, nothing looks.
 *
 * So this reports to a GitHub issue instead. An issue needs no address, cannot
 * be unsubscribed from by accident, and is durable and numbered rather than a
 * colour in a tab. It does not replace the email path; it is a second channel
 * that fails independently of it.
 *
 * ## Redaction is an allowlist, not a filter
 *
 * This repository is public and its issues are world-readable, while the data
 * being summarised comes from a production stack that serves paying
 * households. The body this builds is therefore ASSEMBLED, never forwarded:
 * fixed prose, integers, and alarm names that matched a strict shape. Nothing
 * else from the input reaches it — not `StateReason` (which quotes metric
 * values), not dimensions, not ARNs (an ARN carries the AWS account id).
 *
 * `assertNoIdentifiers` then re-reads the finished body and throws if anything
 * identifier-shaped survived. It is deliberately redundant with `safeAlarmName`:
 * the allowlist is the guarantee, the scan is the proof, and
 * `alert-relay-report.test.mjs` sabotages the allowlist to show the scan
 * actually catches what it claims to.
 *
 * ## Three states, not two
 *
 * `examined === 0` is NOT health. Thirty-three alarms exist in this account; a
 * snapshot with none in it means the query failed, the credentials were wrong,
 * or the stack is gone — all of which are worse than an alarm firing, and all
 * of which an "any alarms in ALARM?" check reads as quiet. It is reported as
 * its own condition. (The threshold is "more than zero", not a hand-maintained
 * expected count, so this cannot drift into a number somebody has to update.)
 *
 * Run: `npm run test:checks` for the unit tests; the live path is
 * `.github/workflows/alert-relay.yml`.
 */

/** Shown in place of an alarm name that did not match the expected shape. */
export const REDACTED = '(name withheld: did not match the expected alarm-name shape)';

/**
 * The only alarm names allowed through verbatim.
 *
 * Every alarm in `infrastructure/modules/monitoring/main.tf` is named
 * `${project_name}-<something>-${environment}` from Terraform-controlled
 * strings, so lowercase words joined by single hyphens covers all of them and
 * admits nothing a person or a customer ever typed. An alarm created by hand
 * in the console, with a household name or an email in it, does not match and
 * is withheld.
 */
const SAFE_ALARM_NAME = /^family-greenhouse-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Patterns that must never appear in a body this script emits.
 *
 * Not a redaction mechanism — `safeAlarmName` is. This is the assertion that
 * the redaction worked, run against the finished text.
 */
const IDENTIFIER_PATTERNS = [
  { name: 'an email address', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: 'a 32-or-more-character hex literal', pattern: /\b[0-9a-fA-F]{32,}\b/ },
  {
    name: 'a UUID',
    pattern: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/,
  },
  { name: 'a 12-digit run (an AWS account id is 12 digits)', pattern: /\b\d{12}\b/ },
  { name: 'an ARN', pattern: /arn:aws[a-z-]*:/ },
  {
    name: 'a Stripe object id',
    pattern: /\b(?:cus|sub|pi|cs|price|prod|in|ch|evt)_[A-Za-z0-9]{8,}\b/,
  },
  { name: 'a bearer-token-shaped literal', pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]+\b/ },
];

/**
 * @param {string} name
 * @returns {string} `name` if it matched the allowlist, otherwise {@link REDACTED}.
 */
export function safeAlarmName(name) {
  return typeof name === 'string' && SAFE_ALARM_NAME.test(name) ? name : REDACTED;
}

/**
 * Throws if `text` contains anything identifier-shaped.
 *
 * @param {string} text
 * @param {string} [where] included in the error message so a failure says which body.
 */
export function assertNoIdentifiers(text, where = 'the report body') {
  for (const { name, pattern } of IDENTIFIER_PATTERNS) {
    const hit = pattern.exec(text);
    if (hit) {
      throw new Error(
        `refusing to publish ${where}: it contains ${name} (matched ${JSON.stringify(hit[0])}). ` +
          'This repository is public. Widen safeAlarmName only if the new shape is provably ' +
          'infrastructure-controlled; never widen assertNoIdentifiers to make a body pass.'
      );
    }
  }
}

const ALARM = 'ALARM';
const OK = 'OK';
const INSUFFICIENT_DATA = 'INSUFFICIENT_DATA';

/**
 * @typedef {object} AlarmSnapshot
 * @property {string} AlarmName
 * @property {string} StateValue
 */

/**
 * @typedef {object} TopicSnapshot
 * @property {string} name  topic NAME, never the ARN (an ARN carries the account id).
 * @property {number} subscriptionsConfirmed
 * @property {number} subscriptionsPending
 */

/**
 * Builds the issue title, body, and reporting decision from a snapshot.
 *
 * @param {object} input
 * @param {AlarmSnapshot[]} input.alarms
 * @param {TopicSnapshot} input.topic
 * @param {string} input.region
 * @param {(name: string) => string} [input.sanitize] injection point for the
 *   test's negative control. Production callers must not pass this.
 * @returns {{ shouldReport: boolean, title: string, body: string, state: string,
 *   counts: { examined: number, alarming: number, ok: number, insufficientData: number } }}
 */
export function buildReport({ alarms, topic, region, sanitize = safeAlarmName }) {
  if (!Array.isArray(alarms)) {
    throw new Error('buildReport: alarms must be an array (a failed query is not an empty one)');
  }
  if (!topic || typeof topic.name !== 'string') {
    throw new Error('buildReport: topic.name is required');
  }

  const examined = alarms.length;
  const alarming = alarms.filter((a) => a.StateValue === ALARM);
  const ok = alarms.filter((a) => a.StateValue === OK).length;
  const insufficientData = alarms.filter((a) => a.StateValue === INSUFFICIENT_DATA).length;

  const alarmingNames = alarming.map((a) => sanitize(a.AlarmName)).sort();
  const topicName = sanitize(topic.name) === REDACTED ? REDACTED : topic.name;
  const confirmed = Number(topic.subscriptionsConfirmed ?? 0);
  const pending = Number(topic.subscriptionsPending ?? 0);

  const noAlarmsFound = examined === 0;
  const noDestination = confirmed === 0;
  const anyAlarming = alarming.length > 0;
  const shouldReport = noAlarmsFound || noDestination || anyAlarming;

  // The fingerprint the workflow compares between runs so a standing condition
  // does not generate a comment every half hour. Built only from values already
  // proven safe above.
  // A withheld name collapses to the short token `withheld` rather than the
  // full placeholder sentence: the fingerprint is compared, not read, and
  // repeating a sentence once per withheld alarm would make the marker longer
  // than the report. Two different withheld alarms are indistinguishable here,
  // which `alarming=` already covers.
  const state = [
    `examined=${examined}`,
    `alarming=${alarming.length}`,
    `confirmed_subscribers=${confirmed}`,
    `names=${alarmingNames.map((n) => (n === REDACTED ? 'withheld' : n)).join('|') || 'none'}`,
  ].join(' ');

  let title;
  if (noAlarmsFound) {
    title = 'Alert relay: the alarm query returned nothing';
  } else if (noDestination && anyAlarming) {
    title = 'Alert relay: alarms are firing and the alerts topic has no confirmed subscriber';
  } else if (noDestination) {
    title = 'Alert relay: the alerts topic has no confirmed subscriber';
  } else if (anyAlarming) {
    title = 'Alert relay: CloudWatch alarms are in ALARM';
  } else {
    title = 'Alert relay: nothing to report';
  }

  const lines = [];
  lines.push(
    'Filed by `.github/workflows/alert-relay.yml`. It reads CloudWatch alarm state ' +
      'directly, so it reports whether or not the SNS email path is working — that ' +
      'independence is the point of it.'
  );
  lines.push('');
  lines.push('This issue is reused, not refiled. A human closes it; the relay never does.');
  lines.push('');
  lines.push('### Counts');
  lines.push('');
  lines.push(`- Alarms examined: **${examined}**`);
  lines.push(`- In \`ALARM\`: **${alarming.length}**`);
  lines.push(`- In \`OK\`: **${ok}**`);
  lines.push(`- In \`INSUFFICIENT_DATA\`: **${insufficientData}**`);
  lines.push(`- Confirmed subscribers on the alerts topic: **${confirmed}**`);
  lines.push(`- Pending (unconfirmed) subscriptions on that topic: **${pending}**`);
  lines.push('');

  if (noAlarmsFound) {
    lines.push('### The query returned no alarms');
    lines.push('');
    lines.push(
      'Zero alarms matched the project prefix. That is not the same as zero alarms firing: ' +
        'this stack defines its alarms in `infrastructure/modules/monitoring/main.tf` and they ' +
        'are applied in production, so an empty result means the query failed, the credentials ' +
        'were wrong or scoped to the wrong account, the region is wrong, or the alarms were ' +
        'deleted. Every one of those is a state in which nothing is watching anything.'
    );
    lines.push('');
  }

  if (noDestination) {
    lines.push('### The alerts topic has no confirmed subscriber');
    lines.push('');
    lines.push(
      `SNS topic \`${topicName}\` reports **${confirmed}** confirmed subscriptions` +
        (pending > 0 ? ` (and ${pending} pending confirmation)` : '') +
        '. Every alarm in this stack publishes there, so the email path currently ends nowhere. ' +
        'Most likely causes, in the order worth checking: someone followed the one-click ' +
        'unsubscribe link in an alert email; the subscription was never confirmed; or ' +
        "`alert_email` was emptied in this environment's tfvars. Re-subscribing needs no code " +
        'change, and `terraform plan` will also report the drift.'
    );
    lines.push('');
  }

  if (anyAlarming) {
    lines.push('### Alarms currently in `ALARM`');
    lines.push('');
    for (const name of alarmingNames) {
      lines.push(`- \`${name}\``);
    }
    lines.push('');
    lines.push(
      'Names only. Alarm `StateReason` text quotes metric values and dimensions and is ' +
        'deliberately not reproduced here — this repository is public.'
    );
    lines.push('');
  }

  lines.push('### Where the detail is');
  lines.push('');
  lines.push(
    `- CloudWatch alarms console (\`${region}\`, filtered to this project): ` +
      `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:alarmStateFilter=ALARM&search=family-greenhouse`
  );
  lines.push('- Lambda log groups: `/aws/lambda/family-greenhouse-*-production`');
  lines.push('- API access logs: `/aws/apigateway/family-greenhouse-production`');
  lines.push(
    '- The alarm descriptions in `infrastructure/modules/monitoring/main.tf` say what each ' +
      'one means and what to do about it.'
  );
  lines.push('');
  lines.push(`<!-- alert-relay-state: ${state} -->`);

  const body = lines.join('\n');
  assertNoIdentifiers(body);
  assertNoIdentifiers(title, 'the report title');

  return {
    shouldReport,
    title,
    body,
    state,
    counts: { examined, alarming: alarming.length, ok, insufficientData },
  };
}

/**
 * Pulls the `alert-relay-state` marker back out of an existing issue body.
 *
 * Used by the workflow to decide whether anything changed since the last run:
 * a standing condition rewrites the body (free, silent) but only comments when
 * this string differs.
 *
 * @param {string} body
 * @returns {string|null}
 */
export function extractState(body) {
  const m = /<!-- alert-relay-state: (.*?) -->/.exec(body ?? '');
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
//
// Reads the two AWS CLI responses the workflow captured, writes the finished
// title/body/state/decision into a directory the workflow's next step reads.
// Splitting it this way is what lets everything above be unit-tested without
// AWS credentials: the shell does the fetching, this does the judging, and the
// judging is the part that must never leak an identifier.

/**
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`--${key} requires a value`);
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

async function main() {
  const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');

  const args = parseArgs(process.argv.slice(2));
  for (const required of ['alarms', 'topic', 'region', 'out-dir']) {
    if (!args[required]) {
      throw new Error(`missing --${required}`);
    }
  }

  const alarmsJson = JSON.parse(readFileSync(args.alarms, 'utf8'));
  const topicJson = JSON.parse(readFileSync(args.topic, 'utf8'));

  // `MetricAlarms` missing entirely is a malformed response, which is a
  // different thing from an empty list, and is not allowed to degrade into one.
  if (!Array.isArray(alarmsJson.MetricAlarms)) {
    throw new Error('describe-alarms response has no MetricAlarms array');
  }
  const attributes = topicJson.Attributes;
  if (!attributes || typeof attributes.TopicArn !== 'string') {
    throw new Error('get-topic-attributes response has no Attributes.TopicArn');
  }

  const report = buildReport({
    alarms: alarmsJson.MetricAlarms,
    topic: {
      // Name only. The ARN is read to derive it and then dropped: it carries
      // the AWS account id, and this body is published publicly.
      name: attributes.TopicArn.split(':').pop(),
      subscriptionsConfirmed: Number(attributes.SubscriptionsConfirmed ?? 0),
      subscriptionsPending: Number(attributes.SubscriptionsPending ?? 0),
    },
    region: args.region,
  });

  const outDir = args['out-dir'];
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'should-report'), report.shouldReport ? 'true' : 'false');
  writeFileSync(join(outDir, 'title'), report.title);
  writeFileSync(join(outDir, 'body.md'), `${report.body}\n`);
  writeFileSync(join(outDir, 'state'), report.state);

  process.stdout.write(
    `alert-relay: examined=${report.counts.examined} alarming=${report.counts.alarming} ` +
      `report=${report.shouldReport}\n`
  );
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((error) => {
    // Loud, not quiet. A relay that cannot build its report must fail the
    // invocation rather than exit 0 with nothing to say — that would be the
    // same defect one layer up from the one it exists to fix.
    process.stderr.write(`alert-relay: ${error.message}\n`);
    process.exitCode = 1;
  });
}
