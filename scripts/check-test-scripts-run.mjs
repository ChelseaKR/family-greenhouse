#!/usr/bin/env node
/**
 * Asserts that every `test*` script the workspaces define is actually invoked
 * by something — the local gate, a CI workflow, or an explicitly registered
 * exception (#472).
 *
 * ## Why
 *
 * `frontend`'s `test:edge` existed, passed, and ran in NO gate. A repo-wide
 * grep for it returned two hits: its own line in package.json, and its own
 * header comment in `frontend/scripts/spa-router.test.mjs`, which claimed it
 * was "also part of the frontend test gate". It was not: `frontend`'s `test`
 * is `vitest run`, and vitest.config.ts includes only
 * `tests|src/**\/*.{test,spec}.{ts,tsx}` — a `.mjs` file under
 * `frontend/scripts/` matches neither. The root `verify` chain did not call it,
 * so pre-push missed it too.
 *
 * What went uncovered was
 * `infrastructure/modules/frontend/functions/spa-router.js`, the CloudFront
 * viewer-request function that maps `/pricing` and the other prerendered routes
 * onto their `index.html` objects. On 2026-09-04 that gap cost a production
 * outage: every route but `/` returned 403 for roughly forty minutes. One of the
 * test's six cases is literally "a trailing slash resolves to the same object,
 * not a 403".
 *
 * A test suite that nothing runs is worse than no suite, because its existence
 * is read as coverage — by the docs, and by the next person deciding whether a
 * change is risky.
 *
 * ## Why a general rule rather than one assertion about test:edge
 *
 * Adding `test:edge` to the gate fixes the instance. This fixes the class: the
 * next suite someone adds is either wired into a gate or has to say, in a
 * reviewed line of this file, why it is not. Registration is not a bypass — it
 * is the difference between a deliberate exception and an accident nobody can
 * see.
 *
 * Runs in `npm run verify` (scripts/gate-steps.mjs) and in CI's required Lint
 * job — the same both-places pattern as check-no-bare-markers.mjs (CICD-27).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// gate-steps.mjs is a pure data module with no side effects, so importing it is
// an observation rather than an action. (check-git-hooks.mjs learned the other
// way round: importing a module that DOES something let the checker repair the
// defect it was inspecting.)
import { STEPS, WORKSPACES } from './gate-steps.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS_DIR = join(ROOT, '.github/workflows');

/** Scripts that deliberately run in no gate, each with the reason. */
const REGISTERED = {
  'frontend:test':
    'superseded by `test:coverage`, which runs the same vitest suite plus the floors',
  'backend:test': 'superseded by `test:coverage`, which runs the same vitest suite plus the floors',
  'frontend:test:watch': 'interactive watch mode — a developer convenience, not a suite',
  'backend:test:watch': 'interactive watch mode — a developer convenience, not a suite',
  'frontend:test:e2e:ui': 'interactive Playwright UI mode — the same specs `test:e2e` runs in CI',
};

const workflowText = readdirSync(WORKFLOWS_DIR)
  .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
  .map((file) => readFileSync(join(WORKFLOWS_DIR, file), 'utf8'))
  .join('\n');

/** True when a CI workflow invokes `npm run <script>` exactly (not a prefix). */
function runsInCi(script) {
  return new RegExp(`npm run ${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w:-])`).test(
    workflowText
  );
}

/** True when scripts/gate-steps.mjs schedules this workspace script. */
function runsInGate(workspace, script) {
  return STEPS.some((step) => step.workspace === workspace && step.script === script);
}

const errors = [];

// The plan's workspaces must match package.json's, or a whole workspace's test
// scripts could go unexamined here while this file still reports a pass.
const declared = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).workspaces;
if (JSON.stringify(declared) !== JSON.stringify(WORKSPACES)) {
  errors.push(
    `package.json workspaces ${JSON.stringify(declared)} do not match gate-steps.mjs ` +
      `WORKSPACES ${JSON.stringify(WORKSPACES)}; this check would examine the wrong set.`
  );
}

const seen = new Set();

for (const workspace of declared) {
  const scripts =
    JSON.parse(readFileSync(join(ROOT, workspace, 'package.json'), 'utf8')).scripts ?? {};

  for (const name of Object.keys(scripts)) {
    if (!/^test(:|$)/.test(name)) continue;
    const key = `${workspace}:${name}`;
    seen.add(key);

    if (runsInGate(workspace, name) || runsInCi(name)) continue;
    if (key in REGISTERED) continue;

    errors.push(
      `${workspace}'s \`${name}\` script runs in no gate: it is not a step in ` +
        `scripts/gate-steps.mjs and no workflow invokes \`npm run ${name}\`.\n` +
        `    A suite nothing runs still reads as coverage — that is how the CloudFront\n` +
        `    SPA router went untested through a production outage (#472). Either add it\n` +
        `    to the gate and to CI, or register it in REGISTERED in this file with the\n` +
        `    reason it does not need to run.`
    );
  }
}

// A registration for a script that no longer exists is stale allowlist: it
// makes the exception list look considered when it is just old.
for (const key of Object.keys(REGISTERED)) {
  if (!seen.has(key)) {
    errors.push(
      `REGISTERED lists \`${key}\`, but that script no longer exists. Remove the entry ` +
        'so the exception list keeps meaning something.'
    );
  }
}

if (errors.length > 0) {
  console.error('Test suites that no gate runs:\n');
  for (const error of errors) console.error(`  ${error}\n`);
  process.exit(1);
}

console.log(
  `Every \`test*\` script in ${declared.join(' + ')} runs in the gate or in CI ` +
    `(${Object.keys(REGISTERED).length} registered exceptions).`
);
