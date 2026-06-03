output "identity_arn" {
  description = "SES domain identity ARN — feed into Cognito email_configuration.source_arn"
  value       = aws_ses_domain_identity.main.arn
}

output "from_email_default" {
  description = "Sensible default sender address. Pin a friendly name in the caller."
  value       = "hello@${var.domain_name}"
}
