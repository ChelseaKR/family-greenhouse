#!/usr/bin/env node
/**
 * Telemetry delivery check: prove a browser could still deliver an error
 * report, and leave a heartbeat behind saying so.
 *
 * ## Why this exists (issue #576)
 *
 * `frontend/src/services/frontendTelemetry.ts` posts every browser error to
 * `POST /telemetry/frontend`. That is the only delivery path, and it runs
 * through the API the rail also exists to report failures of. When the API is
 * unreachable, or CORS is misconfigured, or the route is renamed, the report
 * that would raise the alarm is exactly the thing that cannot be sent — and
 * the alarm reading those reports is a metric filter with
 * `treat_missing_data = "notBreaching"`, so it sits green.
 *
 * The CORS case is the sharpest, and the repo already knew about it.
 * `infrastructure/modules/api/main.tf:45-51`, on the managed CORS block:
 *
 *   > strict browsers (Safari, Firefox) reject the preflight before the
 *   > request reaches Lambda — failure mode is a silent CORS block with no
 *   > log on our side.
 *
 * "No log on our side" means the server cannot detect it. Only a client can,
 * and every real client that hits it is silenced by definition. So the check
 * has to be a synthetic client, which is this.
 *
 * ## What it asserts, and why each one
 *
 * A browser sending `Content-Type: application/json` cross-origin issues a
 * CORS preflight first and refuses to send the real request unless the
 * preflight answers correctly. So this does both halves, in order:
 *
 *   Preflight (`OPTIONS`, with `Origin` + `Access-Control-Request-*`):
 *     1. A 2xx. API Gateway's managed CORS answers 204.
 *     2. `access-control-allow-origin` echoing the site origin exactly. The
 *        API sets `allow_credentials = true`, which makes a `*` wildcard
 *        invalid to a browser — so `*` is a failure here, not a pass.
 *     3. `access-control-allow-methods` including POST.
 *     4. `access-control-allow-headers` including content-type. This is the
 *        exact row the Terraform comment above is about.
 *
 *   The real request (`POST`, with `Origin` and a valid payload):
 *     5. HTTP 204, which is what the handler's `noContentResponse()` returns.
 *        A 404 means the route moved, a 401 means auth was added to a public
 *        endpoint, a 400 means the schema drifted from what the browser sends,
 *        a 429 means the rate limit is eating reports. All of them are today
 *        invisible, because the browser discards the resolved response.
 *     6. `access-control-allow-origin` on the RESPONSE. A browser that does
 *        not see it discards the response and rejects the promise even though
 *        the server processed the request. Preflight passing does not imply
 *        this passes; they are configured together and can drift apart.
 *
 * ## The heartbeat
 *
 * The payload is a real `kind: "delivery"` report with `source: "synthetic"`.
 * It lands in the API Lambda log group like any other, where a metric filter
 * turns it into `FrontendTelemetryProbe`. Because this runs on a fixed
 * schedule rather than when someone happens to visit, that metric has a floor
 * — and a metric with a floor is one whose absence means something, which is
 * what makes `treat_missing_data = "breaching"` honest on the alarm that reads
 * it. `FrontendErrors` has no floor and never will, which is why the fix for
 * #576 could not be "flip that alarm to breaching".
 *
 * So a failure here is reported twice, deliberately: immediately as a red
 * workflow, and within ~2 hours as a CloudWatch alarm into the alerts SNS
 * topic — the routing #464 asked for.
 *
 * ## `--expect-failure`
 *
 * Inverts the exit code, the same way `synthetic-page-check.mjs` does, so
 * `uptime.yml` can prove this check is still capable of failing. Pointed at
 * the site origin, where `/telemetry/frontend` is not an API route, every
 * assertion above should fail.
 *
 * Zero dependencies on purpose: global `fetch` and `node:crypto`, no npm
 * install, so the job stays a checkout plus one `node` invocation.
 *
 * Usage:
 *   node scripts/telemetry-delivery-check.mjs \
 *     --health-url https://api.example/production/health \
 *     --origin https://familygreenhouse.net
 *
 *   node scripts/telemetry-delivery-check.mjs \
 *     --health-url https://familygreenhouse.net/health \
 *     --origin https://familygreenhouse.net --expect-failure
 */
