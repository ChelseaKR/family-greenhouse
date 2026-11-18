terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      configuration_aliases = [aws.iam]
    }
  }
}

# GitHub Actions OIDC trust for AWS — replaces long-lived AWS access keys
# in CI with short-lived assumed-role credentials.
#
# What is here (ADR 0049):
#   1. The OIDC provider (one per AWS account, AWS-side handle for GitHub's
#      JWT issuer).
#   2. Three roles, each trusted only from named GitHub environments of this
#      repository. No role trusts a branch or a tag.
#        deploy       terraform apply. The only role with IAM writes.
#                     Trusted from the `production` environment, whose
#                     required reviewer is the release's approval.
#        release      everything a release does after Terraform: Lambda code,
#                     the frontend bucket, CloudFront, the smoke test's
#                     fixtures, the rollback. No IAM writes.
#        alert-relay  two read-only calls for the scheduled alarm relay.
#   3. A permissions boundary for every other role in the project.
#
# The trust policy controls WHO can assume; the permission policy bounds the
# blast radius if assumption is ever compromised.
#
# THIS MODULE IS APPLIED BY AN ADMIN, NOT BY CD. The deploy role may not change
# any identity declared here, itself included (DenyChangesToCiIdentities
# below), so a change to this file reaches AWS only through
# `terraform apply -target='module.cicd'` from an admin session. The production
# workflow refuses to apply a plan that would change this module, before
# anything is touched. docs/cicd-setup.md has the steps.

# Account id for pinning IAM resource ARNs to THIS account instead of `*`
# (any-account). A wildcard account in an IAM resource ARN is broader than
# the role ever needs — every project role/policy it manages lives here.
data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  iam_prefix = "arn:aws:iam::${local.account_id}"

  # Names are fixed so ARNs can be written before the resources exist, and so
  # the staging stack (a different state) can name the boundary too.
  deploy_role_name      = "${var.project_name}-github-deploy"
  release_role_name     = "${var.project_name}-github-release"
  alert_relay_role_name = "${var.project_name}-github-alert-relay"
  boundary_policy_name  = "${var.project_name}-permissions-boundary"

  deploy_role_arn      = "${local.iam_prefix}:role/${local.deploy_role_name}"
  release_role_arn     = "${local.iam_prefix}:role/${local.release_role_name}"
  alert_relay_role_arn = "${local.iam_prefix}:role/${local.alert_relay_role_name}"

  deploy_policy_arn      = "${local.iam_prefix}:policy/${local.deploy_role_name}"
  release_policy_arn     = "${local.iam_prefix}:policy/${local.release_role_name}"
  alert_relay_policy_arn = "${local.iam_prefix}:policy/${local.alert_relay_role_name}"
  boundary_policy_arn    = "${local.iam_prefix}:policy/${local.boundary_policy_name}"

  oidc_provider_arn = "${local.iam_prefix}:oidc-provider/token.actions.githubusercontent.com"

  # Every identity CD must not be able to change: the three roles, their
  # policies, the boundary and the OIDC provider.
  ci_identity_arns = [
    local.deploy_role_arn,
    local.release_role_arn,
    local.alert_relay_role_arn,
    local.deploy_policy_arn,
    local.release_policy_arn,
    local.alert_relay_policy_arn,
    local.boundary_policy_arn,
    local.oidc_provider_arn,
  ]

  # Every project role that is NOT one of the three above.
  project_role_arn = "${local.iam_prefix}:role/${var.project_name}-*"

  # The `sub` claim of a job that declares a GitHub environment. The format is
  # documented at
  # https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect#example-subject-claims
  subject_prefix = "repo:${var.github_org}/${var.github_repo}"
  deploy_subjects = concat(
    [for name in var.deploy_environments : "${local.subject_prefix}:environment:${name}"],
    # Empty except during the one-time move to environment-only trust.
    [for ref in var.legacy_allowed_refs : "${local.subject_prefix}:${ref}"]
  )
  release_subjects     = [for name in var.release_environments : "${local.subject_prefix}:environment:${name}"]
  alert_relay_subjects = [for name in var.alert_relay_environments : "${local.subject_prefix}:environment:${name}"]

  # Full access WITHIN each service the stack uses ("service:*", Resource
  # "*"). The goal is removing blast radius to unrelated services (EC2, RDS,
  # org/account management, other workloads), not perfect least-privilege.
  # Per-service notes:
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
  #   kms           - the customer-managed key modules/email creates for SES
  #                   event delivery. `alias/aws/sns` is AWS-managed and its
  #                   key policy cannot be edited, so SES needs a CMK — and
  #                   creating one needs kms:CreateKey AND kms:TagResource,
  #                   since a tagged CreateKey is authorized against both.
  #   route53       - DNS records, health checks
  #   acm           - CloudFront cert create/validate (write needed: TF manages it)
  #   xray          - tracing config reads
  #   ce/budgets    - cost anomaly monitor + monthly budget (TF manages both,
  #                   so write — not just read — is required)
  stack_service_actions = [
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
    "kms:*",
    "route53:*",
    "acm:*",
    "xray:*",
    "ce:*",
    "budgets:*",
  ]

  # The statements the deploy role and the release role share.
  shared_statements = [
    {
      # Everything the stack manages via terraform apply + the app-deploy
      # steps. See stack_service_actions above.
      Sid      = "StackServices"
      Effect   = "Allow"
      Action   = local.stack_service_actions
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
      # Terraform reads the encrypted inbound-forward destination while
      # deploying the mail Lambda. Pin access to this project's prefix.
      Sid    = "ParametersRead"
      Effect = "Allow"
      Action = [
        "ssm:GetParameter",
      ]
      Resource = [
        "arn:aws:ssm:*:${local.account_id}:parameter/${var.project_name}/*",
      ]
    },
  ]
}

