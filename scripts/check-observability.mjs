#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const slo = read('observability/slos.yaml');
const monitoring = read('infrastructure/modules/monitoring/main.tf');
const apiTf = read('infrastructure/modules/api/main.tf');
const apiHandler = read('backend/src/handlers/api/handler.ts');
const telemetryModel = read('backend/src/models/telemetry.ts');
const frontendAnalytics = read('frontend/src/services/analytics.ts');
const browser = read('frontend/src/services/frontendTelemetry.ts');
const main = read('frontend/src/main.tsx');
const telemetryBoot = read('frontend/src/telemetryBoot.ts');
const deliveryCheck = read('scripts/telemetry-delivery-check.mjs');
const boundary = read('frontend/src/components/RouteErrorBoundary.tsx');
const production = read('.github/workflows/cd-production.yml');
const rootInfrastructure = read('infrastructure/main.tf');
const monitoringVars = read('infrastructure/modules/monitoring/variables.tf');
const uptimeWorkflow = read('.github/workflows/uptime.yml');
const observabilityDoc = read('docs/observability.md');
const indexHtml = read('frontend/index.html');
const responseUtil = read('backend/src/utils/response.ts');
const syntheticPageCheck = read('scripts/synthetic-page-check.mjs');
const frontendTf = read('infrastructure/modules/frontend/main.tf');
const spaRouter = read('infrastructure/modules/frontend/functions/spa-router.js');
const syntheticPageCheckTest = read('scripts/synthetic-page-check.test.mjs');

/**
 * The body of one `resource "TYPE" "NAME" { ... }` block, or '' if absent.
 *
 * Terraform resource bodies in this repo are one nesting level deep at most
 * for the attributes these checks read, so a brace counter is enough and
 * avoids a HCL parser dependency in a gate that must stay a few milliseconds.
 */
function tfResource(source, type, name) {
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

const siteHealthCheck = tfResource(monitoring, 'aws_route53_health_check', 'site');
const apiHealthCheck = tfResource(monitoring, 'aws_route53_health_check', 'api');
const siteAlarm = tfResource(monitoring, 'aws_cloudwatch_metric_alarm', 'site_unreachable');
const apiAlarm = tfResource(monitoring, 'aws_cloudwatch_metric_alarm', 'api_unreachable');
const frontendErrorsAlarm = tfResource(
  monitoring,
  'aws_cloudwatch_metric_alarm',
  'frontend_errors'
);
const undeliveredFilter = tfResource(
  monitoring,
  'aws_cloudwatch_log_metric_filter',
  'frontend_reports_undelivered'
);
const probeFilter = tfResource(
  monitoring,
  'aws_cloudwatch_log_metric_filter',
  'frontend_telemetry_probe'
);
const undeliveredAlarm = tfResource(
  monitoring,
  'aws_cloudwatch_metric_alarm',
  'frontend_reports_undelivered'
);
const probeAlarm = tfResource(
  monitoring,
  'aws_cloudwatch_metric_alarm',
  'frontend_telemetry_unreportable'
);

/**
 * Source with comments removed, so an assertion about CODE is not satisfied or
 * defeated by prose. `frontendTelemetry.ts` explains the fire-and-forget
 * sender it replaced by quoting it, and a whole-file search for that quote
 * would otherwise read the explanation as the defect.
 */
function stripComments(source) {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/^\s*\/\/.*$/gmu, '');
}

/**
 * The same, for HCL, whose comments start with `#`. modules/frontend/main.tf
 * explains the removed `404 -> 200` rescue by naming it, and a whole-file
 * search would otherwise read the explanation as the rescue.
 */
function stripHclComments(source) {
  return source.replaceAll(/^\s*#.*$/gmu, '');
}

/**
 * The first `import` statement in a module, which is the one whose side
 * effects run before every other module body. Null when there is none.
 */
function firstImportLine(source) {
  return /^import\b.*$/mu.exec(source)?.[0] ?? null;
}

/** The `telemetry-delivery` job of the uptime workflow, or '' if absent. */
const deliveryJob = (() => {
  const start = uptimeWorkflow.indexOf('\n  telemetry-delivery:');
  return start === -1 ? '' : uptimeWorkflow.slice(start);
})();

/**
 * The default value of a Terraform `variable` block, unescaped from HCL's
 * quoted-string form. Returns null when the variable or its default is absent.
 */
function tfVariableDefault(source, name) {
  const header = `variable "${name}" {`;
  const start = source.indexOf(header);
  if (start === -1) return null;
  const match = /^\s*default\s*=\s*"((?:[^"\\]|\\.)*)"/mu.exec(source.slice(start));
  return match ? match[1].replaceAll('\\"', '"').replaceAll('\\\\', '\\') : null;
}

