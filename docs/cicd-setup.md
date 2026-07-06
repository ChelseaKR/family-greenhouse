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
# expect: ~3 resources added (OIDC provider, role, admin policy attachment)
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

- The OIDC role is currently `AdministratorAccess`. The **trust policy** is what limits damage: only the configured repo + refs + `production` environment can assume it. Scope the permission policy to least-privilege as a follow-up — IAM, Lambda, API Gateway, DynamoDB, Cognito, S3, CloudFront, Route 53, SES, ACM, WAFv2, EventBridge, CloudWatch suffice.
- The IAM OIDC provider is a global, one-per-account resource. If you ever add another OIDC consumer in this AWS account, share this provider rather than creating a second one.
- Rotate the thumbprint values in `infrastructure/modules/cicd/main.tf` if GitHub rotates its OIDC cert (rare — once a year at most).

## Branch protection — committed evidence (CICD-12/13, CQ-37-43)

`docs/branch-ruleset.json` is a fetched (read-only `gh api`), dated snapshot of the actual `main` branch ruleset — added 2026-07-05 so these rows stop being UNVERIFIED-with-no-artifact in the conformance audit. Honest reading of what it says:

- **Strict status checks:** `strict_required_status_checks_policy: false` — a PR can merge without its branch being up to date with `main` first. **Required checks:** Lint, Type Check, Test Frontend, Test Backend, Security Scan, SAST (Semgrep), Terraform Validate, Build, Bundle size, E2E + accessibility (Playwright). **Notably absent: Lighthouse.** The Lighthouse job now always runs when `frontend/**` changes (the `skip-lighthouse` label bypass was closed 2026-07-05), but a PR can still merge on a **red** Lighthouse run today, because it isn't in this required-checks list. ⛔ **Action needed (GitHub ruleset write — not performed by this remediation pass):** add `Lighthouse (mobile + desktop) (desktop)` and `Lighthouse (mobile + desktop) (mobile)` to the ruleset's `required_status_checks`. Exact command: `gh api --method PUT repos/ChelseaKR/family-greenhouse/rulesets/17592136 --input <(jq '...' docs/branch-ruleset.json)`, or do it via **Settings → Rules → Rulesets → main: PRs + green gates** in the GitHub UI (simpler, less error-prone for a one-time change).
- **No force-push, no deletion:** both enforced (`non_fast_forward`, `deletion` rules present) — REL-07/CICD-16 covered.
- **Required reviewers: 0.** `required_approving_review_count: 0`, no CODEOWNERS review requirement, `dismiss_stale_reviews_on_push: false`. This is a **solo-maintainer repo** — stated here honestly rather than claimed as "≥1 external review," per the audit's explicit ask. `.github/CODEOWNERS` (added 2026-07-05) documents ownership but does not (and, solo-maintainer, structurally cannot usefully) gate on a second reviewer.
- **Bypass: `bypass_actors` includes the Repository-admin role with `bypass_mode: "always"`** (`current_user_can_bypass: "always"`). In plain terms: the repo owner can always merge past every rule above, admin-bypass included. This is the same solo-maintainer reality as the reviewer count — recorded, not hidden.
- **Merge method:** squash-only (`allowed_merge_methods: ["squash"]`), matching `CONTRIBUTING.md`'s documented flow.

Regenerate this artifact (read-only, no write scope needed) whenever the ruleset changes: `gh api repos/ChelseaKR/family-greenhouse/rulesets/17592136 > /tmp/ruleset.json` and reformat into `docs/branch-ruleset.json`'s `_meta`-wrapped shape.
