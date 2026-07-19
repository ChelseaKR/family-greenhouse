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
  description = "Email/organizational domain. Also used as the legacy application domain when application_domain is blank."
  type        = string
  default     = ""
}

variable "application_domain" {
  description = "User-facing application hostname. May be a subdomain; defaults to domain_name for backward compatibility."
  type        = string
  default     = ""
}

variable "hosted_zone_name" {
  description = "Route 53 public hosted-zone name containing application_domain. Defaults to domain_name."
  type        = string
  default     = ""
}

variable "application_domain_include_www" {
  description = "Create a www alias and certificate SAN. Usually false for an application subdomain."
  type        = bool
  default     = true
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
# Pattern: static credentials are held in SSM SecureString parameters.
# Terraform only carries the parameter name, never the value, so a leak of
# state files doesn't leak the credential. Lambda fetches the value at cold
# start (see backend/src/services/perenual.ts).

variable "perenual_api_key_parameter_name" {
  description = "SSM SecureString parameter name holding the Perenual API key (e.g. '/family-greenhouse/perenual-api-key'). Leave blank to disable Perenual integration."
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

variable "chat_enabled" {
  description = "Incident kill switch for new chat turns. Use '0' to return 503 before any model or persistence work."
  type        = string
  default     = "1"
  validation {
    condition     = contains(["0", "1"], var.chat_enabled)
    error_message = "chat_enabled must be '0' or '1'."
  }
}

variable "sprout_integration_enabled" {
  description = "Set to '1' to route plant-care chat through the first-party Sprout service."
  type        = string
  default     = ""
  validation {
    condition     = contains(["", "1"], var.sprout_integration_enabled)
    error_message = "sprout_integration_enabled must be blank or '1'."
  }
}

variable "sprout_api_url" {
  description = "Base URL of the hosted Sprout API."
  type        = string
  default     = ""
}

variable "sprout_integration_secret_id" {
  description = "Secrets Manager id containing the shared Sprout HMAC secret."
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

variable "sms_notifications_enabled" {
  description = "Set to '1' only after this region has SMS production access and an approved origination identity. Blank keeps paid SMS disabled."
  type        = string
  default     = ""

  validation {
    condition     = contains(["", "1"], var.sms_notifications_enabled)
    error_message = "sms_notifications_enabled must be blank or '1'."
  }
}

# --- Observability and optional analytics fan-out ---
variable "git_sha" {
  description = "Git SHA deployed by CI. Added to structured logs and optional Sentry releases."
  type        = string
  default     = ""
}

variable "sentry_dsn" {
  description = "Optional backend Sentry DSN. Blank keeps the first-party CloudWatch baseline only."
  type        = string
  default     = ""
  sensitive   = true
}

variable "sentry_traces_sample_rate" {
  description = "Optional backend Sentry trace sample rate, for example 0.1."
  type        = string
  default     = ""
}

variable "posthog_key" {
  description = "Optional PostHog project key for server-side conversion fan-out."
  type        = string
  default     = ""
  sensitive   = true
}

variable "posthog_host" {
  description = "Optional PostHog capture host."
  type        = string
  default     = "https://us.i.posthog.com"
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

variable "stripe_automatic_tax_enabled" {
  description = "Set to '1' only after Stripe Tax registrations and product tax codes are configured."
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
