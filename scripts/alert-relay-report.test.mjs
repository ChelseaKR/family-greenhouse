#!/usr/bin/env node
/**
 * Unit tests for the redaction and the reporting decision in
 * `alert-relay-report.mjs`.
 *
 * ## What is actually being defended
 *
 * The relay publishes to a GitHub issue on a PUBLIC repository, from a
 * production stack that serves paying households. Everything else about the
 * design is replaceable; "an identifier can never reach the issue body" is
 * not. So the leak test below is the load-bearing one, and it is written so
 * that it can go red — the negative control at the bottom sabotages the
 * allowlist and proves the assertion notices.
 *
 * That control matters because of a failure mode this portfolio has measured
 * repeatedly: a redaction test whose fixture contains nothing the redactor
 * could have mishandled passes forever while redacting nothing. The fixture
 * here is deliberately hostile — alarm names carrying an email address, a
 * 32-hex literal, a UUID, an AWS account id and a full ARN — so the passing
 * case is evidence, not decoration.
 *
 * Run: `npm run test:checks`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REDACTED,
  assertNoIdentifiers,
  buildReport,
  extractState,
  safeAlarmName,
} from './alert-relay-report.mjs';

const REGION = 'us-east-1';

/** A healthy production topic: one confirmed subscriber, nothing pending. */
const SUBSCRIBED_TOPIC = {
  name: 'family-greenhouse-alerts-production',
  subscriptionsConfirmed: 1,
  subscriptionsPending: 0,
};

/**
 * Alarm names shaped like the ones Terraform actually creates. Taken from
 * `infrastructure/modules/monitoring/main.tf`.
 */
const REAL_ALARMS = [
  { AlarmName: 'family-greenhouse-api-5xx-production', StateValue: 'OK' },
  { AlarmName: 'family-greenhouse-stripe-webhook-no-grant-production', StateValue: 'ALARM' },
  { AlarmName: 'family-greenhouse-lambda-dlq-not-empty-production', StateValue: 'ALARM' },
  { AlarmName: 'family-greenhouse-ses-bounce-rate-production', StateValue: 'INSUFFICIENT_DATA' },
];

/**
 * Alarm names nobody should ever be able to publish. An alarm created by hand
 * in the console can be named anything, and "anything" on a stack with
 * customers means a household name, a support email, or an object id pasted in
 * while debugging.
 */
const HOSTILE_ALARMS = [
  { AlarmName: 'household someone@example.invalid is over quota', StateValue: 'ALARM' },
  { AlarmName: 'session 0123456789abcdef0123456789abcdef stuck', StateValue: 'ALARM' },
  { AlarmName: 'order 3f2504e0-4f89-11d3-9a0c-0305e82c3301 unsettled', StateValue: 'ALARM' },
  { AlarmName: 'account 000000000000 throttled', StateValue: 'ALARM' },
  { AlarmName: 'arn:aws:sns:us-east-1:000000000000:some-topic backed up', StateValue: 'ALARM' },
  { AlarmName: 'The Okonkwo-Bradbury household', StateValue: 'ALARM' },
];

test('a real alarm name passes the allowlist unchanged', () => {
  assert.equal(
    safeAlarmName('family-greenhouse-api-5xx-production'),
    'family-greenhouse-api-5xx-production'
  );
});

test('anything not shaped like a Terraform alarm name is withheld', () => {
  for (const { AlarmName } of HOSTILE_ALARMS) {
    assert.equal(safeAlarmName(AlarmName), REDACTED, `should have withheld: ${AlarmName}`);
  }
  // Not only the hostile ones: a name from the right project but with an
  // uppercase letter or a space is still outside the shape Terraform produces,
  // and "close enough" is exactly how a customer-supplied string gets through.
  assert.equal(safeAlarmName('family-greenhouse-API-5xx-production'), REDACTED);
  assert.equal(safeAlarmName('family-greenhouse chat errors'), REDACTED);
  assert.equal(safeAlarmName(undefined), REDACTED);
});

test('NO identifier from a hostile alarm name reaches the issue body', () => {
  const { body, title } = buildReport({
    alarms: HOSTILE_ALARMS,
    topic: SUBSCRIBED_TOPIC,
    region: REGION,
  });

  // Stated as literals rather than "no regex matched", so a reader can see
  // exactly what was withheld.
  assert.ok(!body.includes('someone@example.invalid'), 'an email address reached the body');
  assert.ok(
    !body.includes('0123456789abcdef0123456789abcdef'),
    'a 32-hex literal reached the body'
  );
  assert.ok(!body.includes('3f2504e0-4f89-11d3-9a0c-0305e82c3301'), 'a UUID reached the body');
  assert.ok(!body.includes('000000000000'), 'a 12-digit account id reached the body');
  assert.ok(!body.includes('arn:aws:'), 'an ARN reached the body');
  assert.ok(!body.includes('Okonkwo'), 'a household name reached the body');

  // And the withholding is visible, not silent: six alarms were in ALARM, so
  // six lines are present, all of them the placeholder. A report that simply
  // dropped the unsafe names would under-count the incident.
  assert.match(body, /In `ALARM`: \*\*6\*\*/);
  assert.equal(body.split(REDACTED).length - 1, 6);
  assert.doesNotMatch(title, /@/);
});

