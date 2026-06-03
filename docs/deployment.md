# Deployment

How to take the app from "passing CI" to "running on AWS at family-greenhouse.example.com." Pair this with [`production-checklist.md`](production-checklist.md) which lists the items that need provisioning.

## Topology

```
Route 53 ── CloudFront ┬─ S3 (static frontend bundle)
                       └─ API Gateway ── Lambda(s) ─┬─ DynamoDB (single table)
                                                    ├─ Cognito user pool
                                                    ├─ S3 (plant images bucket)
                                                    ├─ SES (transactional email)
                                                    ├─ SNS (transactional SMS)
                                                    └─ Stripe (billing webhooks come back inbound)

EventBridge cron ── runReminders Lambda ── SES + SNS + Web Push
```

Two distinct Terraform stacks, one per environment, in `infrastructure/environments/{staging,production}`. The shared modules live under `infrastructure/modules/`.

## Prerequisites

- AWS account with admin or scoped IAM (CloudFormation, IAM, Lambda, API Gateway, DDB, Cognito, SES, SNS, S3, CloudFront, Route 53)
- Domain name in Route 53 (or external NS pointed at AWS)
- Terraform 1.5+
- AWS CLI authenticated (`aws sso login` or static creds — OIDC for CI is best, see below)
- A Stripe account (live mode for prod, test mode for staging)
- A Sentry project (optional but recommended)
- An SES verified domain identity (out-of-sandbox)

## One-time bootstrap

Terraform needs a state backend before it can manage anything. Create it manually once per AWS account:

```bash
# An S3 bucket for state
aws s3api create-bucket --bucket family-greenhouse-tf-state --region us-east-1
aws s3api put-bucket-versioning --bucket family-greenhouse-tf-state \
  --versioning-configuration Status=Enabled

# A DynamoDB table for state locking
aws dynamodb create-table \
  --table-name family-greenhouse-tf-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

`infrastructure/backend.tf` already references these names; if you rename, update there too.

## Environment variables / secrets

The Lambdas read everything from environment variables that Terraform sets at deploy time. Here's the full set:

### Required (deployment fails without these)

| Variable               | Source             | Notes                                        |
| ---------------------- | ------------------ | -------------------------------------------- |
| `AWS_REGION`           | Terraform          | E.g. `us-east-1`                             |
| `STAGE`                | Terraform          | `staging` or `production`                    |
| `TABLE_NAME`           | Terraform output   | DDB table name                               |
| `COGNITO_USER_POOL_ID` | Terraform output   |                                              |
| `COGNITO_CLIENT_ID`    | Terraform output   |                                              |
| `IMAGES_BUCKET`        | Terraform output   |                                              |
| `ALLOWED_ORIGIN`       | Terraform variable | e.g. `https://family-greenhouse.example.com` |
| `FRONTEND_URL`         | Terraform variable | Used for invite + checkout return URLs       |

### Optional but recommended

| Variable                    | Effect                                      |
| --------------------------- | ------------------------------------------- |
| `SENTRY_DSN`                | Backend Sentry. No-op without it.           |
| `SENTRY_TRACES_SAMPLE_RATE` | Default `0.1`                               |
| `GIT_SHA`                   | Sentry release tag                          |
| `LOG_LEVEL`                 | `info` default; `debug` if you need verbose |

### Notification channels

| Variable                     | Channel                                                  |
| ---------------------------- | -------------------------------------------------------- |
| `WEB_PUSH_VAPID_PUBLIC_KEY`  | Browser push                                             |
| `WEB_PUSH_VAPID_PRIVATE_KEY` | Browser push                                             |
| `WEB_PUSH_VAPID_SUBJECT`     | mailto: address embedded in push messages                |
| `SES_FROM_EMAIL`             | Email reminders. Domain must be SES-verified.            |
| `SMS_NOTIFICATIONS_ENABLED`  | `1` to actually send SMS via SNS (paid). Off by default. |

### Plant identification (optional)

| Variable           | Effect                                |
| ------------------ | ------------------------------------- |
| `PLANT_ID_API_KEY` | Real Plant.id calls. Demo without it. |

### Billing

| Variable                     | Effect                                          |
| ---------------------------- | ----------------------------------------------- |
| `STRIPE_SECRET_KEY`          | Stripe API key (`sk_live_...` or `sk_test_...`) |
| `STRIPE_WEBHOOK_SECRET`      | Set on the webhook handler Lambda only          |
| `STRIPE_PRICE_ID_GARDEN`     | Price ID for the $4.99 plan                     |
| `STRIPE_PRICE_ID_GREENHOUSE` | Price ID for the $9.99 plan                     |

Use AWS Secrets Manager or SSM Parameter Store for any of these that look like secrets — Terraform pulls them in via `data` blocks rather than hardcoding.

## Frontend build-time variables