resource "aws_iam_openid_connect_provider" "github" {
  provider = aws.iam

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

# ============================================================================
# Roles. Each is assumable only by a job of this repository that declares one
# of the role's GitHub environments. A job on a branch or a tag with no
# environment gets a `sub` that names the ref, and no role trusts one.
# ============================================================================

resource "aws_iam_role" "github_deploy" {
  provider = aws.iam

  name = local.deploy_role_name

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
          # The `production` environment only: the environment whose required
          # reviewer is the release's approval. A fork, a pull request, a
          # feature branch, `main` and a tag all fail this.
          StringLike = {
            "token.actions.githubusercontent.com:sub" = local.deploy_subjects
          }
        }
      }
    ]
  })

  tags = {
    Name = local.deploy_role_name
  }
}

resource "aws_iam_role" "github_release" {
  provider = aws.iam

  name = local.release_role_name

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
          # Environments with no reviewer, so the jobs after the approved
          # Terraform job, and the rollback, run without a second pause.
          # This role has no IAM writes for that reason.
          StringLike = {
            "token.actions.githubusercontent.com:sub" = local.release_subjects
          }
        }
      }
    ]
  })

  tags = {
    Name = local.release_role_name
  }
}

resource "aws_iam_role" "github_alert_relay" {
  provider = aws.iam

  name = local.alert_relay_role_name

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
          StringLike = {
            "token.actions.githubusercontent.com:sub" = local.alert_relay_subjects
          }
        }
      }
    ]
  })

  tags = {
    Name = local.alert_relay_role_name
  }
}

