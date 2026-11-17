/**
 * What a workflow job can reach in AWS, and what runs inside a job that can
 * reach it (ADR 0049).
 *
 * Three rules, each measured on the committed files and each exercised against
 * input it MUST reject:
 *
 *   1. No install scripts where there is something to take. A job that holds an
 *      OIDC token (`id-token: write`) or a secret installs its dependencies with
 *      `--ignore-scripts`, and nothing in the lockfile needs its script.
 *   2. AWS trusts environments, not refs. Every job that assumes an AWS role
 *      declares a GitHub environment, asks for the role that environment is
 *      trusted for, and the Terraform trust policies name exactly those
 *      environments and no branch or tag.
 *   3. The deploy pipeline cannot make itself, or anything it creates, wider.
 *      The deploy role is denied every change to the CI/CD identities, every
 *      role it creates must carry the permissions boundary, the release role has
 *      no IAM write, and the boundary covers what the Lambda roles need and no
 *      IAM.
 *
 * What a file cannot pin: the reviewers on the `production` and
 * `staging-infrastructure` environments are repository settings. If one is
 * removed, every rule here still passes. See docs/production-checklist.md.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(ROOT, '.github/workflows');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const workflows = () =>
  readdirSync(WORKFLOWS)
    .filter((file) => /\.ya?ml$/u.test(file))
    .sort()
    .map((file) => ({ file, workflow: load(readFileSync(join(WORKFLOWS, file), 'utf8')) }));

const environmentOf = (job) => job?.environment?.name ?? job?.environment;

// --- 1. install scripts -------------------------------------------------------

/** The permissions a job runs with: its own block, or the workflow's. */
const permissionsOf = (workflow, job) => job.permissions ?? workflow.permissions;

const holdsOidcToken = (workflow, job) => {
  const permissions = permissionsOf(workflow, job);
  return permissions === 'write-all' || permissions?.['id-token'] === 'write';
};

/**
 * A `${{ secrets.X }}` expression for any secret other than the token every job
 * already has. Only expressions count: a script named `check-secrets.mjs` is not one.
 */
const holdsSecret = (job) =>
  [...JSON.stringify(job).matchAll(/\$\{\{[^}]*?\bsecrets\.([A-Za-z0-9_]+)/gu)].some(
    (match) => match[1] !== 'GITHUB_TOKEN'
  );

/** An `npm ci` / `npm install` / `npm i` command line that would run install scripts. */
function installsThatRunScripts(run) {
  return String(run ?? '')
    .split(/\n|&&|\|\||;/u)
    .map((command) => command.trim())
    .filter((command) => /^(?:nice\s+(?:-n\s+\d+\s+)?)?npm\s+(?:ci|install|i)\b/u.test(command))
    .filter((command) => !/\s--ignore-scripts\b/u.test(command));
}

/** Every privileged job that would run a dependency's install script. */
export function installScriptViolations(file, workflow) {
  const found = [];
  for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
    if (!holdsOidcToken(workflow, job) && !holdsSecret(job)) continue;
    for (const step of job.steps ?? []) {
      for (const command of installsThatRunScripts(step.run)) {
        found.push(`${file}:${name} runs \`${command}\` while holding a token or a secret`);
      }
    }
  }
  return found;
}

test('no job that holds an OIDC token or a secret runs install scripts', () => {
  const found = workflows().flatMap(({ file, workflow }) =>
    installScriptViolations(file, workflow)
  );
  assert.deepEqual(found, []);
});

test('the jobs the rule is about exist, so it is not passing on nothing', () => {
  const privileged = workflows().flatMap(({ file, workflow }) =>
    Object.entries(workflow.jobs ?? {})
      .filter(
        ([, job]) =>
          (holdsOidcToken(workflow, job) || holdsSecret(job)) &&
          (job.steps ?? []).some((step) => /\bnpm ci\b/u.test(String(step.run ?? '')))
      )
      .map(([name]) => `${file}:${name}`)
  );
  for (const expected of [
    'cd-production.yml:build',
    'cd-production.yml:smoke-tests',
    'cd-production.yml:sweep-test-fixtures',
    'cd-staging.yml:build-frontend',
    'cd-staging.yml:e2e-tests',
  ]) {
    assert.ok(privileged.includes(expected), `${expected} is not a privileged job that installs`);
  }
});