`Vite` reads `VITE_*` env vars at build time. CI sets these in the GitHub Actions workflow before running `npm --workspace frontend run build`:

```
VITE_API_URL=https://api.family-greenhouse.example.com
VITE_VAPID_PUBLIC_KEY=BPp7...   # same value as backend WEB_PUSH_VAPID_PUBLIC_KEY
VITE_SENTRY_DSN=https://...@sentry.io/...
VITE_GIT_SHA=$GITHUB_SHA
```

After build, sync `frontend/dist/` to the static S3 bucket and invalidate CloudFront:

```bash
aws s3 sync frontend/dist/ s3://family-greenhouse-frontend-prod/ --delete
aws cloudfront create-invalidation --distribution-id E... --paths '/*'
```

The CD workflows in `.github/workflows/` do this for you.

## Cognito user pool setup

Terraform creates the user pool, but the _attribute schema_ matters and is hard to migrate after the fact. Make sure the pool has these custom attributes set as **Mutable**, **String**:

- `custom:household_id`
- `custom:household_role`

The Lambda role needs the IAM permission `cognito-idp:AdminUpdateUserAttributes` on the user pool ARN; without it, every household creation will fail at the Cognito write step.

For SES email sending in confirmation emails, point the user pool's email config at SES (not Cognito's default service) — the default has a 50/day cap.

## DynamoDB

A single table named whatever `TABLE_NAME` resolves to (e.g. `FamilyGreenhouse-prod`). Keys:

- `PK` (String), `SK` (String) — base table
- GSI1: `GSI1PK` (String), `GSI1SK` (String)
- GSI2: `GSI2PK` (String), `GSI2SK` (String)
- TTL attribute: `ttl` (Number)
- PITR: enabled
- On-demand billing for variable load

See [`architecture.md`](architecture.md) for the access-pattern map.

## API Gateway

REST API with a Cognito user-pool authorizer attached to every protected route. Exceptions (no auth):

- `POST /auth/*` (everything in the auth flow)
- `GET /billing/plans`
- `POST /billing/webhook` (Stripe-signature verified instead)

The webhook route needs to be configured for **raw body** so Stripe's signature check passes — API Gateway can be set to pass through binary, or you preserve `event.body` as a string and parse it yourself. The handler in `handlers/billing/handler.ts` does the latter.

## CI/CD

Two workflows in `.github/workflows/`:

- `ci.yml` — runs on every PR + push to `main`: lint, typecheck, test, build
- `cd-staging.yml` — pushes to `main` deploy to staging
- `cd-production.yml` — version tag (`v*`) or manual dispatch deploys to production

Use OIDC federated identity from GitHub to AWS instead of static keys:

```yaml
permissions:
  id-token: write
  contents: read

- uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::123456789012:role/github-deploy-prod
    aws-region: us-east-1
```

Configure the IAM role with a trust policy bound to your repo + branch.

## Deploy steps (high level)

```bash
cd infrastructure/environments/staging
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

After Terraform completes, build + deploy the application bundles. CI does this automatically:

```bash
# Backend bundle (esbuild → /backend/dist/)
npm --workspace backend run build

# Frontend bundle (vite → /frontend/dist/)
npm --workspace frontend run build

# Push backend artifacts: handled by Terraform `lambda_function.filename` referring to dist/
# Push frontend artifacts: aws s3 sync as shown above
```

## Promotion

Staging → production uses an approval gate in `cd-production.yml`. Tag a release:

```bash
git tag v1.2.3
git push origin v1.2.3
```

The workflow opens a deploy request that an admin approves before applying.

## Rolling back

For Lambda, every deploy publishes a new version. The Terraform `aws_lambda_alias` resource points the live alias at the new version; rolling back means pointing it back at the previous version's alias.

For DynamoDB, PITR gives 35-day recovery. Restoring is a destructive operation against the live table — coordinate downtime first.

For frontend, S3 versioning + CloudFront invalidation. Roll back to a previous build's hash directory if you keep them around (recommend: deploy to `s3://bucket/builds/{sha}/`, point the CloudFront origin at `latest/`, swap with a copy + invalidate).

## Health checks

After every deploy, run the smoke test:

```bash
curl -fsSL https://api.family-greenhouse.example.com/health
# {"status":"ok"}
```

CI runs Playwright e2e against staging on every staging deploy. There is no equivalent against production by design — we don't want test users polluting the real database.

## Costs roughly

For ~100 households, ~10k plants, ~50k reminders/month:

- Lambda + API Gateway: ~$1/mo
- DynamoDB on-demand: ~$2/mo
- S3 + CloudFront: ~$3/mo (mostly bandwidth)
- Cognito: free up to 50k MAUs
- SES: ~$0.10/1000 emails
- SNS SMS: ~$0.0075/SMS in US (this is the expensive one — most cost will come here if SMS reminders take off)

Sentry, Stripe, and Plant.id costs are vendor-dependent.