const siteSearchString = tfVariableDefault(monitoringVars, 'site_health_check_search_string');
const apiSearchString = tfVariableDefault(monitoringVars, 'api_health_check_search_string');
const productionDeployBackend = production.slice(
  production.indexOf('  deploy-backend:'),
  production.indexOf('\n  smoke-tests:')
);

const frontendEventBlock = frontendAnalytics.slice(
  frontendAnalytics.indexOf('export type EventName ='),
  frontendAnalytics.indexOf('export interface EventProps')
);
const backendEventStart = telemetryModel.indexOf('export const productEventNames = [');
const backendEventBlock = telemetryModel.slice(
  backendEventStart,
  telemetryModel.indexOf('] as const;', backendEventStart)
);
const eventNames = (block) => [...block.matchAll(/'([a-z][a-z0-9_]*)'/gu)].map((match) => match[1]);
const frontendEventNames = eventNames(frontendEventBlock);
const backendEventNames = eventNames(backendEventBlock);

const checks = [
  ['28-day SLO window', /window_days:\s*28/u.test(slo)],
  ['99.5% availability target', /target_percent:\s*99\.5/u.test(slo)],
  ['health route excluded from SLO', /exclude_routes:[\s\S]*GET \/health/u.test(slo)],
  ['500ms p95 latency objective', /objective:\s*p95 <= 500ms/u.test(slo)],
  ['Core Web Vitals targets', /LCP_ms:\s*2500[\s\S]*CLS:\s*0\.1[\s\S]*INP_ms:\s*200/u.test(slo)],
  ['real API ID CloudWatch dimension', /ApiId", var\.api_gateway_id/u.test(monitoring)],
  ['HTTP API 4xx/5xx metric names', /"5xx"[\s\S]*"4xx"/u.test(monitoring)],
  ['legacy REST error metric names removed', !/(?:4XXError|5XXError)/u.test(monitoring)],
  ['application health exclusion filter', /routeKey != \\"GET \/health\\"/u.test(monitoring)],
  [
    'latency SLO metric and p95 alarm',
    /ApplicationLatency/u.test(monitoring) &&
      /extended_statistic\s*=\s*"p95"/u.test(monitoring) &&
      /threshold\s*=\s*500/u.test(monitoring),
  ],
  ['access-log latency fields', /responseLatency[\s\S]*integrationLatency/u.test(apiTf)],
  [
    'frontend telemetry route wired',
    /POST \/telemetry\/frontend/u.test(apiHandler) && /"POST \/telemetry\/frontend"/u.test(apiTf),
  ],
  [
    'product telemetry route wired',
    /POST \/telemetry\/product/u.test(apiHandler) && /"POST \/telemetry\/product"/u.test(apiTf),
  ],
  [
    'local and Lambda telemetry share strict schemas',
    /frontendTelemetrySchema, productTelemetrySchema/u.test(read('backend/src/local-server.ts')) &&
      /\.strict\(\)/u.test(telemetryModel),
  ],
  [
    'frontend and backend product event vocabularies match',
    JSON.stringify(frontendEventNames) === JSON.stringify(backendEventNames),
  ],
  // Was `/initFrontendTelemetry\(\)/.test(main)`, which passed from anywhere
  // in main.tsx — including where it used to be, at line 26, AFTER every
  // import's body had already run (issue #576). ES modules evaluate
  // dependencies before the importing module, so React, the whole ./App route
  // tree, ./i18n and both stores were all evaluated with no error handler
  // installed. Asserting the CALL exists is not the same as asserting it
  // happens first, so this now asserts the position.
  [
    'browser telemetry is hooked before any other module body runs',
    firstImportLine(main) === "import './telemetryBoot';" &&
      /^initFrontendTelemetry\(\);$/mu.test(telemetryBoot) &&
      !/initFrontendTelemetry\(\)/u.test(main),
  ],
  ['React boundary reports failures', /reportFrontendError\(error\)/u.test(boundary)],
  ['browser telemetry omits stacks', !/stack:/u.test(browser)],
  [
    'release SHA included in frontend and backend deploys',
    /VITE_GIT_SHA:\s*\$\{\{ needs\.validate\.outputs\.commit_sha \}\}/u.test(production) &&
      /TF_VAR_git_sha:\s*\$\{\{ needs\.validate\.outputs\.commit_sha \}\}/u.test(production),
  ],
  [
    'release SHA reaches Lambda configuration',
    /git_sha\s*=\s*var\.git_sha/u.test(rootInfrastructure),
  ],
  // A scheduled run that swallowed every per-household error returns normally
  // and logs at WARN, so it produces no Lambda Errors point, nothing in the
  // DLQ and no signal at all — indistinguishable from a quiet week. These four
  // checks are what stop that state coming back.
  [
    'reminders emits a run summary carrying its failure count',
    /msg: 'reminders\.run_complete'/u.test(read('backend/src/services/reminders.ts')) &&
      /failed,/u.test(read('backend/src/services/reminders.ts')),
  ],
  [
    'scheduled-run failure metric filters exist for reminders and digests',
    /reminders\.run_complete\\" && \$\.failed > 0/u.test(monitoring) &&
      /digest\.run_complete\\" && \$\.failed > 0/u.test(monitoring) &&
      /recap\.run_complete\\" && \$\.failed > 0/u.test(monitoring),
  ],
  [
    'scheduled-run failures alarm above zero',
    /aws_cloudwatch_metric_alarm" "reminders_run_failed/u.test(monitoring) &&
      /aws_cloudwatch_metric_alarm" "digests_run_failed/u.test(monitoring),
  ],
  // The old flat `> 5 Sum over 2 consecutive periods` was unreachable for an
  // async function: EventBridge retries a target at most 4 times, so a totally
  // broken run emits AT MOST 5 Errors points and 5 is not > 5. The alarm on
  // `reminders` — kept per-function precisely because an async failure
  // surfaces nowhere else — could not fire for the failure it existed for.
  [
    'async lambdas alarm on a single error, and digests/emailEvents are covered',
    /-\(reminders\|digests\|emailEvents\)-/u.test(monitoring) &&
      /contains\(local\.scheduled_lambda_names, each\.value\) \? 0 : 5/u.test(monitoring),
  ],
  // #458. The scheduled fan-out now stops on a deadline and resumes next run
  // instead of being killed by the Lambda timeout mid-list. That is the fix,
  // but it converts a timeout (a Lambda `Errors` point the alarm above fires
  // on) into a successful return — so without a signal of its own, "the job
  // could not get through the fleet" would go back to being invisible. These
  // three checks are what keep it visible.
  [
    'scheduled runs report whether they finished the fleet',
    /truncated: fanOut\.truncated/u.test(read('backend/src/services/reminders.ts')) &&
      /truncated: fanOut\.truncated/u.test(read('backend/src/services/digest.ts')) &&
      /summary\.truncated = fanOut\.truncated/u.test(
        read('backend/src/services/householdEmails.ts')
      ),
  ],
  [
    'scheduled-run truncation metric filters exist for reminders and digests',
    /reminders\.run_complete\\" && \$\.truncated IS TRUE/u.test(monitoring) &&
      /household_email\.run_complete\\" && \$\.truncated IS TRUE/u.test(monitoring) &&
      /digest\.run_complete\\" && \$\.truncated IS TRUE/u.test(monitoring) &&
      /recap\.run_complete\\" && \$\.truncated IS TRUE/u.test(monitoring),
  ],
  [
    'scheduled-run truncation alarms above zero',
    /aws_cloudwatch_metric_alarm" "reminders_run_truncated/u.test(monitoring) &&
      /aws_cloudwatch_metric_alarm" "digests_run_truncated/u.test(monitoring),
  ],
  // reputation_metrics_enabled has been on since the email module shipped; the
  // numbers it publishes were watched by nothing. A paused SES identity's
  // first symptom is that password resets stop.
  [
    'SES bounce and complaint rates are alarmed',
    /namespace\s*=\s*"AWS\/SES"/u.test(monitoring) &&
      /Reputation\.BounceRate/u.test(monitoring) &&
      /Reputation\.ComplaintRate/u.test(monitoring) &&
      /ConfigurationSetName = var\.ses_configuration_set_name/u.test(monitoring),
  ],
  // ---------------------------------------------------------------------
  // External availability (#464). Every alarm above reads a metric this stack
  // publishes and treats missing data as not-breaching, so none of them can
  // see "the stack served nobody". On 2026-09-04 the production frontend 403'd
  // every route but `/` for forty minutes, no alarm fired, and a human found
  // it. These checks are what stop that state coming back.
  // ---------------------------------------------------------------------
  [
    'a Route53 health check watches the site from outside AWS',
    /type\s*=\s*"HTTPS_STR_MATCH"/u.test(siteHealthCheck) &&
      /request_interval\s*=\s*30/u.test(siteHealthCheck) &&
      /enable_sni\s*=\s*true/u.test(siteHealthCheck),
  ],
  // A plain HTTPS check passes on any 200. The outage served a 403 from a
  // healthy CDN, and the next one may serve a 200 of something that is not
  // this app; the string match is what tells those apart.
  [
    'the site health check requires the app identity string, not merely a 200',
    siteSearchString !== null && siteSearchString.includes('og:site_name'),
  ],
  // `apiHealthCheck` was extracted alongside the other three and then never
  // asserted — the alarm that reads it was checked, and the probe it reads
  // FROM was not. So the API check could be a plain HTTP GET on a 10-minute
  // interval with no SNI and every gate here stayed green, because nothing
  // looked. Found by `lint:scripts` (#443) as an unused binding, which is the
  // only reason it surfaced at all: a variable pulled out for checking and
  // then not checked leaves no other trace.
  //
  // Asserted even though the API probe defaults OFF (`count = 0`). The HCL is
  // committed either way, and the moment someone flips it on is exactly the
  // moment nobody re-reads its shape.
  [
    'the API health check, when enabled, probes the way the site check does',
    /type\s*=\s*"HTTPS_STR_MATCH"/u.test(apiHealthCheck) &&
      /request_interval\s*=\s*30/u.test(apiHealthCheck) &&
      /enable_sni\s*=\s*true/u.test(apiHealthCheck),
  ],
  // The coupling that keeps the string honest. Route 53 can only match a
  // literal, so if the tag's markup changes the health check starts failing
  // against a healthy site. Failing HERE means that lands as a red pre-push
  // rather than as a false page at 3am.
  [
    'the site health check string is markup this app actually emits',
    siteSearchString !== null && indexHtml.includes(siteSearchString),
  ],
  // `/` was the ONE route still answering 200 during the outage. A health
  // check on it would have called that outage healthy.
  [
    'the site health check refuses to be pointed at /',
    /variable "site_health_check_path"/u.test(monitoringVars) &&
      /condition\s*=\s*var\.site_health_check_path\s*!=\s*"\/"/u.test(monitoringVars),
  ],
  // THE line. Every other alarm in the module says notBreaching, which is
  // right for a bad-value-among-good-ones alarm and catastrophic for one
  // whose whole job is to notice absence. "Could not check" must never be
  // reported as "checked and fine" — this repo's dominant defect class.
  [
    'the total-outage alarms treat missing data as breaching, not as health',
    /treat_missing_data\s*=\s*"breaching"/u.test(siteAlarm) &&
      /treat_missing_data\s*=\s*"breaching"/u.test(apiAlarm) &&
      !/treat_missing_data\s*=\s*"notBreaching"/u.test(siteAlarm) &&
      !/treat_missing_data\s*=\s*"notBreaching"/u.test(apiAlarm),
  ],
  [
    'the total-outage alarms read the health check and page the alerts topic',
    /HealthCheckId\s*=\s*aws_route53_health_check\.site\[0\]\.id/u.test(siteAlarm) &&
      /HealthCheckId\s*=\s*aws_route53_health_check\.api\[0\]\.id/u.test(apiAlarm) &&
      /alarm_actions\s*=\s*\[aws_sns_topic\.alerts\.arn\]/u.test(siteAlarm) &&
      /alarm_actions\s*=\s*\[aws_sns_topic\.alerts\.arn\]/u.test(apiAlarm),
  ],
  // Route53 publishes HealthCheckStatus in us-east-1 only, and a CloudWatch
  // alarm cannot notify an SNS topic in another region. Without this the
  // alarm is creatable and mute.
  [
    'the total-outage alarms refuse to be created where they cannot deliver',
    /precondition/u.test(siteAlarm) &&
      /precondition/u.test(apiAlarm) &&
      /alarms_can_read_route53\s*=\s*data\.aws_region\.current\.name == "us-east-1"/u.test(
        monitoring
      ),
  ],
  // GET /health answers "degraded" when its DynamoDB probe fails, so matching
  // on "ok" is what makes a reachable-but-broken API unhealthy here. Keep the
  // string tied to the serialization that produces it.
  [
    'the API health check string matches what GET /health serializes',
    apiSearchString === '"status":"ok"' &&
      /body:\s*JSON\.stringify\(data\)/u.test(responseUtil) &&
      /const overall = database === 'ok' \? 'ok' : 'degraded'/u.test(apiHandler) &&
      /status: overall,/u.test(apiHandler),
  ],
  [
    'a plan warns when an environment has alarms but nothing that can see an outage',
    /check "something_can_see_a_total_outage"/u.test(monitoring),
  ],
  // The 15-minute layer. Slower and less reliably scheduled than Route53, but
  // structurally deeper — and the negative control is what keeps it a check
  // rather than a green tick.
  [
    'the uptime workflow still loads real pages and proves it can fail',
    /scripts\/synthetic-page-check\.mjs/u.test(uptimeWorkflow) &&
      /--expect-failure/u.test(uptimeWorkflow) &&
      /'\/register'/u.test(syntheticPageCheck) &&
      /'\/login'/u.test(syntheticPageCheck),
  ],
  // ---------------------------------------------------------------------
  // The blind spot in the two checks above (#615). Both of them, and the
  // Route 53 probe, assert strings that live in the SPA SHELL. Until this
  // release the shell was also what a missing `/assets/` object returned —
  // `200 text/html`, carrying `og:site_name` — so a deploy that dropped the JS
  // bundle would have satisfied every one of them while no browser could boot
  // the app. Route 53's HTTPS_STR_MATCH cannot close that on its own: it does
  // not run JavaScript, does not follow a <script src>, and reads only the
  // first 5120 bytes, so any literal it can match is one the shell already
  // carries. These three assertions are what closes it instead.
  // ---------------------------------------------------------------------
  //
  // 1. The deeper check now follows the bundle the page advertises, which is
  //    the first assertion in it that a shell alone cannot satisfy.
  [
    'the synthetic page check fetches the bundle, not just the tag that names it',
    /export function bundleFailures\(/u.test(syntheticPageCheck) &&
      /JS_CONTENT_TYPES\.has\(type\)/u.test(syntheticPageCheck) &&
      /moduleScriptSrc\(page\.body\)/u.test(syntheticPageCheck) &&
      // …and the result is actually pushed into the route's failures, not
      // computed and dropped. Renaming the export alone used to satisfy this.
      /failures\.push\(\.\.\.bundleFailures\(/u.test(syntheticPageCheck) &&
      // and the predicate is executed by a gate, not only against production
      /SPA shell standing in for a missing chunk/u.test(syntheticPageCheckTest),
  ],
  // 2. The release path proves the distribution still distinguishes a missing
  //    object from a page — the property the fix established.
  [
    'the release smoke requires a fabricated /assets/ path to 404',
    /--missing-asset-404/u.test(production) &&
      /export function missingAssetFailures\(/u.test(syntheticPageCheck) &&
      /missingAssetFailures\(response\)/u.test(syntheticPageCheck) &&
      /status !== 404/u.test(syntheticPageCheck),
  ],
  // 3. And the CDN config that makes it true. A `404 -> 200` rescue anywhere in
  //    this distribution puts the shell back under /assets/, and dropping the
  //    ListBucket grant turns every miss back into a 403 the surviving 403 rule
  //    rescues. Either one silently reopens the blind spot, so both are asserted
  //    here rather than only in a comment.
  [
    'the CDN answers a missing object with a miss, not with the app shell',
    /"s3:ListBucket"/u.test(frontendTf) &&
      !/error_code\s*=\s*404/u.test(stripHclComments(frontendTf)) &&
      /'\/assets\/'/u.test(spaRouter) &&
      /request\.uri = '\/app-shell\.html'/u.test(spaRouter),
  ],
  // Retired claims. docs/observability.md described a Route53 health check
  // that did not exist and a 30-second probe that did not exist (#464), then
  // described their absence — and BOTH directions misinform a reader asking
  // "are we covered for a total outage?". Neither sentence may come back.
  [
    'docs/observability.md does not deny the health check it now documents',
    !/There is no Route53 health check/iu.test(observabilityDoc) &&
      !/no `aws_route53_health_check` in/iu.test(observabilityDoc),
  ],
  [
    'docs/observability.md documents the breaching posture rather than just the resource',
    /aws_route53_health_check/u.test(observabilityDoc) &&
      /treat_missing_data = "breaching"/u.test(observabilityDoc),
  ],
  // A hand-maintained live count in prose is this repo's other recurring
  // defect (see check-docs-testing.mjs's `Files` column and check-doc-
  // figures.mjs's route count). "28 alarms" was already in this doc and this
  // change would have made it wrong.
  [
    'docs/observability.md states no hand-maintained live alarm count',
    !/\b\d+ alarms and its dashboard\b/u.test(observabilityDoc) &&
      !/\bkeeps all \d+ alarms\b/u.test(observabilityDoc),
  ],
  // ---------------------------------------------------------------------
  // Whether the frontend rail can report at all (#576). #552 closed the
  // external-availability half of #464 and left this half open, in its own
  // words: `reportFrontendError` posts fire-and-forget to the API it exists
  // to report failures OF, so an unreachable API, a CORS block or a crash
  // before init destroys the report that would raise the alarm — and that
  // alarm reads the resulting silence as health. These checks are what stop
  // any part of that coming back.
  // ---------------------------------------------------------------------
  // `void fetch(...).catch(() => {})` discarded the rejection AND never read
  // the resolved response, so a 404 from a renamed route, a 400 from a schema
  // change, a 401 from added auth and a 429 from the rate limiter were all
  // indistinguishable from a delivered report — and from each other.
  [
    'a browser report that does not land is counted rather than swallowed',
    !/\.catch\(\(\) => \{\}\)/u.test(stripComments(browser)) &&
      /delivered = response\?\.ok === true;/u.test(browser) &&
      /recordUndelivered\(\);/u.test(browser),
  ],
  // The count has to outlive the tab: an app that broke badly enough to lose
  // its telemetry is one the visitor closed. sessionStorage would throw the
  // evidence away at exactly the moment it became worth having.
  [
    'undelivered reports survive the reload and are handed over later',
    /localStorage\.setItem\(UNDELIVERED_KEY/u.test(browser) &&
      /kind: 'delivery',\n\s+source: 'browser',/u.test(browser) &&
      /undelivered: record\.count,/u.test(browser) &&
      /flushUndelivered\(\);/u.test(browser),
  ],
  // A public, IP-rate-limited endpoint: these fields are operational hints
  // from an untrusted client, so they are bounded rather than trusted. Keep
  // the bounds tied to the constants the browser clamps to.
  [
    'the telemetry schema accepts delivery reports and bounds them',
    /kind: z\.literal\('delivery'\)/u.test(telemetryModel) &&
      /source: z\.enum\(\['browser', 'synthetic'\]\)/u.test(telemetryModel) &&
      /undelivered: z\.number\(\)\.int\(\)\.nonnegative\(\)\.max\(9999\)/u.test(telemetryModel) &&
      /ageMinutes: z\.number\(\)\.int\(\)\.nonnegative\(\)\.max\(20_160\)/u.test(telemetryModel),
  ],
  // A CORS misconfiguration silences the entire rail and produces, in the
  // words of infrastructure/modules/api/main.tf, "no log on our side". Only a
  // client can see it, and every real client it happens to is silenced by
  // definition — so the probe has to be a client, sending the preflight a
  // browser sends and requiring the headers a browser requires.
  [
    'the delivery probe sends what a browser sends and checks what a browser checks',
    /method: 'OPTIONS'/u.test(deliveryCheck) &&
      /'Access-Control-Request-Method': 'POST'/u.test(deliveryCheck) &&
      /access-control-allow-origin/u.test(deliveryCheck) &&
      /access-control-allow-headers/u.test(deliveryCheck) &&
      /EXPECTED_POST_STATUS = 204/u.test(deliveryCheck) &&
      /source: 'synthetic'/u.test(deliveryCheck),
  ],
  // Same discipline as the page check's negative control. A probe that cannot
  // go red is a green tick, and this one's whole job is to be the thing that
  // notices when nothing else can.
  [
    'the delivery probe runs on a schedule and proves it can fail',
    /scripts\/telemetry-delivery-check\.mjs/u.test(deliveryJob) &&
      /--expect-failure/u.test(deliveryJob),
  ],
  // Two metrics, because there are two questions. "A browser told us it lost
  // reports" and "no browser can tell us anything" are different failures
  // with different thresholds and different missing-data postures.
  [
    'browser losses and the synthetic heartbeat are separate metrics',
    /\$\.kind = \\"delivery\\" && \$\.source = \\"browser\\"/u.test(undeliveredFilter) &&
      /name\s*=\s*"FrontendReportsUndelivered"/u.test(undeliveredFilter) &&
      /\$\.kind = \\"delivery\\" && \$\.source = \\"synthetic\\"/u.test(probeFilter) &&
      /name\s*=\s*"FrontendTelemetryProbe"/u.test(probeFilter) &&
      /default_value\s*=\s*"0"/u.test(probeFilter),
  ],
  // THE line for this issue, and the same line #552 drew for the site. The
  // heartbeat has a floor because its cadence is synthetic, so its absence
  // means something — and "we could not check" must not render as "checked
  // and fine".
  [
    'the frontend rail heartbeat alarm treats missing data as breaching',
    /treat_missing_data\s*=\s*"breaching"/u.test(probeAlarm) &&
      !/treat_missing_data\s*=\s*"notBreaching"/u.test(probeAlarm) &&
      /comparison_operator\s*=\s*"LessThanThreshold"/u.test(probeAlarm) &&
      /alarm_actions\s*=\s*\[aws_sns_topic\.alerts\.arn\]/u.test(probeAlarm),
  ],
  // And the other direction, which matters just as much. FrontendErrors has
  // no floor — this product can genuinely go an hour with no visitors — so
  // "fixing" it to breaching would page on every quiet window and be trained
  // away inside a month. Both postures are asserted so neither can drift into
  // the other on the strength of half of this reasoning.
  [
    'the frontend-errors alarm still treats a quiet window as quiet, not as broken',
    /treat_missing_data\s*=\s*"notBreaching"/u.test(frontendErrorsAlarm) &&
      !/treat_missing_data\s*=\s*"breaching"/u.test(frontendErrorsAlarm) &&
      /treat_missing_data\s*=\s*"notBreaching"/u.test(undeliveredAlarm) &&
      !/treat_missing_data\s*=\s*"breaching"/u.test(undeliveredAlarm),
  ],
  [
    'docs/observability.md documents the delivery signals rather than the gap',
    /FrontendTelemetryProbe/u.test(observabilityDoc) &&
      /FrontendReportsUndelivered/u.test(observabilityDoc) &&
      !/Fixing this needs an out-of-band collector/u.test(observabilityDoc),
  ],
  [
    'production smoke uses component health',
    /API_URL:\s*\$\{\{ needs\.terraform\.outputs\.api_url \}\}/u.test(productionDeployBackend) &&
      /url="\$\{API_URL\}\/health"/u.test(productionDeployBackend) &&
      /components\?\.database\?\.status\s*!==\s*'ok'/u.test(productionDeployBackend),
  ],
];

const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length > 0) {
  console.error(`Observability contract failed:\n- ${failed.join('\n- ')}`);
  process.exit(1);
}

console.log(`Observability contract OK — ${checks.length} checks passed.`);
