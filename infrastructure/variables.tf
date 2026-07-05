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

variable "alert_sms_number" {
  description = "E.164 phone number to SMS-page on alerts (e.g. +15551234567). Empty = no SMS paging."
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

# Plant.id identify monthly meter. "1" ENFORCES the per-household monthly cap;
# blank only tracks usage (beta default). Production sets "1" so the real
# per-call Plant.id credit can't be cost-amplified by concurrency.
variable "identify_metering_enabled" {
  description = "Set to '1' to enforce the Plant.id identify monthly meter. Blank only tracks usage without blocking."
  type        = string
  default     = ""
}

# --- Stripe ---
# Mirrors modules/api/variables.tf. These MUST be declared here too: Terraform
# only warns (and silently drops the value) on an undeclared variable passed
# via -var-file or TF_VAR_*, so without these, prod's price ids and the
# CI-injected secret key/webhook secret never reach the Lambdas even though
# terraform.tfvars and cd-production.yml both set them.
variable "stripe_secret_key" {
  description = "Stripe API secret key (sk_test_... or sk_live_...). Required for billing checkout. Prefer SSM/secret-ref over plaintext tfvar."
  type        = string
  default     = ""
  sensitive   = true
}

variable "stripe_webhook_secret" {
  description = "Stripe webhook signing secret. Required for /billing/webhook to verify signatures."
  type        = string
  default     = ""
  sensitive   = true
}

variable "stripe_price_id_garden" {
  description = "Stripe price ID for the Garden tier MONTHLY ($4.99/mo). Required for /billing/checkout monthly."
  type        = string
  default     = ""
}

variable "stripe_price_id_garden_annual" {
  description = "Stripe price ID for the Garden tier ANNUAL ($39.99/yr). Required for /billing/checkout with interval=year."
  type        = string
  default     = ""
}

variable "stripe_price_id_garden_lifetime" {
  description = "Stripe price ID for the Garden tier LIFETIME one-time payment ($149). Required for /billing/checkout with interval=lifetime."
  type        = string
  default     = ""
}

variable "stripe_price_id_greenhouse" {
  description = "Stripe price ID for the Greenhouse tier MONTHLY ($9.99/mo). Required for /billing/checkout monthly."
  type        = string
  default     = ""
}

variable "stripe_price_id_greenhouse_annual" {
  description = "Stripe price ID for the Greenhouse tier ANNUAL ($79.99/yr). Required for /billing/checkout with interval=year."
  type        = string
  default     = ""
}

# Manual confirmation gate: Stripe price ids look identical in test and live
# mode, so Terraform can't verify stripe_price_id_* actually match the mode of
# stripe_secret_key. This must be deliberately flipped to true (see the check
# block in main.tf, which warns on plan/apply if a live-looking secret key is
# paired with this still false).
variable "stripe_price_ids_are_live" {
  description = "Set true only after manually confirming every stripe_price_id_* was created in the SAME Stripe mode (test/live) as stripe_secret_key."
  type        = bool
  default     = false
}
