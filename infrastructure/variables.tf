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

variable "public_registration_enabled" {
  description = "Permit Cognito self-signup. Keep false by default; reviewed environment tfvars must opt in explicitly."
  type        = bool
  default     = false
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

variable "enable_monitoring_alarms" {
  description = "Create the CloudWatch metric alarms (~$0.10/alarm/month). Defaults true so production is unaffected; staging sets it false because its alerts topic has no subscribers, so the alarms notified nobody."
  type        = bool
  default     = true
}

variable "enable_monitoring_dashboard" {
  description = "Create the CloudWatch dashboard (~$3/month beyond the account's first three). Defaults true so production is unaffected; staging sets it false."
  type        = bool
  default     = true
}

variable "enable_site_health_check" {
  description = "Create the Route 53 health check that fetches a real (non-`/`) site page every 30 seconds and alarms into the alerts SNS topic when it stops serving this app. ~$2.60/month. Defaults true: with it off, nothing in this stack can tell a total outage from a quiet hour, which is how a forty-minute frontend outage went unnoticed on 2026-09-04 (issue #464). Staging sets it false."
  type        = bool
  default     = true
}

variable "enable_api_health_check" {
  description = "Create the Route 53 health check that fetches GET /health every 30 seconds. ~$2.60/month in Route 53 fees plus ~$2-4/month of API Gateway, Lambda, DynamoDB and log cost from the ~1.3M extra requests it generates. Off by default: .github/workflows/uptime.yml already checks /health every 15 minutes for free. Turn it on to move API-outage detection to ~3 minutes and into the alerts topic."
  type        = bool
  default     = false
}

variable "enable_telemetry_delivery_alarm" {
  description = "Create the alarm that fires when the frontend error rail has not been able to deliver anything for two hours (issue #576). ~$0.10/month for the alarm; the two custom metrics behind it are created regardless and cost ~$0.60/month between them, so the signal as a whole is ~$0.80/month. Defaults true: without it, `FrontendErrors == 0` means either 'no browser errors' or 'no browser could tell us' and nothing distinguishes them. It reads a heartbeat sent every 15 minutes by .github/workflows/uptime.yml, which probes production — so staging sets it false, because an alarm watching for a heartbeat nobody sends is correct to page forever."
  type        = bool
  default     = true
}

variable "email_from_address" {
  description = "Friendly From header for Cognito mail (signup confirmations, password resets). E.g. 'Family Greenhouse <hello@familygreenhouse.net>'. Required when domain_name is set."
  type        = string
  default     = ""
}

variable "email_reply_to" {
  description = "Reply-To header for Cognito mail and for the app's own SES sends (reminders, digest, recap). Defaults to email_from_address when blank."
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

# Plant.id powers photo identification. Passed to Terraform only through a
# protected TF_VAR secret in deploy workflows; blank keeps the integration
# disabled and the API reports that honestly.
variable "plant_id_api_key" {
  description = "Plant.id API key. Blank disables real photo identification."
  type        = string
  default     = ""
  sensitive   = true
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
  validation {
    condition = (
      var.sprout_api_url == "" ||
      can(regex("^https://api\\.sprout\\.chelseakr\\.com/?$", var.sprout_api_url))
    )
    error_message = "sprout_api_url must be blank or https://api.sprout.chelseakr.com."
  }
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

# --- AI inference cost caps (per household per UTC calendar month) ---
#
# Strings, so "" can mean "use the code default" (same convention as
# perenual_daily_budget / chat_budget_*). With every one of these blank the
# Lambdas behave exactly as they did before the variables existed: a flat 200
# leaf-health checks for every tier and 250k input / 50k output chat tokens
# for every tier. Caps are per household and divide across its members
# (Greenhouse allows 50), so choose them per tier, not per person.
#
# Leaf-health (services/leafHealthBudget.ts). A blank per-tier value inherits
# the flat one; setting ANY per-tier value switches the handler to a plan
# lookup (one extra DynamoDB read per check — the same read identify already
# makes). "0" disables the cap for that tier.
variable "leaf_health_monthly_cap" {
  description = "Flat monthly leaf-health check cap per household, applied to every tier without a per-tier override. Blank = code default (200). '0' = unlimited."
  type        = string
  default     = ""

  validation {
    condition     = var.leaf_health_monthly_cap == "" || can(regex("^[0-9]+$", var.leaf_health_monthly_cap))
    error_message = "leaf_health_monthly_cap must be blank or a non-negative integer."
  }
}

variable "leaf_health_monthly_cap_seedling" {
  description = "Monthly leaf-health check cap for Seedling (free) households. Blank = inherit leaf_health_monthly_cap. '0' = unlimited."
  type        = string
  default     = ""

  validation {
    condition     = var.leaf_health_monthly_cap_seedling == "" || can(regex("^[0-9]+$", var.leaf_health_monthly_cap_seedling))
    error_message = "leaf_health_monthly_cap_seedling must be blank or a non-negative integer."
  }
}

variable "leaf_health_monthly_cap_garden" {
  description = "Monthly leaf-health check cap for Garden households. Blank = inherit leaf_health_monthly_cap. '0' = unlimited."
  type        = string
  default     = ""

  validation {
    condition     = var.leaf_health_monthly_cap_garden == "" || can(regex("^[0-9]+$", var.leaf_health_monthly_cap_garden))
    error_message = "leaf_health_monthly_cap_garden must be blank or a non-negative integer."
  }
}

variable "leaf_health_monthly_cap_greenhouse" {
  description = "Monthly leaf-health check cap for Greenhouse households. Blank = inherit leaf_health_monthly_cap. '0' = unlimited."
  type        = string
  default     = ""

  validation {
    condition     = var.leaf_health_monthly_cap_greenhouse == "" || can(regex("^[0-9]+$", var.leaf_health_monthly_cap_greenhouse))
    error_message = "leaf_health_monthly_cap_greenhouse must be blank or a non-negative integer."
  }
}

# Whether this environment is allowed to answer a leaf-health check with the
# canned demo assessment when Bedrock refuses it. FALSE by default, and that
# default is the point: an environment that is supposed to reach Bedrock must
# surface a credential or model-access regression as a 503 the api-5xx alarm
# can see, not as a fixture at HTTP 200 that reads like a real assessment of
# someone's plant. Set true only for a preview/dev environment whose Lambda
# role genuinely has no Bedrock access.
variable "leaf_health_demo" {
  description = "Allow the canned demo leaf-health assessment when Bedrock refuses this deployment. True ONLY for an environment with no Bedrock access."
  type        = bool
  default     = false
}

# Chat (services/chat/budget.ts). The flat pair has been declared in
# modules/api/variables.tf since the chat budget shipped, but never at this
# level and never passed through main.tf — so a tfvars value was silently
# dropped (an undeclared variable is only a warning) and the code default
# always ran. Declared here so the cap is settable per environment; blank
# keeps today's default. The per-tier pairs work like leaf-health's: a blank
# per-tier value inherits the flat one for that counter, and setting ANY
# per-tier value makes the guard tier-aware. The turn already reads the
# household's plan for its Garden-and-up gate, so tiering adds no read to a
# turn; GET /chat/budget gains one. NOTE: unlike the leaf-health caps, "0"
# here is NOT unlimited — the code reads it as a zero budget and 429s every
# turn — so the validation refuses it on all eight; to lift a cap, raise it.
variable "chat_budget_input_tokens" {
  description = "Per-household monthly chat input-token cap. Blank = code default (250000). Must be a positive integer when set; '0' is not 'unlimited'."
  type        = string
  default     = ""

  validation {
    condition     = var.chat_budget_input_tokens == "" || can(regex("^[1-9][0-9]*$", var.chat_budget_input_tokens))
    error_message = "chat_budget_input_tokens must be blank or a positive integer ('0' would block every chat turn)."
  }
}

variable "chat_budget_output_tokens" {
  description = "Per-household monthly chat output-token cap. Blank = code default (50000). Must be a positive integer when set; '0' is not 'unlimited'."
  type        = string
  default     = ""

  validation {
    condition     = var.chat_budget_output_tokens == "" || can(regex("^[1-9][0-9]*$", var.chat_budget_output_tokens))
    error_message = "chat_budget_output_tokens must be blank or a positive integer ('0' would block every chat turn)."
  }
}

variable "chat_budget_input_tokens_seedling" {
  description = "Monthly chat input-token cap for Seedling (free) households. Blank = inherit chat_budget_input_tokens. Must be a positive integer when set; '0' is not 'unlimited'."
  type        = string
  default     = ""

  validation {
    condition     = var.chat_budget_input_tokens_seedling == "" || can(regex("^[1-9][0-9]*$", var.chat_budget_input_tokens_seedling))
    error_message = "chat_budget_input_tokens_seedling must be blank or a positive integer ('0' would block every chat turn)."
  }
}

variable "chat_budget_output_tokens_seedling" {
  description = "Monthly chat output-token cap for Seedling (free) households. Blank = inherit chat_budget_output_tokens. Must be a positive integer when set; '0' is not 'unlimited'."
  type        = string
  default     = ""

  validation {
    condition     = var.chat_budget_output_tokens_seedling == "" || can(regex("^[1-9][0-9]*$", var.chat_budget_output_tokens_seedling))
    error_message = "chat_budget_output_tokens_seedling must be blank or a positive integer ('0' would block every chat turn)."
  }
}

variable "chat_budget_input_tokens_garden" {
  description = "Monthly chat input-token cap for Garden households. Blank = inherit chat_budget_input_tokens. Must be a positive integer when set; '0' is not 'unlimited'."
  type        = string
  default     = ""

  validation {
    condition     = var.chat_budget_input_tokens_garden == "" || can(regex("^[1-9][0-9]*$", var.chat_budget_input_tokens_garden))
    error_message = "chat_budget_input_tokens_garden must be blank or a positive integer ('0' would block every chat turn)."
  }
}

variable "chat_budget_output_tokens_garden" {
  description = "Monthly chat output-token cap for Garden households. Blank = inherit chat_budget_output_tokens. Must be a positive integer when set; '0' is not 'unlimited'."
  type        = string
  default     = ""

  validation {
    condition     = var.chat_budget_output_tokens_garden == "" || can(regex("^[1-9][0-9]*$", var.chat_budget_output_tokens_garden))
    error_message = "chat_budget_output_tokens_garden must be blank or a positive integer ('0' would block every chat turn)."
  }
}

variable "chat_budget_input_tokens_greenhouse" {
  description = "Monthly chat input-token cap for Greenhouse households. Blank = inherit chat_budget_input_tokens. Must be a positive integer when set; '0' is not 'unlimited'."
  type        = string
  default     = ""

  validation {
    condition     = var.chat_budget_input_tokens_greenhouse == "" || can(regex("^[1-9][0-9]*$", var.chat_budget_input_tokens_greenhouse))
    error_message = "chat_budget_input_tokens_greenhouse must be blank or a positive integer ('0' would block every chat turn)."
  }
}

variable "chat_budget_output_tokens_greenhouse" {
  description = "Monthly chat output-token cap for Greenhouse households. Blank = inherit chat_budget_output_tokens. Must be a positive integer when set; '0' is not 'unlimited'."
  type        = string
  default     = ""

  validation {
    condition     = var.chat_budget_output_tokens_greenhouse == "" || can(regex("^[1-9][0-9]*$", var.chat_budget_output_tokens_greenhouse))
    error_message = "chat_budget_output_tokens_greenhouse must be blank or a positive integer ('0' would block every chat turn)."
  }
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

variable "web_push_vapid_public_key" {
  description = "VAPID public key shared by the browser build and notification Lambdas. Blank disables background web push."
  type        = string
  default     = ""
}

variable "web_push_vapid_private_key" {
  description = "VAPID private key used only by notification Lambdas. Supply through a protected TF_VAR secret, never the frontend build."
  type        = string
  default     = ""
  sensitive   = true
}

variable "web_push_vapid_subject" {
  description = "VAPID contact URI, normally mailto:hello@example.com. Required when a key pair is configured."
  type        = string
  default     = ""

  validation {
    condition = (
      var.web_push_vapid_subject == "" ||
      startswith(var.web_push_vapid_subject, "mailto:") ||
      startswith(var.web_push_vapid_subject, "https://")
    )
    error_message = "web_push_vapid_subject must be blank or start with mailto: or https://."
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

variable "stripe_price_id_identify_top_up" {
  description = "Stripe ONE-TIME price ID for the identification top-up pack (20 identifications, $1.99; ADR 0019). Optional: blank means the pack is not for sale and POST /billing/top-up/checkout answers 400 TOP_UP_NOT_CONFIGURED. Never a fallback price."
  type        = string
  default     = ""
}

variable "stripe_automatic_tax_enabled" {
  description = "Set to '1' only after Stripe Tax registrations and product tax codes are configured."
  type        = string
  default     = ""
}

# Runtime half of the two-key commercial gate; commercial-status.json is the
# other half and both must open. Defaults closed, so enabling payments is
# always an explicit, reviewable per-environment tfvars change.
variable "payments_enabled" {
  description = "Set to the exact string \"1\" to permit Stripe Checkout and billing-portal session creation. Any other value keeps payment activity disabled."
  type        = string
  default     = "0"

  validation {
    condition     = contains(["0", "1"], var.payments_enabled)
    error_message = "payments_enabled must be exactly \"0\" or \"1\". The backend compares this to the literal string \"1\"; near-misses such as \"true\", \"01\", or a padded value silently disable payments."
  }
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
