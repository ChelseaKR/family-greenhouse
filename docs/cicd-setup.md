# CI/CD setup

One-time setup so the GitHub Actions workflows in `.github/workflows/` can deploy this repo to AWS using short-lived OIDC creds instead of long-lived access keys.

## Prereqs

- Repo pushed to GitHub.
- AWS account in `terraform.tfvars` already bootstrapped (S3 backend + DDB lock table exist — see `docs/deployment.md`).
- Local AWS CLI authenticated as an IAM user with permission to manage IAM (the bootstrap user).

## Step 1 — Set the GitHub repo coordinates in tfvars

Edit `infrastructure/environments/production/terraform.tfvars`:

```hcl
github_org  = "<your-github-username-or-org>"
github_repo = "family-greenhouse"
```

## Step 2 — Apply the CI/CD module

This module is applied from an admin session, never by the pipeline (see
"Changing the CI/CD roles" below for why, and for the commands).

```bash
cd infrastructure
terraform plan -var-file=environments/production/terraform.tfvars \
  -target='module.cicd' -out=cicd.tfplan
# expect: the OIDC provider, three roles (deploy, release, alert-relay), their
# three policies, and the permissions boundary
terraform apply cicd.tfplan
```

Save the three role ARNs:

```bash
terraform output -raw github_deploy_role_arn       # -> AWS_PRODUCTION_ROLE_ARN
terraform output -raw github_release_role_arn      # -> AWS_RELEASE_ROLE_ARN
terraform output -raw github_alert_relay_role_arn  # -> AWS_ALERT_RELAY_ROLE_ARN
```

Which role does what ([ADR 0049](adr/0049-aws-trusts-github-environments-and-the-pipeline-cannot-widen-itself.md)):

| Role                                   | Can                                                                                                       | AWS lets it be assumed from the GitHub environment |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `family-greenhouse-github-deploy`      | `terraform apply`: the stack's services, and IAM writes on project roles, bounded                         | `production`, `staging-infrastructure`             |
| `family-greenhouse-github-release`     | everything a release does after Terraform (Lambda code, frontend, smoke fixtures, rollback); no IAM write | `production-release`, `staging`                    |
| `family-greenhouse-github-alert-relay` | read alarm state and the alerts topic's attributes                                                        | `alert-relay`                                      |

No role trusts a branch or a tag. A job with no `environment:` cannot assume any of them.

## Step 3 — Configure GitHub repo secrets + vars

In **Settings → Secrets and variables → Actions**:

### Repository **secrets**