import { randomUUID } from 'node:crypto';
import process from 'node:process';

const DEFAULT_TIMEOUT_MS = 20_000;

/** What `noContentResponse()` in backend/src/utils/response.ts returns. */
const EXPECTED_POST_STATUS = 204;

/**
 * Derive the telemetry endpoint from the health URL the uptime workflow
 * already has, rather than introducing a second repository variable that can
 * drift from the first. `.../production/health` -> `.../production/telemetry/frontend`.
 */
export function telemetryUrlFromHealthUrl(healthUrl) {
  const url = new URL(healthUrl);
  const suffix = '/health';
  if (!url.pathname.endsWith(suffix)) {
    throw new Error(
      `--health-url must end in ${suffix} so the telemetry endpoint can be derived from it; got ${url.pathname}`
    );
  }
  url.pathname = `${url.pathname.slice(0, -suffix.length)}/telemetry/frontend`;
  url.search = '';
  url.hash = '';
  return url.href;
}

/** Case-insensitive, comma-separated header membership. */
function listIncludes(headerValue, token) {
  return (headerValue ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .includes(token);
}

/**
 * Evaluate the CORS preflight. Pure: takes what the response gave us and
 * returns the reasons a browser would refuse to send the real request.
 */
export function preflightFailures({ status, allowOrigin, allowMethods, allowHeaders, origin }) {
  const failures = [];

  if (status < 200 || status > 299) {
    failures.push(`preflight HTTP ${status} (expected 2xx) — a browser stops here`);
  }

  if (allowOrigin !== origin) {
    // `*` is called out separately because it looks like a pass and is not:
    // the API sets allow_credentials = true, and a browser rejects the
    // wildcard for a credentialed request.
    const seen = allowOrigin === null ? '<missing>' : `"${allowOrigin}"`;
    failures.push(
      allowOrigin === '*'
        ? 'preflight access-control-allow-origin is "*", which a browser rejects because the API sets allow_credentials = true'
        : `preflight access-control-allow-origin is ${seen} (expected "${origin}")`
    );
  }

  if (!listIncludes(allowMethods, 'post') && allowMethods !== '*') {
    failures.push(
      `preflight access-control-allow-methods is ${allowMethods === null ? '<missing>' : `"${allowMethods}"`} (expected it to include POST)`
    );
  }

  if (!listIncludes(allowHeaders, 'content-type') && allowHeaders !== '*') {
    failures.push(
      `preflight access-control-allow-headers is ${allowHeaders === null ? '<missing>' : `"${allowHeaders}"`} (expected it to include Content-Type) — this is the silent-CORS-block row from infrastructure/modules/api/main.tf`
    );
  }

  return failures;
}

/**
 * Evaluate the real POST. Pure, for the same reason as above: the assertions
 * are the point of this script and must be readable and testable on their own.
 */
export function postFailures({ status, allowOrigin, origin }) {
  const failures = [];

  if (status !== EXPECTED_POST_STATUS) {
    failures.push(
      `POST returned HTTP ${status} (expected ${EXPECTED_POST_STATUS}) — the browser discards this outcome today, so a renamed route, a schema change, added auth or the rate limiter all look identical to a delivered report`
    );
  }

  if (allowOrigin !== origin) {
    const seen = allowOrigin === null ? '<missing>' : `"${allowOrigin}"`;
    failures.push(
      `POST response access-control-allow-origin is ${seen} (expected "${origin}") — the server processed the report but a browser would discard the response and reject the promise`
    );
  }

  return failures;
}

/** The synthetic heartbeat body. Must satisfy `frontendTelemetrySchema`. */
export function probePayload() {
  return {
    kind: 'delivery',
    source: 'synthetic',
    sessionId: randomUUID(),
    route: '/',
    undelivered: 0,
    ageMinutes: 0,
  };
}

async function request(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'manual' });
    return { ok: true, response };
  } catch (error) {
    // DNS, TLS, connection reset, or the abort above — all of them are the
    // outage this check exists to see.
    return { ok: false, reason: error instanceof Error ? (error.name ?? 'Error') : 'Error' };
  } finally {
    clearTimeout(timer);
  }
}