# ============================================================================
# !! DEPLOY PERMISSIONS — READ BEFORE THE NEXT RELEASE !!
#
# A customer-managed policy scoped to the services this stack actually
# manages. If a CD run fails with AccessDenied, add the missing action(s) HERE
# and apply this module from an admin session. Do not attach
# AdministratorAccess to the role.
#
# IAM is the exception to "full access within each service": writes are
# restricted to project-prefixed roles/policies, because unrestricted iam:* is
# equivalent to admin, and the Deny statements below then take away every way
# of using even that to become something wider.
# ============================================================================
resource "aws_iam_policy" "deploy" {
  provider = aws.iam

  name = local.deploy_role_name
  # Unchanged on purpose. IAM cannot edit a policy's description, so a new
  # one makes Terraform delete this policy and create another, and for that
  # moment the deploy role would hold nothing. The statements below are what
  # changed; they become a new version of the same policy.
  description = "Scoped deploy permissions for the GitHub Actions CD role: full access within the services this stack manages, IAM limited to project-prefixed roles/policies."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(local.shared_statements, [
      {
        # IAM writes restricted to project-prefixed roles/policies (the
        # Lambda execution roles and their policies), which terraform
        # manages. Includes iam:PassRole on the project roles (needed to wire
        # a Lambda role into its function). Deliberately NOT iam:* on
        # Resource "*", which would be admin-equivalent.
        Sid    = "IamWriteProjectScoped"
        Effect = "Allow"
        Action = [
          "iam:*",
        ]
        Resource = [
          local.project_role_arn,
          "${local.iam_prefix}:policy/${var.project_name}-*",
        ]
      },
      {
        # The role cannot change who it is. IamWriteProjectScoped matches
        # this role's own ARN, its own policy, the other two CI roles, and
        # the boundary, because they all carry the project prefix. An
        # explicit Deny always wins over an Allow, and this one covers every
        # IAM action that is not a read, on exactly those identities and the
        # OIDC provider: no new policy version, no attached or inline policy,
        # no trust policy change, no boundary change, no delete-and-recreate.
        # A change to any of them is made by an admin (see the header).
        Sid       = "DenyChangesToCiIdentities"
        Effect    = "Deny"
        NotAction = ["iam:Get*", "iam:List*"]
        Resource  = local.ci_identity_arns
      },
      {
        # A role this role creates can do no more than the boundary allows.
        # Without it, a new project role could be given any policy and then
        # handed to a function.
        Sid      = "DenyRoleWithoutBoundary"
        Effect   = "Deny"
        Action   = ["iam:CreateRole"]
        Resource = "*"
        Condition = {
          ArnNotEquals = {
            "iam:PermissionsBoundary" = local.boundary_policy_arn
          }
        }
      },
      {
        # The boundary on a role can only be set to the project boundary...
        Sid      = "DenyOtherBoundary"
        Effect   = "Deny"
        Action   = ["iam:PutRolePermissionsBoundary"]
        Resource = "*"
        Condition = {
          ArnNotEquals = {
            "iam:PermissionsBoundary" = local.boundary_policy_arn
          }
        }
      },
      {
        # ...and never taken off.
        Sid      = "DenyBoundaryRemoval"
        Effect   = "Deny"
        Action   = ["iam:DeleteRolePermissionsBoundary"]
        Resource = "*"
      },
      {
        # Managed policies that may be attached to a project role: the
        # project's own, and the one AWS-managed policy the Lambda roles use.
        # Anything else (AdministratorAccess, for one) is refused.
        Sid      = "DenyOtherManagedPolicies"
        Effect   = "Deny"
        Action   = ["iam:AttachRolePolicy"]
        Resource = "*"
        Condition = {
          ArnNotLike = {
            "iam:PolicyARN" = [
              "${local.iam_prefix}:policy/${var.project_name}-*",
              "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess",
            ]
          }
        }
      },
      {
        # The CI policies themselves are not for the Lambda roles.
        Sid      = "DenyAttachingCiPolicies"
        Effect   = "Deny"
        Action   = ["iam:AttachRolePolicy"]
        Resource = "*"
        Condition = {
          ArnEquals = {
            "iam:PolicyARN" = [
              local.deploy_policy_arn,
              local.release_policy_arn,
            ]
          }
        }
      },
    ])
  })

  tags = {
    Name = "${local.deploy_role_name}-policy"
  }
}