| Name                                    | Value                                                                                                                                                                                                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AWS_PRODUCTION_ROLE_ARN`               | `github_deploy_role_arn` from step 2: the deploy role, used by the two `terraform` jobs                                                                                                                                                                           |
| `AWS_RELEASE_ROLE_ARN`                  | `github_release_role_arn` from step 2: the release role, used by every other deploy, smoke, cleanup and rollback job in `cd-production.yml` and `cd-staging.yml`                                                                                                  |
| `AWS_ALERT_RELAY_ROLE_ARN`              | `github_alert_relay_role_arn` from step 2: the read-only role `alert-relay.yml` uses                                                                                                                                                                              |
| `E2E_PUBLIC_SIGNUP_EMAIL_TEMPLATE`      | a plus-address template at a monitored, deliverable inbox; keep the literal `{tag}` placeholder (for example, `fg-smoke+{tag}@familygreenhouse.net` only when that domain accepts those addresses)                                                                |
| `PRODUCTION_WEB_PUSH_VAPID_PRIVATE_KEY` | the production private key from `npx web-push generate-vapid-keys`; never expose this as a `VITE_*` value                                                                                                                                                         |
| `STAGING_WEB_PUSH_VAPID_PRIVATE_KEY`    | the separate staging private key; may stay unset when staging background push is intentionally disabled                                                                                                                                                           |
| `PRODUCTION_PLANT_ID_API_KEY`           | production Plant.id API key; blank disables real photo identification                                                                                                                                                                                             |
| `STAGING_PLANT_ID_API_KEY`              | separate staging Plant.id key, or blank when staging identification is intentionally disabled                                                                                                                                                                     |
| `PRODUCTION_OPENWEATHER_API_KEY`        | production OpenWeather key for geocoding and climate-aware care                                                                                                                                                                                                   |
| `STAGING_OPENWEATHER_API_KEY`           | separate staging OpenWeather key, or blank when staging climate is intentionally disabled                                                                                                                                                                         |
| `PRODUCTION_BACKEND_SENTRY_DSN`         | DSN for the production Node/AWS Lambda Sentry project; blank disables the optional rail                                                                                                                                                                           |
| `PRODUCTION_FRONTEND_SENTRY_DSN`        | DSN for the production React Sentry project; blank disables the optional rail                                                                                                                                                                                     |
| `STAGING_BACKEND_SENTRY_DSN`            | DSN for the staging Node/AWS Lambda Sentry project                                                                                                                                                                                                                |
| `STAGING_FRONTEND_SENTRY_DSN`           | DSN for the staging React Sentry project                                                                                                                                                                                                                          |
| `PRODUCTION_POSTHOG_KEY`                | production PostHog project key (`phc_…`), **repository scope** — the `build` job runs outside the `production` environment, so an environment-scoped copy reaches the bundle empty; blank leaves the PostHog rail off (`docs/analytics.md`, "Turning PostHog on") |
| `STAGING_POSTHOG_KEY`                   | isolated staging PostHog project key, or blank                                                                                                                                                                                                                    |

### Repository **variables**

| Name                                   | Value                                                             |
| -------------------------------------- | ----------------------------------------------------------------- |
| `PRODUCTION_API_URL`                   | `https://<api-id>.execute-api.us-east-1.amazonaws.com/production` |
| `PRODUCTION_URL`                       | `https://familygreenhouse.net`                                    |
| `PRODUCTION_COGNITO_USER_POOL_ID`      | `us-east-1_XXXXXXXXX`                                             |
| `PRODUCTION_COGNITO_CLIENT_ID`         | `<cognito-client-id>`                                             |
| `PRODUCTION_WEB_PUSH_VAPID_PUBLIC_KEY` | the production public key from the same VAPID pair                |
| `PRODUCTION_WEB_PUSH_VAPID_SUBJECT`    | a monitored contact URI, e.g. `mailto:hello@familygreenhouse.net` |
| `STAGING_WEB_PUSH_VAPID_PUBLIC_KEY`    | the staging public key, or blank to disable staging push          |
| `STAGING_WEB_PUSH_VAPID_SUBJECT`       | the staging contact URI, or blank with the other staging values   |
| `PRODUCTION_POSTHOG_HOST`              | `https://us.i.posthog.com` or `https://eu.i.posthog.com`          |
| `STAGING_POSTHOG_HOST`                 | staging PostHog cloud host                                        |
| `PRODUCTION_SENTRY_TRACES_SAMPLE_RATE` | backend trace sample rate, normally `0.1`                         |
| `STAGING_SENTRY_TRACES_SAMPLE_RATE`    | staging trace sample rate, normally `0.1`                         |

Staging does not require duplicate URL or Cognito repository variables. Its
workflow builds the deployable frontend after Terraform applies, then passes
the stack's `api_url`, `site_url`, user-pool id, and table name outputs directly
to the frontend build, health check, and deployed smoke test. VAPID is the
exception because the same key pair must reach both Terraform/Lambda and the
browser build; all three values must be supplied together, or all left blank.

The current values can also be re-pulled at any time with `terraform -chdir=infrastructure output`.

## Step 4 — Create the GitHub environments

AWS decides which role a job gets from the job's GitHub environment, so the
environments are part of the security boundary. In **Settings → Environments**:

| Environment              | Required reviewer       | Deployment branches and tags | Used by                                    |
| ------------------------ | ----------------------- | ---------------------------- | ------------------------------------------ |
| `production`             | **yourself (required)** | `v*` tags and `main`         | `cd-production.yml` `terraform`            |
| `staging-infrastructure` | **yourself (required)** | `main`                       | `cd-staging.yml` `terraform`               |
| `production-release`     | none                    | `v*` tags and `main`         | every other AWS job in `cd-production.yml` |
| `staging`                | none                    | `main`                       | every other AWS job in `cd-staging.yml`    |
| `alert-relay`            | none                    | `main`                       | `alert-relay.yml`                          |

- **The two reviewed environments are what stand between a workflow run and the
  deploy role.** GitHub creates an environment that does not exist the first
  time a job names it, with no reviewer. Create `staging-infrastructure` and
  add the reviewer **before** the trust for it is applied in step 2. A file
  cannot check this; `docs/production-checklist.md` carries the item.
- The three unreviewed environments must stay unreviewed: `production-release`
  holds the rollback, and a reviewer there would make a failed release wait for
  a click before it is undone.
- **Wait timer**: 0 (optional on `production` — set to 5–60 min if you want a
  cooling-off period).

`cd-production.yml` references `environment: production` on one job, `terraform`, the first that touches production, so a release is blocked until you click "Approve and deploy" in the Actions UI. That single approval covers Terraform and both deploy jobs, which run in `production-release`. A staging deploy asks for one approval too, on its `terraform` job.

