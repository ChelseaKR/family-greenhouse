output "deploy_role_arn" {
  description = "ARN of the IAM role the Terraform jobs assume via OIDC. Set this as the `AWS_PRODUCTION_ROLE_ARN` repo secret."
  value       = aws_iam_role.github_deploy.arn
}

output "release_role_arn" {
  description = "ARN of the IAM role the release jobs assume via OIDC (no IAM writes). Set this as the `AWS_RELEASE_ROLE_ARN` repo secret."
  value       = aws_iam_role.github_release.arn
}

output "alert_relay_role_arn" {
  description = "ARN of the read-only IAM role the alert relay assumes via OIDC. Set this as the `AWS_ALERT_RELAY_ROLE_ARN` repo secret."
  value       = aws_iam_role.github_alert_relay.arn
}

output "permissions_boundary_arn" {
  description = "ARN of the permissions boundary every other project role must carry."
  value       = aws_iam_policy.permissions_boundary.arn
}

output "oidc_provider_arn" {
  description = "ARN of the GitHub OIDC provider in IAM (one per AWS account)."
  value       = aws_iam_openid_connect_provider.github.arn
}
