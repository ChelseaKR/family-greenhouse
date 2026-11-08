/**
 * A production release needs exactly one deploy approval, and nothing reaches
 * production around it.
 *
 * The approval is the required reviewer on the `production` GitHub environment, and
 * every job that declares that environment pauses for it. Three jobs used to, so a
 * release paused three times. It now sits on `terraform` alone, the first job that
 * touches production.
 *
 * That only holds while the other jobs cannot get ahead of the gate, so the rules
 * below are about both directions: no second pause, and no way past the first one.
 * Each rule is a pure function of the parsed workflow, exercised against workflows it
 * MUST reject as well as against the committed file.
 *
 * The reviewer itself is a repository setting, not something a file can pin. If it
 * is removed, every rule here still passes and nobody is asked: see
 * docs/production-checklist.md.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(ROOT, '.github/workflows');
const committed = () => load(readFileSync(join(WORKFLOWS, 'cd-production.yml'), 'utf8'));

const GATED_JOB = 'terraform';

/** Jobs that change production and must not run unless the gated job succeeded. */
const DEPLOY_JOBS = ['deploy-backend', 'deploy-frontend', 'smoke-tests'];

const needsOf = (job) => [job?.needs ?? []].flat();

/** Everything a job waits for, directly or not. */
function ancestors(workflow, name, seen = new Set()) {
  for (const parent of needsOf(workflow.jobs[name])) {
    if (!seen.has(parent)) {
      seen.add(parent);
      ancestors(workflow, parent, seen);
    }
  }
  return seen;
}

const assumesAwsRole = (job) =>
  (job.steps ?? []).some((step) => String(step.uses ?? '').includes('configure-aws-credentials'));

/** A status function in a job's `if` turns off GitHub's implicit `success()`. */
const overridesSuccess = (job) => /\b(always|failure|cancelled)\(\)/u.test(String(job.if ?? ''));

/** Every way this workflow breaks the rule, as readable strings. Empty means it holds. */
export function violations(workflow) {
  const found = [];
  const jobs = Object.entries(workflow.jobs);

  const gated = jobs.filter(([, job]) => job.environment !== undefined).map(([name]) => name);
  if (gated.length !== 1 || gated[0] !== GATED_JOB) {
    found.push(`gated jobs are [${gated.join(', ')}], expected [${GATED_JOB}]`);
  }
  const environment = workflow.jobs[GATED_JOB]?.environment;
  if ((environment?.name ?? environment) !== 'production') {
    found.push(`${GATED_JOB} is not gated on the production environment`);
  }

  // Past the gate by order: a job holding the AWS role that does not wait for it.
  for (const [name, job] of jobs) {
    if (name !== GATED_JOB && assumesAwsRole(job) && !ancestors(workflow, name).has(GATED_JOB)) {
      found.push(`${name} assumes the AWS role without waiting for ${GATED_JOB}`);
    }
  }

  // Past the gate by condition: `always()` runs a job whose needs were rejected.
  for (const name of DEPLOY_JOBS) {
    const job = workflow.jobs[name];
    if (!job) found.push(`${name} is missing`);
    else if (!needsOf(job).includes(GATED_JOB)) found.push(`${name} does not need ${GATED_JOB}`);
    else if (job.if !== undefined) found.push(`${name} has an if, so it may outrun ${GATED_JOB}`);
  }
  for (const [name, job] of jobs) {
    if (
      assumesAwsRole(job) &&
      overridesSuccess(job) &&
      !String(job.if).includes(`needs.${GATED_JOB}.`)
    ) {
      found.push(`${name} overrides success() without checking ${GATED_JOB}`);
    }
  }

  // check-deploy-staleness.mjs relies on this: new frontend bytes prove the backend shipped.
  if (!needsOf(workflow.jobs['deploy-frontend']).includes('deploy-backend')) {
    found.push('deploy-frontend does not need deploy-backend');
  }

  // Past the gate by another door: only a tag push or a manual dispatch starts a release.
  const triggers = Object.keys(workflow.on ?? {}).sort();
  if (triggers.join() !== 'push,workflow_dispatch') {
    found.push(`triggers are [${triggers.join(', ')}], expected [push, workflow_dispatch]`);
  }
  const branches = workflow.on?.push?.branches;
  if (branches !== undefined) found.push('a branch push can start a production release');

  return found;
}

/** A copy of the committed workflow with one thing changed. */
function changed(change) {
  const workflow = committed();
  change(workflow);
  return workflow;
}

test('the committed workflow has exactly one gated job, and nothing around it', () => {
  assert.deepEqual(violations(committed()), []);
});

