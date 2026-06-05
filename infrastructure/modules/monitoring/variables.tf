variable "environment" {
  description = "Environment name"
  type        = string
}

variable "project_name" {
  description = "Project name"
  type        = string
}

variable "api_gateway_name" {
  description = "API Gateway name"
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
