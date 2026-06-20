output "identity_arn" {
  description = "SES domain identity ARN — feed into Cognito email_configuration.source_arn"
  value       = aws_ses_domain_identity.main.arn
}

output "from_email_default" {
  description = "Sensible default sender address. Pin a friendly name in the caller."
  value       = "hello@${var.domain_name}"
}

output "forwarder_dlq_name" {
  description = "SQS queue name of the inbound-mail forwarder dead-letter queue — feed into the monitoring module's depth alarm."
  value       = aws_sqs_queue.forwarder_dlq.name
}
