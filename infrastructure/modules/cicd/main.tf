# GitHub Actions OIDC trust for AWS — replaces long-lived AWS access keys
# in CI with short-lived assumed-role credentials.
#
# Two resources:
#   1. The OIDC provider (one per AWS account, AWS-side handle for GitHub's
#      JWT issuer).
#   2. The deploy role with a trust policy that ties role assumption to a
#      specific repo + ref pattern + GitHub environment (so a fork or an
#      unrelated branch can't assume it).
#
# The role carries a customer-managed policy (aws_iam_policy.deploy, below)
# scoped to the services this stack manages — full access within those
# services, IAM writes limited to project-prefixed roles/policies. The trust
# policy controls WHO can assume; the permission policy bounds the blast
# radius if assumption is ever compromised.

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  thumbprint_list = [
    # GitHub's OIDC certificate thumbprints. AWS verifies against these on
    # every assume-role call; mismatch → STS denies. The two listed below
    # cover the staggered cert rollover GitHub does ~yearly.
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]

  tags = {
    Name = "${var.project_name}-github-oidc"
  }
}

resource "aws_iam_role" "github_deploy" {
  name = "${var.project_name}-github-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.github.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          # Bind to repo + refs + (optionally) deploy environment so a feature
          # branch, fork, or pull_request workflow can't assume the role.
          # The `sub` claim format is documented at
          # https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect#example-subject-claims
          StringLike = {
            "token.actions.githubusercontent.com:sub" = concat(
              [
                for ref in var.allowed_refs :
                "repo:${var.github_org}/${var.github_repo}:${ref}"
              ],
              [
                "repo:${var.github_org}/${var.github_repo}:environment:${var.environment_name}"
              ]
            )
          }
        }
      }
    ]
  })

  tags = {
    Name = "${var.project_name}-github-deploy"
  }
}

# ============================================================================
# !! DEPLOY PERMISSIONS — READ BEFORE THE NEXT RELEASE !!
#
# This replaced AdministratorAccess with a customer-managed policy scoped to
# the services this stack actually manages. WATCH THE FIRST CD RUN after this
# lands: the deploy role runs a full `terraform apply` plus `aws s3 sync`,
# `aws lambda update-function-code`, CloudFront invalidation, and Cognito
# admin calls in the smoke tests. If the run fails with AccessDenied,
# temporarily re-attach AdministratorAccess
# (`aws iam attach-role-policy --role-name family-greenhouse-github-deploy \
#   --policy-arn arn:aws:iam::aws:policy/AdministratorAccess`),
# re-run the deploy, then add the missing action(s) HERE and detach admin
# again. Do not leave admin attached.
#
# Scoping philosophy (v1): full access WITHIN each service the stack uses
# ("service:*", Resource "*") — the goal is removing blast radius to
# unrelated services (EC2, RDS, org/account management, other workloads),
# not perfect least-privilege. IAM is the exception: writes are restricted
# to project-prefixed roles/policies + the GitHub OIDC provider, because
# unrestricted iam:* is equivalent to admin.
# ============================================================================
resource "aws_iam_policy" "deploy" {
  name        = "${var.project_name}-github-deploy"
  description = "Scoped deploy permissions for the GitHub Actions CD role: full access within the services this stack manages, IAM limited to project-prefixed roles/policies."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Everything the stack manages via terraform apply + the app-deploy
        # steps. Per-service notes:
        #   s3            - frontend/images buckets, tfstate bucket, frontend sync,
        #                   lambda-version artifacts
        #   cloudfront    - distribution, OAC, policies, invalidations
        #   lambda        - function config + update-function-code
        #   apigateway    - API Gateway v2 uses the `apigateway:` action prefix
        #   dynamodb      - app table + terraform state lock table
        #   cognito-idp   - user pool/client + smoke-test AdminCreate/DeleteUser
        #   cloudwatch/logs/events - dashboards, alarms, log groups, EventBridge rule
        #   sns/sqs       - alerts topic, Lambda DLQ
        #   ses           - domain identity, DKIM, identity policy (modules/email)
        #   route53       - DNS records, health checks
        #   acm           - CloudFront cert create/validate (write needed: TF manages it)
        #   xray          - tracing config reads
        #   ce/budgets    - cost anomaly monitor + monthly budget (TF manages both,
        #                   so write — not just read — is required)
        Sid    = "StackServices"
        Effect = "Allow"
        Action = [
          "s3:*",
          "cloudfront:*",
          "lambda:*",
          "apigateway:*",
          "dynamodb:*",
          "cognito-idp:*",
          "cloudwatch:*",
          "logs:*",
          "events:*",
          "sns:*",
          "sqs:*",
          "ses:*",
          "route53:*",
          "acm:*",
          "xray:*",
          "ce:*",
          "budgets:*",
        ]
        Resource = "*"
      },
      {
        # Terraform reads back lots of IAM state (roles, policies, the OIDC
        # provider) during plan/refresh. Read-only on *.
        Sid    = "IamRead"
        Effect = "Allow"
        Action = [
          "iam:Get*",
          "iam:List*",
        ]
        Resource = "*"
      },
      {
        # IAM writes restricted to project-prefixed roles/policies (the
        # lambda execution role, this deploy role, this policy) and the
        # GitHub OIDC provider — all of which terraform manages. Includes
        # iam:PassRole on the project roles (needed to wire the lambda role
        # into functions). Deliberately NOT iam:* on Resource "*", which
        # would be admin-equivalent.
        Sid    = "IamWriteProjectScoped"
        Effect = "Allow"
        Action = [
          "iam:*",
        ]
        Resource = [
          "arn:aws:iam::*:role/${var.project_name}-*",
          "arn:aws:iam::*:policy/${var.project_name}-*",
          "arn:aws:iam::*:oidc-provider/token.actions.githubusercontent.com",
        ]
      },
      {
        # Lambdas fetch secrets at runtime; the deploy role itself only ever
        # needs to read them (e.g. data sources / debugging), never write.
        Sid    = "SecretsRead"
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
          "secretsmanager:ListSecrets",
        ]
        Resource = "*"
      },
    ]
  })

  tags = {
    Name = "${var.project_name}-github-deploy-policy"
  }
}

resource "aws_iam_role_policy_attachment" "deploy" {
  role       = aws_iam_role.github_deploy.name
  policy_arn = aws_iam_policy.deploy.arn
}