test('the gated job is the first one that touches production', () => {
  const workflow = committed();
  const beforeGate = ancestors(workflow, GATED_JOB);
  assert.deepEqual([...beforeGate].sort(), ['build', 'validate']);
  for (const name of beforeGate) {
    assert.equal(assumesAwsRole(workflow.jobs[name]), false, `${name} holds the AWS role`);
  }
  assert.equal(assumesAwsRole(workflow.jobs[GATED_JOB]), true);
});

// --- every rule, against a workflow it must reject ---------------------------

for (const [description, change, expected] of [
  [
    'a second approval on a deploy job',
    (w) => {
      w.jobs['deploy-frontend'].environment = 'production';
    },
    /gated jobs are \[terraform, deploy-frontend\]/u,
  ],
  [
    'an environment in its long form still counts as a second approval',
    (w) => {
      w.jobs['deploy-backend'].environment = { name: 'production' };
    },
    /gated jobs are \[terraform, deploy-backend\]/u,
  ],
  [
    'no approval anywhere',
    (w) => {
      delete w.jobs.terraform.environment;
    },
    /gated jobs are \[\]/u,
  ],
  [
    'the approval moved past the first production job',
    (w) => {
      delete w.jobs.terraform.environment;
      w.jobs['deploy-backend'].environment = 'production';
    },
    /gated jobs are \[deploy-backend\]/u,
  ],
  [
    'the gate on some other environment',
    (w) => {
      w.jobs.terraform.environment = 'staging';
    },
    /not gated on the production environment/u,
  ],
  [
    'a deploy job that stops waiting for the gate',
    (w) => {
      w.jobs['deploy-backend'].needs = ['validate', 'build'];
    },
    /deploy-backend assumes the AWS role without waiting/u,
  ],
  [
    'a deploy job that runs even when the gate was rejected',
    (w) => {
      w.jobs['deploy-frontend'].if = '${{ always() }}';
    },
    /deploy-frontend has an if/u,
  ],
  [
    'a recovery job that runs on always() without reading the gate',
    (w) => {
      w.jobs.rollback.if = '${{ always() }}';
    },
    /rollback overrides success\(\) without checking terraform/u,
  ],
  [
    'a new job holding the AWS role outside the gate',
    (w) => {
      w.jobs.extra = {
        needs: ['validate'],
        steps: [{ uses: 'aws-actions/configure-aws-credentials@abc' }],
      };
    },
    /extra assumes the AWS role without waiting/u,
  ],
  [
    'the frontend no longer shipping after the backend',
    (w) => {
      w.jobs['deploy-frontend'].needs = ['validate', 'terraform'];
    },
    /deploy-frontend does not need deploy-backend/u,
  ],
  [
    'another trigger',
    (w) => {
      w.on.workflow_call = {};
    },
    /triggers are \[push, workflow_call, workflow_dispatch\]/u,
  ],
  [
    'a branch push that starts a release',
    (w) => {
      w.on.push.branches = ['main'];
    },
    /a branch push can start/u,
  ],
]) {
  test(`rejected: ${description}`, () => {
    const found = violations(changed(change));
    assert.ok(
      found.some((line) => expected.test(line)),
      `expected ${expected} in ${JSON.stringify(found)}`
    );
  });
}

// --- the two things outside that file the gate depends on --------------------

test('no other workflow holds the production role', () => {
  const others = readdirSync(WORKFLOWS)
    .filter((file) => /\.ya?ml$/u.test(file) && file !== 'cd-production.yml')
    .filter((file) =>
      /secrets\.AWS_PRODUCTION_ROLE_ARN/u.test(readFileSync(join(WORKFLOWS, file), 'utf8'))
    );
  assert.deepEqual(others, []);
});

test('the deploy role trusts a job with no environment, on a tag and on a main dispatch', () => {
  // A job with an `environment:` presents `...:environment:production`; one without
  // presents `...:ref:refs/tags/v0.50.0`, or `...:ref:refs/heads/main` when dispatched.
  // Lose either ref here and the deploy jobs fail AccessDenied after Terraform applied.
  const variables = readFileSync(join(ROOT, 'infrastructure/modules/cicd/variables.tf'), 'utf8');
  const block = /variable "allowed_refs" \{[\s\S]*?default\s*=\s*\[([^\]]*)\]/u.exec(variables);
  assert.ok(block, 'allowed_refs default not found');
  assert.match(block[1], /"ref:refs\/tags\/v\*"/u);
  assert.match(block[1], /"ref:refs\/heads\/main"/u);

  const module = readFileSync(join(ROOT, 'infrastructure/modules/cicd/main.tf'), 'utf8');
  assert.match(module, /for ref in var\.allowed_refs :/u);
  assert.match(module, /:environment:\$\{var\.environment_name\}/u);
});
