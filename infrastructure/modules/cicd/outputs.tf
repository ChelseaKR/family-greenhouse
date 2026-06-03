output "deploy_role_arn" {
  description = "ARN of the IAM role GitHub Actions assumes via OIDC. Set this as the `AWS_PRODUCTION_ROLE_ARN` repo secret."
  value       = aws_iam_role.github_deploy.arn
}

output "oidc_provider_arn" {
  description = "ARN of the GitHub OIDC provider in IAM (one per AWS account)."
  value       = aws_iam_openid_connect_provider.github.arn
}