test('the guard is not vacuous: it rejects each identifier shape on its own', () => {
  const shouldThrow = [
    'contact someone@example.invalid about it',
    'digest 0123456789abcdef0123456789abcdef',
    'order 3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    'account 000000000000',
    'arn:aws:sns:us-east-1:000000000000:t',
  ];
  for (const text of shouldThrow) {
    assert.throws(
      () => assertNoIdentifiers(text),
      /refusing to publish/,
      `guard let this through: ${text}`
    );
  }
  // The counts-and-names body it is meant to allow must still pass, or the
  // guard would be "reject everything", which is not a guard either.
  assert.doesNotThrow(() =>
    assertNoIdentifiers('Alarms examined: **33**\n- `family-greenhouse-api-5xx-production`')
  );
});

test('NEGATIVE CONTROL: with the allowlist disabled, the leak test goes red', () => {
  // The mutation: replace `safeAlarmName` with the identity function, which is
  // precisely the regression this whole file exists to catch — someone deciding
  // the names "are just infrastructure" and passing them straight through.
  const sabotaged = (name) => name;

  // First, prove the mutation actually landed rather than silently no-opping:
  // the identity function really does return the hostile name verbatim.
  assert.equal(sabotaged(HOSTILE_ALARMS[0].AlarmName), HOSTILE_ALARMS[0].AlarmName);

  // With it in place, the final scan in buildReport catches the leak and
  // refuses to return a body at all. If this ever stops throwing, the guard
  // has stopped guarding and the test above is passing for free.
  assert.throws(
    () =>
      buildReport({
        alarms: HOSTILE_ALARMS,
        topic: SUBSCRIBED_TOPIC,
        region: REGION,
        sanitize: sabotaged,
      }),
    /refusing to publish the report body: it contains an email address/
  );
});

test('an alarm firing is reported', () => {
  const report = buildReport({ alarms: REAL_ALARMS, topic: SUBSCRIBED_TOPIC, region: REGION });

  assert.equal(report.shouldReport, true);
  assert.equal(report.counts.examined, 4);
  assert.equal(report.counts.alarming, 2);
  assert.equal(report.counts.insufficientData, 1);
  assert.match(report.title, /CloudWatch alarms are in ALARM/);
  assert.match(report.body, /family-greenhouse-lambda-dlq-not-empty-production/);
  // StateReason is never read, so there is nothing to leak from it even if a
  // future caller passes it in.
  assert.doesNotMatch(report.body, /Threshold Crossed/);
});

test('a topic with no confirmed subscriber is itself a reportable condition', () => {
  const report = buildReport({
    alarms: REAL_ALARMS.map((a) => ({ ...a, StateValue: 'OK' })),
    topic: { ...SUBSCRIBED_TOPIC, subscriptionsConfirmed: 0 },
    region: REGION,
  });

  assert.equal(report.shouldReport, true);
  assert.match(report.title, /no confirmed subscriber/);
  assert.match(report.body, /one-click unsubscribe/);
});

test('a pending-only subscription does not count as a destination', () => {
  // SNS reports an unconfirmed email subscription as pending. It delivers
  // nothing. Counting it would reproduce the original defect exactly: a
  // channel that looks wired and reaches nobody.
  const report = buildReport({
    alarms: REAL_ALARMS.map((a) => ({ ...a, StateValue: 'OK' })),
    topic: { ...SUBSCRIBED_TOPIC, subscriptionsConfirmed: 0, subscriptionsPending: 1 },
    region: REGION,
  });

  assert.equal(report.shouldReport, true);
  assert.match(report.body, /1 pending confirmation/);
});

test('an empty alarm list is reported as a broken query, never as health', () => {
  const report = buildReport({ alarms: [], topic: SUBSCRIBED_TOPIC, region: REGION });

  assert.equal(report.shouldReport, true);
  assert.match(report.title, /returned nothing/);
  assert.match(report.body, /nothing is watching anything/);
});

test('all quiet with a live subscriber reports nothing', () => {
  const report = buildReport({
    alarms: REAL_ALARMS.map((a) => ({ ...a, StateValue: 'OK' })),
    topic: SUBSCRIBED_TOPIC,
    region: REGION,
  });

  assert.equal(report.shouldReport, false);
});

test('a failed query is not an empty one', () => {
  assert.throws(
    () => buildReport({ alarms: null, topic: SUBSCRIBED_TOPIC, region: REGION }),
    /must be an array/
  );
});

test('the state marker round-trips and changes only when the state does', () => {
  const first = buildReport({ alarms: REAL_ALARMS, topic: SUBSCRIBED_TOPIC, region: REGION });
  const again = buildReport({ alarms: REAL_ALARMS, topic: SUBSCRIBED_TOPIC, region: REGION });
  assert.equal(extractState(first.body), first.state);
  assert.equal(extractState(again.body), first.state, 'a standing condition must not churn');

  const worse = buildReport({
    alarms: [
      ...REAL_ALARMS,
      { AlarmName: 'family-greenhouse-api-5xx-production', StateValue: 'ALARM' },
    ],
    topic: SUBSCRIBED_TOPIC,
    region: REGION,
  });
  assert.notEqual(worse.state, first.state, 'a new alarm must produce a new state');

  assert.equal(extractState('no marker here'), null);
});
