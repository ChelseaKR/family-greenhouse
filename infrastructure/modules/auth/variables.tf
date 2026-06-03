variable "environment" {
  description = "Environment name"
  type        = string
}

variable "project_name" {
  description = "Project name"
  type        = string
}

variable "email_identity_arn" {
  description = "SES domain identity ARN. When set, Cognito sends from SES (DEVELOPER mode) instead of the default service mailbox."
  type        = string
  default     = ""
}

variable "email_from_address" {
  description = "Friendly From header for Cognito-sent mail, e.g. 'Family Greenhouse <hello@familygreenhouse.net>'."
  type        = string
  default     = ""
}

variable "email_reply_to" {
  description = "Reply-To header for Cognito-sent mail. Defaults to the From address."
  type        = string
  default     = ""
}