/** Run both halves against one endpoint. Never throws for a network failure. */
export async function checkDelivery(telemetryUrl, origin, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const steps = [];

  const preflight = await request(
    telemetryUrl,
    {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
        'User-Agent': 'family-greenhouse-telemetry-delivery-check',
      },
    },
    timeoutMs
  );

  if (!preflight.ok) {
    steps.push({
      step: 'preflight',
      status: 0,
      failures: [`request failed (${preflight.reason})`],
    });
  } else {
    const headers = preflight.response.headers;
    steps.push({
      step: 'preflight',
      status: preflight.response.status,
      failures: preflightFailures({
        status: preflight.response.status,
        allowOrigin: headers.get('access-control-allow-origin'),
        allowMethods: headers.get('access-control-allow-methods'),
        allowHeaders: headers.get('access-control-allow-headers'),
        origin,
      }),
    });
  }

  // The POST runs even when the preflight failed: knowing whether the endpoint
  // itself still works is worth the second request when diagnosing which half
  // broke, and it is one request every fifteen minutes.
  const post = await request(
    telemetryUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'User-Agent': 'family-greenhouse-telemetry-delivery-check',
      },
      body: JSON.stringify(probePayload()),
    },
    timeoutMs
  );

  if (!post.ok) {
    steps.push({ step: 'post', status: 0, failures: [`request failed (${post.reason})`] });
  } else {
    steps.push({
      step: 'post',
      status: post.response.status,
      failures: postFailures({
        status: post.response.status,
        allowOrigin: post.response.headers.get('access-control-allow-origin'),
        origin,
      }),
    });
  }

  return steps;
}

/** Minimal flag parser, matching scripts/synthetic-page-check.mjs. */
function parseArgs(argv) {
  const options = { expectFailure: false, timeoutMs: DEFAULT_TIMEOUT_MS };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return next;
    };

    if (arg === '--health-url') options.healthUrl = value();
    else if (arg === '--origin') options.origin = value();
    else if (arg === '--timeout-ms') options.timeoutMs = Number(value());
    else if (arg === '--expect-failure') options.expectFailure = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.healthUrl) throw new Error('--health-url is required');
  if (!options.origin) throw new Error('--origin is required');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }
  // Normalize away a trailing slash: a browser's Origin header never has one,
  // and the header comparisons above are exact.
  options.origin = new URL(options.origin).origin;
  return options;
}

export async function main(argv) {
  const options = parseArgs(argv);
  const telemetryUrl = telemetryUrlFromHealthUrl(options.healthUrl);
  const steps = await checkDelivery(telemetryUrl, options.origin, options.timeoutMs);

  console.log(`Origin: ${options.origin}`);
  console.log(`Endpoint: ${telemetryUrl}`);
  for (const result of steps) {
    if (result.failures.length === 0) {
      console.log(`ok    ${result.step} (HTTP ${result.status})`);
    } else {
      console.log(`FAIL  ${result.step} (HTTP ${result.status})`);
      for (const failure of result.failures) console.log(`        ✗ ${failure}`);
    }
  }

  const failed = steps.filter((result) => result.failures.length > 0);

  if (options.expectFailure) {
    if (failed.length === 0) {
      console.error(
        `\nNegative control FAILED: both steps passed, but --expect-failure means at least one had to fail. ` +
          `The telemetry delivery check can no longer detect a broken reporting path, so it is no longer a check.`
      );
      return 1;
    }
    console.log(
      `\nNegative control OK: ${failed.length} of ${steps.length} step(s) failed as required.`
    );
    return 0;
  }

  if (failed.length > 0) {
    console.error(
      `\nTelemetry delivery check FAILED for ${failed.length} of ${steps.length} step(s).\n` +
        `Browser error reports are not reaching CloudWatch right now, and nothing else would have said so: ` +
        `the FrontendErrors alarm reads an absence of reports as health (issue #576).`
    );
    return 1;
  }

  console.log(
    `\nTelemetry delivery check OK: a browser at ${options.origin} can deliver an error report, ` +
      `and the heartbeat that proves it is now in the API log group.`
  );
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