for (const [description, job, expected] of [
  [
    'a plain npm ci beside an OIDC token',
    { permissions: { 'id-token': 'write' }, steps: [{ run: 'npm ci' }] },
    /runs `npm ci`/u,
  ],
  [
    'a plain npm ci beside a secret',
    { steps: [{ run: 'npm ci' }, { run: 'deploy', env: { KEY: '${{ secrets.API_KEY }}' } }] },
    /runs `npm ci`/u,
  ],
  [
    'npm install in a multi-line script',
    { permissions: { 'id-token': 'write' }, steps: [{ run: 'set -e\nnpm install --no-audit\n' }] },
    /runs `npm install --no-audit`/u,
  ],
  [
    'an install chained after another command',
    { permissions: 'write-all', steps: [{ run: 'cd frontend && npm i' }] },
    /runs `npm i`/u,
  ],
]) {
  test(`rejected: ${description}`, () => {
    const found = installScriptViolations('x.yml', { jobs: { job } });
    assert.ok(
      found.some((line) => expected.test(line)),
      `expected ${expected} in ${JSON.stringify(found)}`
    );
  });
}

test('accepted: the same installs with --ignore-scripts, and a plain install in a job that holds nothing', () => {
  assert.deepEqual(
    installScriptViolations('x.yml', {
      permissions: { contents: 'read' },
      jobs: {
        privileged: {
          permissions: { 'id-token': 'write' },
          steps: [{ run: 'npm ci --ignore-scripts' }, { run: 'npx playwright test' }],
        },
        plain: { steps: [{ run: 'npm ci' }, { run: 'node scripts/check-secrets.mjs' }] },
        tokenOnly: { steps: [{ run: 'npm ci', env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' } }] },
      },
    }),
    []
  );
});

/**
 * Packages in the lockfile that declare an install script, by name. With
 * `--ignore-scripts` none of these runs, so each one here is a statement that
 * the package works without its script:
 *
 *   esbuild   the script only swaps a JS launcher for the native binary, which
 *             is installed as an optional dependency either way.
 *   fsevents  macOS only; ships a prebuilt binary and is never installed on the
 *             Linux runners.
 *
 * A package that really needs its script must not be added to this list. Its
 * install belongs in a job that holds no token and no secret, with the result
 * handed on as an artifact.
 */
const WORKS_WITHOUT_ITS_INSTALL_SCRIPT = new Set(['esbuild', 'fsevents']);

export function packagesWithInstallScripts(lockfile) {
  return [
    ...new Set(
      Object.entries(lockfile.packages ?? {})
        .filter(([, entry]) => entry.hasInstallScript)
        .map(([path]) => path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length))
    ),
  ].sort();
}

test('nothing in the lockfile needs an install script the privileged jobs skip', () => {
  const unexpected = packagesWithInstallScripts(JSON.parse(read('package-lock.json'))).filter(
    (name) => !WORKS_WITHOUT_ITS_INSTALL_SCRIPT.has(name)
  );
  assert.deepEqual(
    unexpected,
    [],
    'a dependency with an install script was added; see WORKS_WITHOUT_ITS_INSTALL_SCRIPT'
  );
});

test('rejected: a lockfile that gains a package with an install script', () => {
  const lockfile = {
    packages: {
      'node_modules/esbuild': { hasInstallScript: true },
      'node_modules/a/node_modules/native-thing': { hasInstallScript: true },
      'node_modules/quiet': {},
    },
  };
  assert.deepEqual(packagesWithInstallScripts(lockfile), ['esbuild', 'native-thing']);
});

// --- 2. AWS trusts environments, not refs --------------------------------------

/** Which GitHub environments may ask for which role. */
const ROLE_ENVIRONMENTS = {
  AWS_PRODUCTION_ROLE_ARN: ['production', 'staging-infrastructure'],
  AWS_RELEASE_ROLE_ARN: ['production-release', 'staging'],
  AWS_ALERT_RELAY_ROLE_ARN: ['alert-relay'],
};

const credentialSteps = (job) =>
  (job.steps ?? []).filter((step) => String(step.uses ?? '').includes('configure-aws-credentials'));

/** Every job that would be refused by AWS, or that asks for more than its environment gets. */
export function roleAssumptionViolations(file, workflow) {
  const found = [];
  for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of credentialSteps(job)) {
      const role = String(step.with?.['role-to-assume'] ?? '');
      const secret = /^\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}$/u.exec(role)?.[1];
      const environment = environmentOf(job);
      if (!secret || !(secret in ROLE_ENVIRONMENTS)) {
        found.push(`${file}:${name} assumes a role this file does not know: ${role || '(none)'}`);
      } else if (environment === undefined) {
        found.push(`${file}:${name} assumes ${secret} with no environment, which no role trusts`);
      } else if (!ROLE_ENVIRONMENTS[secret].includes(environment)) {
        found.push(`${file}:${name} assumes ${secret} from the environment ${environment}`);
      }
    }
  }
  return found;
}

