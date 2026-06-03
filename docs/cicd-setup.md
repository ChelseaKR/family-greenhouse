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
# -> arn:aws:iam::014248889144:role/family-greenhouse-github-deploy
```

## Step 3 — Configure GitHub repo secrets + vars

In **Settings → Secrets and variables → Actions**:

### Repository **secrets**

| Name                      | Value                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| `AWS_PRODUCTION_ROLE_ARN` | the `terraform output` value from step 2                               |
| `AWS_DEPLOY_ROLE_ARN`     | same value (used by `cd-staging.yml` until you split the staging role) |

### Repository **variables**

| Name                              | Value                                                               |
| --------------------------------- | ------------------------------------------------------------------- |
| `PRODUCTION_API_URL`              | `https://ux8jg1lns0.execute-api.us-east-1.amazonaws.com/production` |
| `PRODUCTION_URL`                  | `https://familygreenhouse.net`                                      |
| `PRODUCTION_COGNITO_USER_POOL_ID` | `us-east-1_ByXmW6yOy`                                               |
| `PRODUCTION_COGNITO_CLIENT_ID`    | `700a0dcq5cl94f4hhllmc1ib9d`                                        |
| `STAGING_API_URL`                 | (defer until staging is provisioned)                                |
| `STAGING_URL`                     | (defer)                                                             |
| `STAGING_COGNITO_USER_POOL_ID`    | (defer)                                                             |
| `STAGING_COGNITO_CLIENT_ID`       | (defer)                                                             |

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
