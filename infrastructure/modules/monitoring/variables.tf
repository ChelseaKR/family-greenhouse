variable "environment" {
  description = "Environment name"
  type        = string
}

variable "project_name" {
  description = "Project name"
  type        = string
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

variable "api_endpoint" {
  description = "API Gateway base endpoint (https://host, no stage path) for the uptime health check. Empty disables the synthetic monitor."
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