## Step 5 — First triggered deploy

```bash
git tag v0.1.0
git push origin v0.1.0
```

This kicks off `cd-production.yml`. Walk through:

1. **validate** job — checks tag format.
2. **preflight-release-role** job — assumes the release role and makes one read-only call, so a missing role, trust, environment or secret stops the release here, before anything is applied.
3. **build** job — runs `npm test`, builds backend + frontend bundles, uploads artifacts.
4. **terraform** job — gated on `production` environment approval, then plans. If the plan would change `module.cicd` it stops before applying (see "Changing the CI/CD roles"). Otherwise `terraform apply` against prod tfvars.
   - Click **Review deployments** → Approve. This is the only approval in the release.
5. **deploy-backend**, then **deploy-frontend** — run on that approval, only if the job before them succeeded.
6. **smoke-tests** job — runs the post-deploy Playwright smoke against `https://familygreenhouse.net`, including a real public signup through the unconfirmed/confirmation-ready state and a separate admin-created authenticated fixture. Both disposable Cognito users are deleted.
7. On a deploy or smoke failure, **rollback** restores Cognito's pre-deploy signup policy, restores the pre-deploy frontend snapshot + CloudFront cache, and re-publishes the archived previous Lambda code. After either a successful smoke or a verified rollback, the run-scoped frontend snapshot prefix is permanently purged, including every S3 object version and delete marker.

## Changing the CI/CD roles

`infrastructure/modules/cicd` holds the OIDC provider, the three roles, their
policies and the permissions boundary. **The pipeline cannot change any of
them**: the deploy role is denied every IAM action that is not a read on those
identities, its own included. So:

- A change to that module reaches AWS only from an admin session:

  ```bash
  cd infrastructure
  terraform init
  terraform plan -var-file=environments/production/terraform.tfvars \
    -target='module.cicd' -out=cicd.tfplan
  # read it: only module.cicd[0].* addresses, and no role is destroyed
  terraform apply cicd.tfplan
  ```

  The plan needs values for the variables that have no default (the ones CD
  passes as `TF_VAR_*`); with `-target` they are not used, so any placeholder
  works. Do not run an untargeted apply from a laptop.

- If a release reaches the `terraform` job with such a change unapplied, the
  job stops at "Refuse a plan that changes the CI/CD identities", before
  anything is applied, and lists the addresses. Apply the module as above and
  run the release again.
- Apply the admin change **before** merging the pull request that needs it
  whenever the change adds something (a role, an environment, a boundary
  service), and **after** the workflows have stopped using it whenever the
  change removes something.

### The permissions boundary

Every project role that is not one of the three CI/CD roles (the Lambda
execution roles today) can carry `family-greenhouse-permissions-boundary`: the
most the role can ever be allowed, however its own policy is written. The
deploy role must set it on any role it creates and cannot remove it.

- It is switched per environment by `iam_permissions_boundary_enabled` in the
  tfvars: on in staging, off in production until staging has run under it.
  Turning it on is an ordinary release. **Turning it off is not**: the pipeline
  is denied `iam:DeleteRolePermissionsBoundary`, so an admin runs
  `aws iam delete-role-permissions-boundary --role-name <role>` for each of the
  environment's four roles (`family-greenhouse-lambda-<env>`,
  `-chat-stream-<env>`, `-cognito-messages-<env>`, `-mail-forwarder-<env>`)
  and then sets the variable to `false`.
- When a Lambda role's policy starts naming a service the boundary does not
  list, `scripts/ci-least-privilege.test.mjs` fails in CI. Add the service to
  the boundary, apply the module as an admin, then release.

### Moving an existing account to environment-only trust (one time)

The workflows on `main` and the trust policy have to change together, and
neither can go first on its own: the old workflows assume the role from a
branch or a tag, the new ones from environments the old trust does not name.
`cicd_legacy_allowed_refs` bridges the gap. It is passed on the command line,
never written into a tfvars file.

1. In GitHub settings, create `staging-infrastructure` with yourself as
   required reviewer (step 4).
2. From the branch that has the new module, as an admin, apply it with the old
   refs still trusted:

   ```bash
   terraform plan -var-file=environments/production/terraform.tfvars \
     -var='cicd_legacy_allowed_refs=["ref:refs/heads/main","ref:refs/tags/v*"]' \
     -target='module.cicd' -out=cicd.tfplan
   terraform apply cicd.tfplan
   ```

   The old workflows keep working. The two new roles and the boundary now
   exist, and the deploy role can no longer change itself.

