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
  [
    'production smoke uses component health',
    /API_URL:\s*\$\{\{ needs\.terraform\.outputs\.api_url \}\}/u.test(productionDeployBackend) &&
      /url="\$\{API_URL\}\/health"/u.test(productionDeployBackend) &&
      /components\?\.database\s*!==\s*'ok'/u.test(productionDeployBackend),
  ],
];

const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length > 0) {
  console.error(`Observability contract failed:\n- ${failed.join('\n- ')}`);
  process.exit(1);
}

console.log(`Observability contract OK — ${checks.length} checks passed.`);
