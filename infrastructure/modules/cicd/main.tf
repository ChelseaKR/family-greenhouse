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
# The role is intentionally broad (AdministratorAccess via attached policy)
# because the deploy needs to manage IAM, Lambda, API Gateway, DynamoDB,
# Cognito, S3, CloudFront, Route 53, SES, ACM, WAFv2, EventBridge, and
# CloudWatch — i.e. almost every service in the project. Scope it down once
# the resource set stabilizes; the trust policy is what actually prevents
# misuse, not the permission scope.

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

# Broad attach until we scope to least-privilege. The trust policy is the
# actual safety: only the configured repo + refs can ever obtain creds.
resource "aws_iam_role_policy_attachment" "deploy_admin" {
  role       = aws_iam_role.github_deploy.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}