3. Add the `AWS_RELEASE_ROLE_ARN` and `AWS_ALERT_RELAY_ROLE_ARN` secrets
   (step 3). `AWS_DEPLOY_ROLE_ARN` is no longer read and can be deleted later.
4. Merge the pull request with the new workflows. Run **Deploy to Staging**
   and approve its `terraform` job. Check the next **Alert relay** run is green.
5. As an admin, apply again without the `-var`. The plan changes one thing:
   the deploy role's trust policy loses the two refs.
6. Tag a release. `preflight-release-role` and the plan check both run before
   anything is applied.

Until step 5 is done, a production release stops at the plan check (the plan
still wants to remove the two refs). That is the check working; do step 5.

**To undo:** apply the module again with the `-var` from step 2. Every
workflow, old or new, can then assume the deploy role as before.

## Notes

- The three roles use customer-managed policies in
  `infrastructure/modules/cicd/main.tf`, scoped to this stack's service set.
  Only the deploy role has IAM writes; they are limited to project-prefixed
  roles and policies, and explicit denies stop it changing the CI/CD
  identities, creating a role without the boundary, removing a boundary, or
  attaching a managed policy from outside the project.
  The first deploy after adding a new AWS service should fail closed until its
  required action is deliberately added to that policy, by an admin.
- The workflows that hold an OIDC token or a secret install dependencies with
  `npm ci --ignore-scripts`, so no package's install script runs beside them.
  `scripts/ci-least-privilege.test.mjs` fails if a dependency that declares an
  install script is added; such a package is installed in a job that holds
  nothing, not added to the list there.
- The IAM OIDC provider is a global, one-per-account resource. If you ever add another OIDC consumer in this AWS account, share this provider rather than creating a second one.
- Rotate the thumbprint values in `infrastructure/modules/cicd/main.tf` if GitHub rotates its OIDC cert (rare — once a year at most).

## Branch protection — committed evidence (CICD-12/13, CQ-37-43)

The live `main` ruleset is committed as [`.github/rulesets/main.json`](../.github/rulesets/main.json) per `STANDARDS/CI-CD-STANDARD.md` §5, with the honest posture reading and regeneration command in [`.github/rulesets/README.md`](../.github/rulesets/README.md). History of the artifact:

- **2026-07-05:** first snapshot committed at `docs/branch-ruleset.json` against the then-active ruleset "main: PRs + green gates" (id 17592136). Its honest reading flagged two problems: Lighthouse was **not** a required check (a red Lighthouse run could merge), and `bypass_actors` gave the Repository-admin role `bypass_mode: "always"` (the owner could merge past every rule).
- **2026-07-09:** that permissive ruleset was **deleted** and replaced by `protect-main` (id 18752847), which fixes both: all four Lighthouse/Bundle-size/E2E perf-a11y checks are now required (13 required checks total) and `bypass_actors` is empty — no admin bypass. The stale `docs/branch-ruleset.json` snapshot was removed when the new artifact landed.
- **2026-07-19:** the live ruleset was edited (its `updated_at`, unchanged since, is 2026-07-19T22:28:45-07:00) and the committed artifact was never regenerated against it. A read-only fetch on 2026-08-29 shows the live ruleset carrying one bypass actor — the owner as a **user** (3114598) with `bypass_mode: "pull_request"`, so `current_user_can_bypass` is `pull_requests_only` — which the committed file did not record.
- **2026-08-29:** the committed `bypass_actors: []` was corrected to `[{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }]` — the admin role, always. The 2026-07-09 entry above framed the empty list as a hardening win; **that reading is reversed.** An empty bypass list is not a stricter gate, it is a lockout: it removes the owner's only way to merge past a check that cannot report, push a fix, or delete the blocking ruleset, and GitHub answers 201 when you apply it, so nothing warns you. A PR-only bypass is no better when the wedged thing is the pull request. This is a deliberate divergence from the vendored CICD-15/§5.1, recorded in [`.github/rulesets/README.md`](../.github/rulesets/README.md) along with the owner-only command that reconciles the still-diverged live ruleset. `backend/tests/unit/config/branchRuleset.test.ts` (required `Test Backend`) now fails on any regression to an empty, absent, wrong-actor, or PR-only bypass list.
- **Still true, stated honestly:** `strict_required_status_checks_policy: false` (a PR can merge without being up to date with `main`), and there is **no `pull_request` rule** — required reviewers remain effectively 0 because this is a solo-maintainer repo and GitHub does not count self-approval. `.github/CODEOWNERS` documents ownership but cannot usefully gate on a second reviewer. See the solo-maintainer caveat in `DEFINITION_OF_DONE.md`.
