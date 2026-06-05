variable "aws_region" {
  description = "AWS region for resources"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name (staging, production)"
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Environment must be staging or production."
  }
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "family-greenhouse"
}

variable "domain_name" {
  description = "Domain name for the application (optional)"
  type        = string
  default     = ""
}

variable "alert_email" {
  description = "Email address for CloudWatch alerts"
  type        = string
  default     = ""
}

variable "monthly_budget_usd" {
  description = "Monthly AWS cost budget in USD; breaching 80% actual / 100% forecast emails alert_email."
  type        = string
  default     = "50"
}

variable "email_from_address" {
  description = "Friendly From header for Cognito mail (signup confirmations, password resets). E.g. 'Family Greenhouse <hello@familygreenhouse.net>'. Required when domain_name is set."
  type        = string
  default     = ""
}

variable "email_reply_to" {
  description = "Reply-To header for Cognito mail. Defaults to email_from_address when blank."
  type        = string
  default     = ""
}

variable "dmarc_rua_email" {
  description = "Mailbox to receive DMARC aggregate reports. Defaults to dmarc@<domain>."
  type        = string
  default     = ""
}

variable "github_org" {
  description = "GitHub org/user for OIDC deploy role binding. Set together with github_repo to provision the CI/CD role; leave blank to skip."
  type        = string
  default     = ""
}

variable "github_repo" {
  description = "GitHub repo name for OIDC deploy role binding (e.g. 'family-greenhouse'). Skip CI/CD provisioning if blank."
  type        = string
  default     = ""
}

# --- External integrations referenced from the api module ---
#
# Pattern: each external service (Perenual, Stripe, Sentry, etc.) is held
# in AWS Secrets Manager. Terraform only carries the SECRET NAME, never the
# value — so a leak of state files doesn't leak the credential. Lambda
# fetches the value at cold start (see backend/src/services/perenual.ts).

variable "perenual_api_key_secret_id" {
  description = "Secrets Manager secret name holding the Perenual API key (e.g. 'family-greenhouse/perenual-api-key'). Leave blank to disable Perenual integration."
  type        = string
  default     = ""
}

variable "perenual_daily_budget" {
  description = "Max Perenual API calls per day. Blank lets the code default (80) apply."
  type        = string
  default     = ""
}

# OpenWeather powers the climate/weather features. Without the key the weather
# service short-circuits to null and those features silently disable in prod.
variable "openweather_api_key" {
  description = "OpenWeather API key. Blank disables the climate/weather features."
  type        = string
  default     = ""
  sensitive   = true
}

variable "openweather_daily_budget" {
  description = "Max OpenWeather API calls per day. Blank lets the code default (800) apply."
  type        = string
  default     = ""
}

variable "bedrock_embed_model_id" {
  description = "Bedrock embedding model ID for the chat RAG corpus. Blank lets the code default (amazon.titan-embed-text-v2:0) apply."
  type        = string
  default     = ""
}