test('every job that assumes an AWS role does it from an environment that role trusts', () => {
  const found = workflows().flatMap(({ file, workflow }) =>
    roleAssumptionViolations(file, workflow)
  );
  assert.deepEqual(found, []);
});

for (const [description, job, expected] of [
  [
    'a job with no environment',
    {
      steps: [
        {
          uses: 'aws-actions/configure-aws-credentials@abc',
          with: { 'role-to-assume': '${{ secrets.AWS_RELEASE_ROLE_ARN }}' },
        },
      ],
    },
    /with no environment/u,
  ],
  [
    'the deploy role from an environment with no reviewer',
    {
      environment: 'staging',
      steps: [
        {
          uses: 'aws-actions/configure-aws-credentials@abc',
          with: { 'role-to-assume': '${{ secrets.AWS_PRODUCTION_ROLE_ARN }}' },
        },
      ],
    },
    /assumes AWS_PRODUCTION_ROLE_ARN from the environment staging/u,
  ],
  [
    'a role written out instead of taken from a known secret',
    {
      environment: 'production',
      steps: [
        {
          uses: 'aws-actions/configure-aws-credentials@abc',
          with: { 'role-to-assume': 'arn:aws:iam::000000000000:role/other' },
        },
      ],
    },
    /a role this file does not know/u,
  ],
]) {
  test(`rejected: ${description}`, () => {
    const found = roleAssumptionViolations('x.yml', { jobs: { job } });
    assert.ok(
      found.some((line) => expected.test(line)),
      `expected ${expected} in ${JSON.stringify(found)}`
    );
  });
}

const cicdModule = () => read('infrastructure/modules/cicd/main.tf');
const cicdVariables = () => read('infrastructure/modules/cicd/variables.tf');

