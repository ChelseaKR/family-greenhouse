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
const boundary = read('frontend/src/components/RouteErrorBoundary.tsx');
const production = read('.github/workflows/cd-production.yml');
const rootInfrastructure = read('infrastructure/main.tf');
const monitoringVars = read('infrastructure/modules/monitoring/variables.tf');
const uptimeWorkflow = read('.github/workflows/uptime.yml');
const observabilityDoc = read('docs/observability.md');
const indexHtml = read('frontend/index.html');
const responseUtil = read('backend/src/utils/response.ts');
const syntheticPageCheck = read('scripts/synthetic-page-check.mjs');

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
  ['browser telemetry initialized', /initFrontendTelemetry\(\)/u.test(main)],
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
