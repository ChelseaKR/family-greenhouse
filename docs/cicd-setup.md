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

```bash
cd infrastructure
terraform plan -var-file=environments/production/terraform.tfvars -out=cicd.tfplan
# expect: OIDC provider, deploy role, and the project-scoped customer policy
terraform apply cicd.tfplan
```

Save the output role ARN:

```bash
terraform output -raw github_deploy_role_arn
# -> arn:aws:iam::<AWS_ACCOUNT_ID>:role/family-greenhouse-github-deploy
```

## Step 3 — Configure GitHub repo secrets + vars

In **Settings → Secrets and variables → Actions**:

### Repository **secrets**

| Name                      | Value                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| `AWS_PRODUCTION_ROLE_ARN` | the `terraform output` value from step 2                               |
| `AWS_DEPLOY_ROLE_ARN`     | same value (used by `cd-staging.yml` until you split the staging role) |

### Repository **variables**

| Name                              | Value                                                             |
| --------------------------------- | ----------------------------------------------------------------- |
| `PRODUCTION_API_URL`              | `https://<api-id>.execute-api.us-east-1.amazonaws.com/production` |
| `PRODUCTION_URL`                  | `https://familygreenhouse.net`                                    |
| `PRODUCTION_COGNITO_USER_POOL_ID` | `us-east-1_XXXXXXXXX`                                             |
| `PRODUCTION_COGNITO_CLIENT_ID`    | `<cognito-client-id>`                                             |
| `STAGING_API_URL`                 | (defer until staging is provisioned)                              |
| `STAGING_URL`                     | (defer)                                                           |
| `STAGING_COGNITO_USER_POOL_ID`    | (defer)                                                           |
| `STAGING_COGNITO_CLIENT_ID`       | (defer)                                                           |

The current values can also be re-pulled at any time with `terraform -chdir=infrastructure output`.

## Step 4 — Create the GitHub `production` environment with required reviewers

In **Settings → Environments → New environment** → name it `production`:

- **Required reviewers**: add yourself.
- **Wait timer**: 0 (optional — set to 5–60 min if you want a cooling-off period).
- **Deployment branches and tags**: restrict to `v*` tags and `main`.

`cd-production.yml` references `environment: production` on its deploy jobs, so deploys are blocked until you click "Approve and deploy" in the Actions UI.

## Step 5 — First triggered deploy

```bash
git tag v0.1.0
git push origin v0.1.0
```

This kicks off `cd-production.yml`. Walk through:

1. **validate** job — checks tag format.
2. **build** job — runs `npm test`, builds backend + frontend bundles, uploads artifacts.
3. **terraform** job — `terraform apply` against prod tfvars.
4. **deploy-backend** + **deploy-frontend** jobs — gated on `production` environment approval.
   - Click **Review deployments** → Approve.
5. **smoke-tests** job — runs the post-deploy Playwright smoke against `https://familygreenhouse.net`.
6. On smoke failure, **rollback** job runs and re-publishes the previous Lambda code where archived.

## Notes

- The OIDC role uses the customer-managed policy in
  `infrastructure/modules/cicd/main.tf`, scoped to this stack's service set;
  IAM writes are limited to project-prefixed resources and an explicit deny
  prevents the deploy role from attaching/embedding broader policy on itself.
  The first deploy after adding a new AWS service should fail closed until its
  required action is deliberately added to that policy.
- The IAM OIDC provider is a global, one-per-account resource. If you ever add another OIDC consumer in this AWS account, share this provider rather than creating a second one.
- Rotate the thumbprint values in `infrastructure/modules/cicd/main.tf` if GitHub rotates its OIDC cert (rare — once a year at most).

## Branch protection — committed evidence (CICD-12/13, CQ-37-43)

The live `main` ruleset is committed as [`.github/rulesets/main.json`](../.github/rulesets/main.json) per `STANDARDS/CI-CD-STANDARD.md` §5, with the honest posture reading and regeneration command in [`.github/rulesets/README.md`](../.github/rulesets/README.md). History of the artifact:

- **2026-07-05:** first snapshot committed at `docs/branch-ruleset.json` against the then-active ruleset "main: PRs + green gates" (id 17592136). Its honest reading flagged two problems: Lighthouse was **not** a required check (a red Lighthouse run could merge), and `bypass_actors` gave the Repository-admin role `bypass_mode: "always"` (the owner could merge past every rule).
- **2026-07-09:** that permissive ruleset was **deleted** and replaced by `protect-main` (id 18752847), which fixes both: all four Lighthouse/Bundle-size/E2E perf-a11y checks are now required (13 required checks total) and `bypass_actors` is empty — no admin bypass. The stale `docs/branch-ruleset.json` snapshot was removed when the new artifact landed.
- **Still true, stated honestly:** `strict_required_status_checks_policy: false` (a PR can merge without being up to date with `main`), and there is **no `pull_request` rule** — required reviewers remain effectively 0 because this is a solo-maintainer repo and GitHub does not count self-approval. `.github/CODEOWNERS` documents ownership but cannot usefully gate on a second reviewer. See the solo-maintainer caveat in `DEFINITION_OF_DONE.md`.