resource "aws_iam_role_policy_attachment" "deploy" {
  role       = aws_iam_role.github_deploy.name
  policy_arn = aws_iam_policy.deploy.arn
}

# The release role: the deploy role's service access and IAM reads, and no IAM
# write of any kind. Terraform's targeted Cognito restore in the rollback job
# needs the reads; nothing a release does after `terraform apply` creates or
# changes a role or a policy.
resource "aws_iam_policy" "release" {
  provider = aws.iam

  name        = local.release_role_name
  description = "Permissions for the GitHub Actions release role: full access within the services this stack manages, IAM read-only."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(local.shared_statements, [
      {
        # Nothing above allows an IAM write. This says so out loud, so a
        # later edit to the shared statements cannot grant one by accident.
        Sid       = "DenyIamWrites"
        Effect    = "Deny"
        NotAction = ["iam:Get*", "iam:List*"]
        Resource  = "${local.iam_prefix}:*"
      },
    ])
  })

  tags = {
    Name = "${local.release_role_name}-policy"
  }
}

resource "aws_iam_role_policy_attachment" "release" {
  role       = aws_iam_role.github_release.name
  policy_arn = aws_iam_policy.release.arn
}

# The alert relay reads alarm state and the alerts topic's subscriber count
# (.github/workflows/alert-relay.yml). Nothing else.
resource "aws_iam_policy" "alert_relay" {
  provider = aws.iam

  name        = local.alert_relay_role_name
  description = "Read-only permissions for the scheduled alert relay: alarm state and the alerts topic's attributes."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # DescribeAlarms does not support resource-level permissions.
        Sid      = "ReadAlarmState"
        Effect   = "Allow"
        Action   = ["cloudwatch:DescribeAlarms"]
        Resource = "*"
      },
      {
        Sid      = "ReadAlertsTopic"
        Effect   = "Allow"
        Action   = ["sns:GetTopicAttributes"]
        Resource = "arn:aws:sns:*:${local.account_id}:${var.project_name}-alerts-*"
      },
    ]
  })

  tags = {
    Name = "${local.alert_relay_role_name}-policy"
  }
}

resource "aws_iam_role_policy_attachment" "alert_relay" {
  role       = aws_iam_role.github_alert_relay.name
  policy_arn = aws_iam_policy.alert_relay.arn
}

# ============================================================================
# Permissions boundary for every project role other than the three above
# (the Lambda execution roles, and any role a later change adds).
#
# A boundary grants nothing. It is the most a role can ever be allowed, however
# its own policies are written. The deploy role must set it on every role it
# creates and may never remove it, so no role CD can create or edit reaches
# past this list: no IAM, no other account service, nothing the application
# does not already use.
#
# The list is the services the Lambda roles' policies name, plus CloudWatch
# metrics and EventBridge. scripts/ci-least-privilege.test.mjs fails if a role
# policy in infrastructure/ names a service that is missing here. Adding one is a change to this file, applied by an admin, BEFORE the
# release that needs it.
# ============================================================================
resource "aws_iam_policy" "permissions_boundary" {
  provider = aws.iam

  name        = local.boundary_policy_name
  description = "Permissions boundary for project roles: the most any role created by the deploy pipeline can be allowed."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ApplicationServices"
        Effect = "Allow"
        Action = [
          "bedrock:*",
          "cloudwatch:*",
          "cognito-idp:*",
          "dynamodb:*",
          "events:*",
          "kms:*",
          "lambda:*",
          "logs:*",
          "s3:*",
          "secretsmanager:*",
          "ses:*",
          "sns:*",
          "sqs:*",
          "ssm:*",
          "xray:*",
        ]
        Resource = "*"
      },
    ]
  })

  tags = {
    Name = local.boundary_policy_name
  }
}