/** The string items of `variable "<name>" { ... default = [ ... ] }`. */
function listDefault(source, name) {
  const block = new RegExp(
    `variable "${name}" \\{[\\s\\S]*?\\n  default\\s*=\\s*\\[([^\\]]*)\\]`,
    'u'
  ).exec(source);
  assert.ok(block, `${name} default not found`);
  return [...block[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

/** The string items of a `name = [ ... ]` assignment in a tfvars file, or null. */
function tfvarsList(source, name) {
  const match = new RegExp(`^${name}\\s*=\\s*\\[([^\\]]*)\\]`, 'mu').exec(source);
  return match ? [...match[1].matchAll(/"([^"]+)"/gu)].map((item) => item[1]) : null;
}

test('the Terraform trust policies name exactly the environments the workflows use', () => {
  const productionTfvars = read('infrastructure/environments/production/terraform.tfvars');
  // The deploy role: the module trusts `production` alone, and production's tfvars
  // add the staging Terraform job's environment, in writing.
  assert.deepEqual(listDefault(cicdVariables(), 'deploy_environments'), ['production']);
  assert.deepEqual(
    tfvarsList(productionTfvars, 'cicd_deploy_environments'),
    ROLE_ENVIRONMENTS.AWS_PRODUCTION_ROLE_ARN
  );
  assert.deepEqual(
    listDefault(cicdVariables(), 'release_environments'),
    ROLE_ENVIRONMENTS.AWS_RELEASE_ROLE_ARN
  );
  assert.deepEqual(
    listDefault(cicdVariables(), 'alert_relay_environments'),
    ROLE_ENVIRONMENTS.AWS_ALERT_RELAY_ROLE_ARN
  );
  // No environment is trusted for two roles: the reviewed ones stay reviewed.
  const all = Object.values(ROLE_ENVIRONMENTS).flat();
  assert.equal(new Set(all).size, all.length);
});

test('no role trusts a branch or a tag, and no tfvars file brings one back', () => {
  assert.deepEqual(listDefault(cicdVariables(), 'legacy_allowed_refs'), []);
  const module = cicdModule();
  // Three roles, each with its own subject list built from environment names.
  for (const subjects of ['deploy_subjects', 'release_subjects', 'alert_relay_subjects']) {
    assert.match(
      module,
      new RegExp(`"token\\.actions\\.githubusercontent\\.com:sub" = local\\.${subjects}\\b`, 'u')
    );
  }
  assert.equal([...module.matchAll(/token\.actions\.githubusercontent\.com:sub"/gu)].length, 3);
  // Only the deploy role's list has the transition refs appended, and only release
  // and alert-relay are built from environment names alone.
  assert.match(module, /release_subjects\s*=\s*\[for name in var\.release_environments :/u);
  assert.match(module, /alert_relay_subjects\s*=\s*\[for name in var\.alert_relay_environments :/u);
  assert.doesNotMatch(`${module}\n${cicdVariables()}`, /ref:refs\//u);
  for (const environment of ['production', 'staging']) {
    const tfvars = read(`infrastructure/environments/${environment}/terraform.tfvars`);
    assert.doesNotMatch(tfvars, /^\s*cicd_legacy_allowed_refs\s*=/mu, `${environment} tfvars`);
  }
});

test('production Terraform refuses, before applying, a plan that changes the CI/CD identities', () => {
  const steps = load(read('.github/workflows/cd-production.yml')).jobs.terraform.steps;
  const index = (predicate) => steps.findIndex((step) => predicate(String(step.run ?? '')));
  const plan = index((run) => /terraform plan\b.*-out=tfplan/u.test(run));
  const guard = index((run) => run.includes('startswith("module.cicd")') && /exit 1/u.test(run));
  const marker = steps.findIndex((step) => step.id === 'apply_attempted');
  const apply = index((run) => /terraform apply\b/u.test(run));
  assert.ok(plan >= 0 && guard > plan, 'the guard does not follow the plan');
  // Before the "an apply is about to run" marker, so a refusal reads as nothing touched.
  assert.ok(guard < marker && marker < apply, 'the guard does not come before the apply');
  // The plan is never written out as JSON: that form carries variable values.
  assert.doesNotMatch(String(steps[guard].run), /terraform show -json tfplan\s*>/u);
});

// --- 3. the pipeline cannot widen itself ---------------------------------------

/** One `{ Sid = "<sid>" ... }` statement of a jsonencode'd policy, braces matched. */
function statement(source, sid) {
  const at = source.indexOf(`Sid = "${sid}"`);
  const padded = at >= 0 ? at : source.search(new RegExp(`Sid\\s+= "${sid}"`, 'u'));
  if (padded < 0) return '';
  const start = source.lastIndexOf('{', padded);
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  return '';
}

/** The body of `resource "<type>" "<name>" { ... }`, braces matched. */
function resource(source, type, name) {
  const header = new RegExp(`resource\\s+"${type}"\\s+"${name}"\\s*\\{`, 'u').exec(source);
  if (!header) return '';
  let depth = 1;
  let i = header.index + header[0].length;
  while (depth > 0 && i < source.length) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') depth -= 1;
    i += 1;
  }
  return source.slice(header.index, i);
}

/** Every way the deploy policy would let the pipeline widen itself. Empty means none. */
export function escalationPaths(module) {
  const found = [];
  const deploy = resource(module, 'aws_iam_policy', 'deploy');

  const identities = /ci_identity_arns\s*=\s*\[([^\]]*)\]/u.exec(module)?.[1] ?? '';
  for (const arn of [
    'local.deploy_role_arn',
    'local.release_role_arn',
    'local.alert_relay_role_arn',
    'local.deploy_policy_arn',
    'local.release_policy_arn',
    'local.alert_relay_policy_arn',
    'local.boundary_policy_arn',
    'local.oidc_provider_arn',
  ]) {
    if (!identities.includes(arn)) found.push(`${arn} is not a protected CI/CD identity`);
  }

  const self = statement(deploy, 'DenyChangesToCiIdentities');
  if (
    !/Effect\s*=\s*"Deny"/u.test(self) ||
    !/NotAction\s*=\s*\["iam:Get\*", "iam:List\*"\]/u.test(self) ||
    !/Resource\s*=\s*local\.ci_identity_arns/u.test(self) ||
    /Condition/u.test(self)
  ) {
    found.push('the deploy role can change a CI/CD identity');
  }

  const boundaryCondition =
    /Condition\s*=\s*\{\s*ArnNotEquals\s*=\s*\{\s*"iam:PermissionsBoundary"\s*=\s*local\.boundary_policy_arn\s*\}\s*\}/u;
  const create = statement(deploy, 'DenyRoleWithoutBoundary');
  if (
    !/Effect\s*=\s*"Deny"/u.test(create) ||
    !/Action\s*=\s*\["iam:CreateRole"\]/u.test(create) ||
    !/Resource\s*=\s*"\*"/u.test(create) ||
    !boundaryCondition.test(create)
  ) {
    found.push('the deploy role can create a role with no permissions boundary');
  }
  const put = statement(deploy, 'DenyOtherBoundary');
  if (
    !/Effect\s*=\s*"Deny"/u.test(put) ||
    !/Action\s*=\s*\["iam:PutRolePermissionsBoundary"\]/u.test(put) ||
    !/Resource\s*=\s*"\*"/u.test(put) ||
    !boundaryCondition.test(put)
  ) {
    found.push('the deploy role can put another boundary on a role');
  }
  const remove = statement(deploy, 'DenyBoundaryRemoval');
  if (
    !/Effect\s*=\s*"Deny"/u.test(remove) ||
    !/Action\s*=\s*\["iam:DeleteRolePermissionsBoundary"\]/u.test(remove) ||
    !/Resource\s*=\s*"\*"/u.test(remove) ||
    /Condition/u.test(remove)
  ) {
    found.push('the deploy role can remove a permissions boundary');
  }
  const attach = statement(deploy, 'DenyOtherManagedPolicies');
  if (
    !/Effect\s*=\s*"Deny"/u.test(attach) ||
    !/Action\s*=\s*\["iam:AttachRolePolicy"\]/u.test(attach) ||
    !/ArnNotLike/u.test(attach) ||
    /arn:aws:iam::aws:policy\/(?!AWSXRayDaemonWriteAccess")/u.test(attach)
  ) {
    found.push('the deploy role can attach an AWS-managed policy other than the X-Ray one');
  }

  // The only IAM Allow beyond reads is on project-prefixed roles and policies.
  const write = statement(deploy, 'IamWriteProjectScoped');
  if (/Resource\s*=\s*"\*"/u.test(write) || !/local\.project_role_arn/u.test(write)) {
    found.push('the deploy role has an IAM write that is not scoped to the project');
  }

  // The release role: no IAM write at all.
  const release = resource(module, 'aws_iam_policy', 'release');
  const shared = /shared_statements\s*=\s*\[([\s\S]*?)\n {2}\]\n/u.exec(module)?.[1] ?? '';
  const allowsIamWrite = (text) =>
    [...text.matchAll(/"iam:([A-Za-z*]+)"/gu)].some(
      (match) => !/^(Get|List)\*$/u.test(match[1]) && !text.includes('NotAction')
    );
  if (
    allowsIamWrite(shared) ||
    /"iam:\*"/u.test(release.replace(statement(release, 'DenyIamWrites'), ''))
  ) {
    found.push('the release role has an IAM write');
  }
  const releaseDeny = statement(release, 'DenyIamWrites');
  if (
    !/Effect\s*=\s*"Deny"/u.test(releaseDeny) ||
    !/NotAction\s*=\s*\["iam:Get\*", "iam:List\*"\]/u.test(releaseDeny)
  ) {
    found.push('the release role does not deny IAM writes outright');
  }
  if (
    !/role\s*=\s*aws_iam_role\.github_release\.name\s*\n\s*policy_arn\s*=\s*aws_iam_policy\.release\.arn/u.test(
      module
    )
  ) {
    found.push('the release role does not carry the release policy');
  }
  if (
    /role\s*=\s*aws_iam_role\.github_release\.name\s*\n\s*policy_arn\s*=\s*aws_iam_policy\.deploy\.arn/u.test(
      module
    )
  ) {
    found.push('the release role carries the deploy policy');
  }

  // The alert relay: two read-only actions.
  const relay = resource(module, 'aws_iam_policy', 'alert_relay');
  const relayActions = [...relay.matchAll(/"([a-z0-9-]+:[A-Za-z*]+)"/gu)].map((match) => match[1]);
  if (relayActions.sort().join() !== 'cloudwatch:DescribeAlarms,sns:GetTopicAttributes') {
    found.push(`the alert-relay role allows [${relayActions.join(', ')}]`);
  }
  return found;
}

test('the deploy pipeline cannot widen itself or what it creates', () => {
  assert.deepEqual(escalationPaths(cicdModule()), []);
});

for (const [description, sabotage, expected] of [
  [
    'the self-modification deny narrowed to a few actions',
    (m) =>
      m.replace(
        /NotAction = \["iam:Get\*", "iam:List\*"\]\n(\s+)Resource {2}= local\.ci_identity_arns/u,
        'Action = ["iam:AttachRolePolicy", "iam:PutRolePolicy"]\n$1Resource  = local.ci_identity_arns'
      ),
    /can change a CI\/CD identity/u,
  ],
  [
    'the deploy policy left out of the protected identities',
    (m) => m.replace(/\n\s+local\.deploy_policy_arn,(\n\s+local\.release_policy_arn,)/u, '$1'),
    /local\.deploy_policy_arn is not a protected CI\/CD identity/u,
  ],
  [
    'the OIDC provider left out of the protected identities',
    (m) => m.replace(/\n\s+local\.oidc_provider_arn,\n(\s+\]\n)/u, '\n$1'),
    /local\.oidc_provider_arn is not a protected CI\/CD identity/u,
  ],
  [
    'role creation without a boundary',
    (m) => m.replace(/Sid\s+= "DenyRoleWithoutBoundary"/u, 'Sid = "Removed"'),
    /can create a role with no permissions boundary/u,
  ],
  [
    'boundary removal allowed',
    (m) => m.replace('"iam:DeleteRolePermissionsBoundary"', '"iam:ListRoles"'),
    /can remove a permissions boundary/u,
  ],
  [
    'any AWS-managed policy attachable',
    (m) =>
      m.replace(
        '"arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"',
        '"arn:aws:iam::aws:policy/*"'
      ),
    /can attach an AWS-managed policy/u,
  ],
  [
    'an IAM write on every resource',
    (m) =>
      m.replace(
        /Resource = \[\n\s+local\.project_role_arn,\n\s+"\$\{local\.iam_prefix\}:policy\/\$\{var\.project_name\}-\*",\n\s+\]/u,
        'Resource = "*"'
      ),
    /an IAM write that is not scoped to the project/u,
  ],
  [
    'the release role given the deploy policy',
    (m) =>
      m.replace(
        /(role\s*=\s*aws_iam_role\.github_release\.name\s*\n\s*policy_arn\s*=\s*)aws_iam_policy\.release\.arn/u,
        '$1aws_iam_policy.deploy.arn'
      ),
    /the release role (does not carry the release policy|carries the deploy policy)/u,
  ],
  [
    'the release role losing its IAM deny',
    (m) => m.replace(/Sid\s+= "DenyIamWrites"/u, 'Sid = "Removed"'),
    /does not deny IAM writes outright/u,
  ],
  [
    'the alert relay given a write',
    (m) => m.replace('"sns:GetTopicAttributes"', '"sns:GetTopicAttributes", "sns:Publish"'),
    /the alert-relay role allows/u,
  ],
]) {
  test(`rejected: ${description}`, () => {
    const module = cicdModule();
    const sabotaged = sabotage(module);
    assert.notEqual(sabotaged, module, 'the sabotage changed nothing');
    const found = escalationPaths(sabotaged);
    assert.ok(
      found.some((line) => expected.test(line)),
      `expected ${expected} in ${JSON.stringify(found)}`
    );
  });
}

test('the existing role and policy keep their identity, so applying this updates them in place', () => {
  // The deploy role and its policy already exist in the account. A changed name
  // or policy description is a replacement, not an update: Terraform would delete
  // the policy the live role depends on before creating the new one.
  const module = cicdModule();
  assert.match(module, /deploy_role_name\s*=\s*"\$\{var\.project_name\}-github-deploy"/u);
  const policy = resource(module, 'aws_iam_policy', 'deploy');
  assert.match(policy, /\n {2}name = local\.deploy_role_name\n/u);
  assert.ok(
    policy.includes(
      'description = "Scoped deploy permissions for the GitHub Actions CD role: full access within the services this stack manages, IAM limited to project-prefixed roles/policies."'
    ),
    'the deploy policy description changed, which replaces the policy'
  );
  assert.match(
    resource(module, 'aws_iam_role', 'github_deploy'),
    /\n {2}name = local\.deploy_role_name\n/u
  );
});

// --- the permissions boundary ---------------------------------------------------

function terraformFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === '.terraform') return [];
    if (statSync(path).isDirectory()) return terraformFiles(path);
    return name.endsWith('.tf') ? [path] : [];
  });
}

/** Service prefixes the boundary allows, e.g. `s3` for `"s3:*"`. */
function boundaryServices(module) {
  const boundary = resource(module, 'aws_iam_policy', 'permissions_boundary');
  return [...boundary.matchAll(/"([a-z0-9-]+):\*"/gu)].map((match) => match[1]).sort();
}

/**
 * Service prefixes named by an IAM action anywhere in a role's policy outside the
 * CI/CD module: `"dynamodb:GetItem"` gives `dynamodb`. Condition keys (`aws:...`,
 * `s3:prefix`) and the trust policies' `sts:AssumeRole` are not actions on a
 * service the role calls.
 */
function servicesRolePoliciesUse() {
  const services = new Set();
  for (const path of terraformFiles(join(ROOT, 'infrastructure/modules'))) {
    if (path.includes(`${join('modules', 'cicd')}`)) continue;
    const source = readFileSync(path, 'utf8');
    for (const name of [...source.matchAll(/resource\s+"aws_iam_role_policy"\s+"([^"]+)"/gu)]) {
      const body = resource(source, 'aws_iam_role_policy', name[1]);
      for (const match of body.matchAll(/"([a-z0-9-]+):([A-Z][A-Za-z]*\*?|\*)"/gu)) {
        services.add(match[1]);
      }
    }
    for (const match of source.matchAll(/arn:aws:iam::aws:policy\/([A-Za-z]+)/gu)) {
      // The one AWS-managed policy the Lambda roles attach.
      if (match[1] === 'AWSXRayDaemonWriteAccess') services.add('xray');
    }
  }
  return [...services].sort();
}

test('the boundary covers every service a Lambda role policy names, so attaching it takes nothing away', () => {
  const allowed = boundaryServices(cicdModule());
  const used = servicesRolePoliciesUse();
  assert.ok(
    used.length >= 8,
    `found only [${used.join(', ')}]: the scan is not seeing the role policies`
  );
  const missing = used.filter((service) => !allowed.includes(service));
  assert.deepEqual(
    missing,
    [],
    'add the service to the boundary in infrastructure/modules/cicd/main.tf, and have an admin apply it BEFORE this is released'
  );
});

test('the boundary allows no IAM, STS, organization or account action', () => {
  const allowed = boundaryServices(cicdModule());
  for (const never of ['iam', 'sts', 'organizations', 'account', 'billing', 'sso']) {
    assert.ok(!allowed.includes(never), `the boundary allows ${never}:*`);
  }
  const boundary = resource(cicdModule(), 'aws_iam_policy', 'permissions_boundary');
  assert.doesNotMatch(boundary, /"\*"\s*\]/u, 'the boundary allows every action');
  assert.doesNotMatch(boundary, /Action\s*=\s*"\*"/u);
});

test('every role outside the CI/CD module takes the boundary when one is configured', () => {
  const without = [];
  let roles = 0;
  for (const path of terraformFiles(join(ROOT, 'infrastructure/modules'))) {
    if (path.includes(`${join('modules', 'cicd')}`)) continue;
    const source = readFileSync(path, 'utf8');
    for (const name of [...source.matchAll(/resource\s+"aws_iam_role"\s+"([^"]+)"/gu)]) {
      roles += 1;
      const body = resource(source, 'aws_iam_role', name[1]);
      if (
        !/permissions_boundary\s*=\s*var\.permissions_boundary_arn == "" \? null : var\.permissions_boundary_arn/u.test(
          body
        )
      ) {
        without.push(`${path.slice(ROOT.length + 1)}:${name[1]}`);
      }
    }
  }
  assert.ok(roles >= 4, `found ${roles} roles: the scan is not seeing them`);
  assert.deepEqual(without, []);

  const root = read('infrastructure/main.tf');
  assert.match(
    root,
    /permissions_boundary_arn = var\.iam_permissions_boundary_enabled \? "arn:aws:iam::\$\{data\.aws_caller_identity\.current\.account_id\}:policy\/\$\{var\.project_name\}-permissions-boundary" : ""/u
  );
  assert.equal(
    [...root.matchAll(/permissions_boundary_arn\s+= local\.permissions_boundary_arn/gu)].length,
    2
  );
  // The name the root builds is the name the module gives the policy.
  assert.match(
    cicdModule(),
    /boundary_policy_name\s*=\s*"\$\{var\.project_name\}-permissions-boundary"/u
  );
});

test('the boundary is on in staging first, and each environment says so in writing', () => {
  const setting = (environment) =>
    /^iam_permissions_boundary_enabled\s*=\s*(true|false)\s*$/mu.exec(
      read(`infrastructure/environments/${environment}/terraform.tfvars`)
    )?.[1];
  assert.equal(setting('staging'), 'true');
  assert.ok(['true', 'false'].includes(setting('production')), 'production does not state it');
  // Off unless a tfvars file turns it on: the roles would otherwise name a policy
  // that may not exist yet.
  const variables = read('infrastructure/variables.tf');
  assert.match(
    variables,
    /variable "iam_permissions_boundary_enabled" \{[\s\S]*?type\s*=\s*bool\s*\n\s*default\s*=\s*false/u
  );
});
