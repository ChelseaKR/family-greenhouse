#!/usr/bin/env node
/**
 * Unit tests for the pure predicates in `telemetry-delivery-check.mjs`.
 *
 * Why these exist at all — the same reason `synthetic-page-check.test.mjs`
 * does. That script only ever runs against a live origin (the fifteen-minute
 * `uptime.yml` cron), so nothing in PR CI executes a line of it, and its
 * `--expect-failure` negative control is coarse: it passes as long as SOME
 * assertion fails, so one that quietly stopped discriminating is invisible.
 *
 * `pendingDeployReason` is the predicate that most needs pinning, because it
 * makes the check exit 0 on a shape that used to exit 1. A predicate that can
 * suppress a failure has to be tested in BOTH directions or it becomes a way
 * for a real outage to read as green — which is the defect it was written to
 * remove, pointed the other way.
 *
 * The fixtures are the response bodies production actually returned while
 * issue #639 was open.
 *
 * Run: `npm run test:checks`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { pendingDeployReason, postFailures } from './telemetry-delivery-check.mjs';

/** Verbatim from production on 2026-09-05, while #639 was open. */
const PREDATES_THE_KIND = JSON.stringify({
  message: 'Validation failed',
  details: { kind: ["Invalid discriminator value. Expected 'error' | 'vital'"] },
});

test('a build that predates the delivery kind is reported as pending, not broken', () => {
  const reason = pendingDeployReason({
    status: 400,
    body: PREDATES_THE_KIND,
    kind: 'delivery',
  });

  assert.ok(reason, 'the exact production rejection must be recognised as a pending deploy');
  assert.match(reason, /pending deploy/);
  assert.match(reason, /"delivery"/);
});

test('the pending outcome suppresses the status failure and nothing else', () => {
  const reason = pendingDeployReason({ status: 400, body: PREDATES_THE_KIND, kind: 'delivery' });

  // CORS still holds: a pending deploy explains the status, not a missing header.
  assert.deepEqual(
    postFailures({
      status: 400,
      allowOrigin: 'https://familygreenhouse.net',
      origin: 'https://familygreenhouse.net',
      pendingDeploy: reason,
    }),
    []
  );

  const corsBroken = postFailures({
    status: 400,
    allowOrigin: null,
    origin: 'https://familygreenhouse.net',
    pendingDeploy: reason,
  });
  assert.equal(corsBroken.length, 1);
  assert.match(corsBroken[0], /access-control-allow-origin/);
});

test('without the pending reason the same 400 is still a failure', () => {
  const failures = postFailures({
    status: 400,
    allowOrigin: 'https://familygreenhouse.net',
    origin: 'https://familygreenhouse.net',
  });

  assert.equal(failures.length, 1);
  assert.match(failures[0], /POST returned HTTP 400/);
});

test('a production that lists our kind and still rejects it is NOT pending', () => {
  // If `delivery` is deployed and the payload is refused anyway, something is
  // genuinely wrong. Swallowing this is the failure mode these tests exist for.
  const body = JSON.stringify({
    message: 'Validation failed',
    details: { kind: ["Invalid discriminator value. Expected 'error' | 'vital' | 'delivery'"] },
  });

  assert.equal(pendingDeployReason({ status: 400, body, kind: 'delivery' }), null);
});

test('a 400 about any other field is NOT pending', () => {
  const body = JSON.stringify({
    message: 'Validation failed',
    details: { sessionId: ['Required'] },
  });

  assert.equal(pendingDeployReason({ status: 400, body, kind: 'delivery' }), null);
});

test('statuses other than 400 are never pending', () => {
  for (const status of [0, 200, 401, 404, 429, 500, 502]) {
    assert.equal(
      pendingDeployReason({ status, body: PREDATES_THE_KIND, kind: 'delivery' }),
      null,
      `HTTP ${status} must not be excused as a pending deploy`
    );
  }
});

test('an unreadable or empty body is not evidence of anything', () => {
  for (const body of ['', 'not json at all', '<html>502 Bad Gateway</html>', undefined, null]) {
    assert.equal(pendingDeployReason({ status: 400, body, kind: 'delivery' }), null);
  }
});
