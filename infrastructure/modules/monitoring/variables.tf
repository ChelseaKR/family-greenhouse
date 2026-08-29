variable "environment" {
  description = "Environment name"
  type        = string
}

variable "project_name" {
  description = "Project name"
  type        = string
}

variable "enable_alarms" {
  description = "Create the CloudWatch metric alarms. Each standard alarm bills ~$0.10/mo, so a stack whose alerts topic has no subscribers (see the check block in main.tf) is paying for notifications nobody receives. Production keeps this true; disable only for stacks nobody is on call for."
  type        = bool
  default     = true
}

variable "enable_dashboard" {
  description = "Create the CloudWatch dashboard. The first three dashboards per account are free, so a second stack's dashboard bills ~$3/mo. Production keeps this true."
  type        = bool
  default     = true
}

variable "enable_cost_anomaly_monitor" {
  description = "Create the account-global Cost Explorer service anomaly monitor. Enable in only one stack per AWS account."
  type        = bool
  default     = true
}

variable "api_gateway_id" {
  description = "HTTP API Gateway ID used by CloudWatch's ApiId dimension"
  type        = string
}

variable "api_access_log_group_name" {
  description = "CloudWatch log group containing structured HTTP API access logs"
  type        = string
}

variable "api_lambda_log_group_name" {
  description = "CloudWatch log group for the API/telemetry Lambda"
  type        = string
}

variable "auth_lambda_log_group_name" {
  description = "CloudWatch log group for the authentication Lambda"
  type        = string
}

variable "reminders_lambda_log_group_name" {
  description = "CloudWatch log group of the hourly reminder scan. Metric filters read its run-summary line."
  type        = string
  default     = ""
}

variable "digests_lambda_log_group_name" {
  description = "CloudWatch log group of the weekly digest / yearly recap function. Metric filters read its run-summary lines."
  type        = string
  default     = ""
}

variable "ses_configuration_set_name" {
  description = "SES configuration set publishing Reputation.BounceRate/ComplaintRate. Empty (no email module) skips the SES alarms."
  type        = string
  default     = ""
}

variable "billing_lambda_log_group_name" {
  description = "CloudWatch log group for the billing Lambda, whose Stripe webhook receiver emits the no-grant log lines this module alarms on"
  type        = string
}

variable "lambda_function_names" {
  description = "List of Lambda function names"
  type        = list(string)
}

variable "alert_email" {
  description = "Email address for alerts"
  type        = string
  default     = ""
}

variable "alert_sms_number" {
  description = "E.164 phone number (e.g. +15551234567) to SMS-page on alerts. Empty = no SMS paging. Requires the account to be out of the SNS SMS sandbox."
  type        = string
  default     = ""
}

variable "dynamodb_table_name" {
  description = "DynamoDB table name for throttle metrics"
  type        = string
  default     = ""
}

variable "monthly_budget_usd" {
  description = "Monthly AWS cost budget in USD; breaching 80% actual / 100% forecast emails alert_email."
  type        = string
  default     = "50"
}

variable "lambda_dlq_name" {
  description = "Name of the Lambda/EventBridge dead-letter queue to alarm on. Empty disables the DLQ alarm."
  type        = string
  default     = ""
}

variable "email_forwarder_dlq_name" {
  description = "SQS queue name of the inbound-mail forwarder DLQ. Empty (no domain / email module not provisioned) disables the alarm."
  type        = string
  default     = ""
}

variable "email_forwarder_log_group_name" {
  description = "CloudWatch log group of the inbound-mail forwarder. Empty (no domain / email module not provisioned) disables the unverified-scan filter and alarm."
  type        = string
  default     = ""
}
