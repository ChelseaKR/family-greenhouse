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

output "forwarder_log_group_name" {
  description = "CloudWatch log group of the inbound-mail forwarder — feed into the monitoring module so a message refused for an unverified scan raises an alarm instead of only a log line."
  value       = aws_cloudwatch_log_group.forwarder.name
}

output "configuration_set_name" {
  description = "SES configuration set the backend attaches to every send — feed into the api module so SES_CONFIGURATION_SET reaches the Lambdas. Without it SES publishes no bounce/complaint events at all."
  value       = aws_sesv2_configuration_set.main.configuration_set_name
}

output "event_topic_arn" {
  description = "SNS topic carrying SES bounce/complaint/delivery events. The api module subscribes the emailEvents Lambda to it (the subscription lives there so this module never has to know a function ARN)."
  value       = aws_sns_topic.email_events.arn
}

output "mail_from_domain" {
  description = "Custom MAIL FROM subdomain. Its MX + SPF records must resolve before SES will use it; until then SES falls back to amazonses.com (behavior_on_mx_failure = UseDefaultValue)."
  value       = aws_ses_domain_mail_from.main.mail_from_domain
}

output "cognito_custom_message_lambda_arn" {
  description = "CustomMessage trigger rendering the branded forgot-password and admin-invite bodies — feed into the auth module's lambda_config."
  value       = aws_lambda_function.cognito_messages.arn
}

output "cognito_custom_message_function_name" {
  description = "Function name for the auth module's aws_lambda_permission (source_arn is the user pool, which lives there)."
  value       = aws_lambda_function.cognito_messages.function_name
}
