/**
 * A production release needs exactly one deploy approval, and nothing reaches
 * production around it.
 *
 * The approval is the required reviewer on the `production` GitHub environment, and
 * every job that declares that environment pauses for it. Three jobs used to, so a
 * release paused three times. It now sits on `terraform` alone, the first job that
 * touches production.
 *
 * AWS enforces the same line (ADR 0049). The deploy role, the one role with IAM
 * writes, can be assumed only from the `production` environment, so only by that
 * job. Every job after it runs in `production-release`, an environment with no
 * reviewer, and assumes the release role, which has none. A job that assumes an AWS
 * role with no environment gets nothing: no role trusts a branch or a tag.
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

/** The reviewed environment, and the one the jobs after the gate run in. */
const GATED_ENVIRONMENT = 'production';
const RELEASE_ENVIRONMENT = 'production-release';

/**
 * The one job that holds an AWS role before the gate. It proves the release role
 * can be assumed before the approval is asked for, so a missing role or secret
 * stops the release before Terraform has applied anything. It may do nothing else.
 */
const PREFLIGHT_JOB = 'preflight-release-role';

const environmentOf = (job) => job?.environment?.name ?? job?.environment;

/** Every `secrets.X` a job's AWS credential steps ask for. */
const roleSecretsOf = (job) =>
  (job.steps ?? [])
    .filter((step) => String(step.uses ?? '').includes('configure-aws-credentials'))
    .flatMap((step) => [
      ...String(step.with?.['role-to-assume'] ?? '').matchAll(/secrets\.([A-Z0-9_]+)/gu),
    ])
    .map((match) => match[1]);

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

  // One pause: only the gated job runs in the reviewed environment.
  const gated = jobs
    .filter(([, job]) => environmentOf(job) === GATED_ENVIRONMENT)
    .map(([name]) => name);
  if (gated.length !== 1 || gated[0] !== GATED_JOB) {
    found.push(`gated jobs are [${gated.join(', ')}], expected [${GATED_JOB}]`);
  }
  if (environmentOf(workflow.jobs[GATED_JOB]) !== GATED_ENVIRONMENT) {
    found.push(`${GATED_JOB} is not gated on the production environment`);
  }

  // What AWS will accept (ADR 0049): the deploy role from the gated job alone, the
  // release role from the release environment, and nothing from a job with neither.
  for (const [name, job] of jobs) {
    if (!assumesAwsRole(job)) continue;
    const environment = environmentOf(job);
    const secrets = roleSecretsOf(job);
    if (name === GATED_JOB) {
      if (secrets.join() !== 'AWS_PRODUCTION_ROLE_ARN') {
        found.push(`${name} assumes [${secrets.join(', ')}], expected the deploy role`);
      }
      continue;
    }
    if (environment !== RELEASE_ENVIRONMENT) {
      found.push(
        `${name} assumes an AWS role in environment ${environment ?? '(none)'}, expected ${RELEASE_ENVIRONMENT}`
      );
    }
    if (secrets.length === 0 || secrets.some((secret) => secret !== 'AWS_RELEASE_ROLE_ARN')) {
      found.push(`${name} assumes [${secrets.join(', ')}], expected the release role`);
    }
  }
  // An environment other than those two on any job is a pause nobody planned, or a
  // subject AWS does not know.
  for (const [name, job] of jobs) {
    const environment = environmentOf(job);
    if (
      environment !== undefined &&
      environment !== GATED_ENVIRONMENT &&
      environment !== RELEASE_ENVIRONMENT
    ) {
      found.push(`${name} declares the environment ${environment}`);
    }
  }

  // Past the gate by order: a job holding the AWS role that does not wait for it.
  for (const [name, job] of jobs) {
    if (
      name !== GATED_JOB &&
      name !== PREFLIGHT_JOB &&
      assumesAwsRole(job) &&
      !ancestors(workflow, name).has(GATED_JOB)
    ) {
      found.push(`${name} assumes the AWS role without waiting for ${GATED_JOB}`);
    }
  }

  // The preflight is the one exception to that, so it is held to one read-only call.
  const preflight = workflow.jobs[PREFLIGHT_JOB];
  if (!preflight) {
    found.push(`${PREFLIGHT_JOB} is missing`);
  } else {
    const runs = (preflight.steps ?? []).filter((step) => step.run !== undefined);
    const others = (preflight.steps ?? []).filter(
      (step) =>
        step.run === undefined && !String(step.uses ?? '').includes('configure-aws-credentials')
    );
    if (
      runs.length !== 1 ||
      others.length !== 0 ||
      !/^aws sts get-caller-identity\b[^\n;&|]*> \/dev\/null$/u.test(String(runs[0]?.run).trim())
    ) {
      found.push(`${PREFLIGHT_JOB} does more than check the release role's identity`);
    }
    if (!needsOf(workflow.jobs[GATED_JOB]).includes(PREFLIGHT_JOB)) {
      found.push(`${GATED_JOB} does not wait for ${PREFLIGHT_JOB}`);
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
  assert.deepEqual([...beforeGate].sort(), ['build', PREFLIGHT_JOB, 'validate']);
  for (const name of beforeGate) {
    if (name === PREFLIGHT_JOB) continue; // held to one read-only call, above
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
    'a deploy job with no environment, which AWS would refuse after Terraform applied',
    (w) => {
      delete w.jobs['deploy-backend'].environment;
    },
    /deploy-backend assumes an AWS role in environment \(none\)/u,
  ],
  [
    'the rollback in the reviewed environment, where it would wait for a click',
    (w) => {
      w.jobs.rollback.environment = 'production';
    },
    /gated jobs are \[terraform, rollback\]/u,
  ],
  [
    'a job after the gate asking for the deploy role',
    (w) => {
      for (const step of w.jobs['smoke-tests'].steps) {
        if (String(step.uses ?? '').includes('configure-aws-credentials')) {
          step.with['role-to-assume'] = '${{ secrets.AWS_PRODUCTION_ROLE_ARN }}';
        }
      }
    },
    /smoke-tests assumes \[AWS_PRODUCTION_ROLE_ARN\], expected the release role/u,
  ],
  [
    'the gated job asking for the release role',
    (w) => {
      for (const step of w.jobs.terraform.steps) {
        if (String(step.uses ?? '').includes('configure-aws-credentials')) {
          step.with['role-to-assume'] = '${{ secrets.AWS_RELEASE_ROLE_ARN }}';
        }
      }
    },
    /terraform assumes \[AWS_RELEASE_ROLE_ARN\], expected the deploy role/u,
  ],
  [
    'an environment AWS does not know',
    (w) => {
      w.jobs['deploy-frontend'].environment = 'production-deploy';
    },
    /deploy-frontend declares the environment production-deploy/u,
  ],
  [
    'a preflight that does something with the role',
    (w) => {
      w.jobs['preflight-release-role'].steps.push({ run: 'aws s3 ls' });
    },
    /preflight-release-role does more than check/u,
  ],
  [
    'a preflight whose one command is not the identity check',
    (w) => {
      const step = w.jobs['preflight-release-role'].steps.find((s) => s.run !== undefined);
      step.run = 'aws sts get-caller-identity > /dev/null && aws s3 ls > /dev/null';
    },
    /preflight-release-role does more than check/u,
  ],
  [
    'a release that no longer checks the release role first',
    (w) => {
      w.jobs.terraform.needs = ['validate', 'build'];
    },
    /terraform does not wait for preflight-release-role/u,
  ],
  [
    'no preflight at all',
    (w) => {
      delete w.jobs['preflight-release-role'];
      w.jobs.terraform.needs = ['validate', 'build'];
    },
    /preflight-release-role is missing/u,
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

// --- the things outside that file the gate depends on -------------------------

test('the deploy role is asked for only by a Terraform job in a reviewed environment', () => {
  // The deploy role has the IAM writes. `cd-staging.yml` needs it for the staging
  // stack's `terraform apply`, from `staging-infrastructure`; nothing else may ask.
  const allowed = { 'cd-production.yml': 'production', 'cd-staging.yml': 'staging-infrastructure' };
  const asking = [];
  for (const file of readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/u.test(name))) {
    const workflow = load(readFileSync(join(WORKFLOWS, file), 'utf8'));
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      if (JSON.stringify(job).includes('secrets.AWS_PRODUCTION_ROLE_ARN')) {
        asking.push(`${file}:${name}:${environmentOf(job) ?? '(none)'}`);
      }
    }
  }
  assert.deepEqual(
    asking.sort(),
    Object.entries(allowed)
      .map(([file, environment]) => `${file}:terraform:${environment}`)
      .sort()
  );
});

test('AWS trusts the environments these jobs run in, and no branch or tag', () => {
  // A job with an `environment:` presents `...:environment:<name>`; one without
  // presents `...:ref:refs/tags/v0.50.0`, or `...:ref:refs/heads/main` when dispatched.
  // The trust policies are built from environment names alone. Lose
  // `production-release` here and the deploy jobs fail AccessDenied after Terraform
  // applied; add a ref back and a job with no environment can hold the deploy role.
  const variables = readFileSync(join(ROOT, 'infrastructure/modules/cicd/variables.tf'), 'utf8');
  const defaultOf = (name) => {
    const block = new RegExp(
      `variable "${name}" \\{[\\s\\S]*?\\n  default\\s*=\\s*\\[([^\\]]*)\\]`,
      'u'
    ).exec(variables);
    assert.ok(block, `${name} default not found`);
    return [...block[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  };
  assert.deepEqual(defaultOf('deploy_environments'), [GATED_ENVIRONMENT]);
  assert.ok(defaultOf('release_environments').includes(RELEASE_ENVIRONMENT));
  assert.deepEqual(defaultOf('legacy_allowed_refs'), []);

  const module = readFileSync(join(ROOT, 'infrastructure/modules/cicd/main.tf'), 'utf8');
  assert.match(
    module,
    /for name in var\.deploy_environments : "\$\{local\.subject_prefix\}:environment:\$\{name\}"/u
  );
  assert.match(
    module,
    /for name in var\.release_environments : "\$\{local\.subject_prefix\}:environment:\$\{name\}"/u
  );
  // The only ref-shaped subject is the one-time transition list, empty by default.
  assert.doesNotMatch(module, /"ref:refs\//u);
  assert.doesNotMatch(variables, /"ref:refs\//u);
});
