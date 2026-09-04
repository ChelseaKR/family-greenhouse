variable "environment" {
  description = "Environment name"
  type        = string
}

variable "project_name" {
  description = "Project name"
  type        = string
}

variable "cognito_user_pool_id" {
  description = "Cognito User Pool ID"
  type        = string
}

variable "cognito_client_id" {
  description = "Cognito Client ID"
  type        = string
}

variable "dynamodb_table_name" {
  description = "DynamoDB table name"
  type        = string
}

variable "dynamodb_table_arn" {
  description = "DynamoDB table ARN"
  type        = string
}

variable "images_bucket_name" {
  description = "S3 bucket name for images"
  type        = string
}

variable "images_bucket_arn" {
  description = "S3 bucket ARN for images"
  type        = string
}

variable "allowed_origin" {
  description = "Allowed CORS origin (the user-facing web origin; also used to build links)"
  type        = string
}

variable "native_app_origins" {
  description = <<-EOT
    Exact application-layer origins for the Capacitor mobile shells. iOS serves
    the bundled app from capacitor://localhost and the Android WebView from
    https://localhost. The shells use CapacitorHttp for remote requests because
    AWS managed CORS cannot represent capacitor://; this list still governs
    Lambda-owned responses and must remain exact (never wildcarded).
  EOT
  type        = list(string)
  default     = ["capacitor://localhost", "https://localhost"]
}

variable "application_cors_enabled" {
  description = "Whether the standalone chat-stream Lambda emits CORS headers; keep false while Function URL managed CORS is enabled"
  type        = bool
  default     = false
}

variable "bedrock_chat_model_id" {
  description = "Bedrock model ID or inference profile for the chat Lambda. Defaults to '' which lets the Lambda code fall back to Haiku 4.5."
  type        = string
  default     = ""
}

variable "chat_enabled" {
  description = "Incident kill switch for new chat model turns. '1' enables; '0' returns 503 before budget/persistence/model work."
  type        = string
  default     = "1"
  validation {
    condition     = contains(["0", "1"], var.chat_enabled)
    error_message = "chat_enabled must be '0' or '1'."
  }
}

variable "bedrock_input_usd_per_mtok" {
  description = "USD per million input tokens for the configured model. Empty string leaves the Lambda code default in place (Haiku 4.5 = 1.0)."
  type        = string
  default     = ""
}

variable "bedrock_output_usd_per_mtok" {
  description = "USD per million output tokens for the configured model. Empty string leaves the Lambda code default in place (Haiku 4.5 = 5.0)."
  type        = string
  default     = ""
}

# --- Stripe ---
# Empty defaults are intentional: the billing service throws at startup if
# the secret key is missing, so a real deploy must supply via tfvars OR
# (better) migrate to a Secrets Manager / SSM Parameter Store ref.
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
  description = "Set to '1' only after Stripe Tax registrations and product tax codes are configured. Enables automatic tax in Checkout."
  type        = string
  default     = ""
}

# Second, independent commercial gate. The repository status file
# (commercial-status.json) is the first; payment activity requires BOTH. Kept
# a string, not a bool, because the backend compares it to the exact value "1"
# — see backend/src/config/commercialStatus.ts. Defaults closed so a new
# environment never inherits live payment collection.
variable "payments_enabled" {
  description = "Set to the exact string \"1\" to permit Stripe Checkout and billing-portal session creation. Any other value keeps payment activity disabled. Requires commercialHoldActive=false in commercial-status.json to take effect."
  type        = string
  default     = "0"
}

# --- Notification delivery ---
variable "ses_identity_arn" {
  description = "ARN of the verified SES identity (domain) reminder emails are sent from. Used to scope the Lambda role's ses:SendEmail/SendRawEmail grant. Empty (no domain provisioned) falls back to Resource \"*\"."
  type        = string
  default     = ""
}

variable "ses_from_email" {
  description = "Verified SES sender address for reminder emails, e.g. 'reminders@familygreenhouse.net'."
  type        = string
  default     = ""
}

variable "ses_reply_to_email" {
  description = "Reply-To header on the app's own SES sends. Should be an address that actually reaches a human (support@, forwarded by modules/email/inbound.tf). Empty sends no Reply-To, leaving replies to land on the From address."
  type        = string
  default     = ""
}

variable "ses_configuration_set" {
  description = "SES configuration set name attached to every send. Empty means SES publishes no bounce/complaint events, so the suppression list never learns anything — set it whenever the email module is provisioned."
  type        = string
  default     = ""
}

variable "ses_event_topic_arn" {
  description = "SNS topic carrying SES bounce/complaint/delivery events (modules/email). Empty leaves the emailEvents Lambda deployed but unsubscribed. NOT usable in a `count`/`for_each` — see ses_events_enabled."
  type        = string
  default     = ""
}

# The plan-time twin of ses_event_topic_arn. The ARN is a resource attribute of
# a topic in another module: on a run where that topic does not exist yet it is
# unknown until apply, and a `count` that reads an unknown value is a hard
# `terraform plan` error ("The count value depends on resource attributes that
# cannot be determined until apply"), not a deferred decision. So the two
# conditional resources below count on THIS flag instead — the root module sets
# it from `var.domain_name != ""`, the same plain-input predicate that gates
# `module.email` itself, which is always known at plan time.
variable "ses_events_enabled" {
  description = "Whether the email module (and therefore the SES event topic) is provisioned. Mirrors the `var.domain_name != \"\"` predicate that gates module.email. Exists so the SNS subscription + Lambda permission can be counted on a plan-time-known value rather than on ses_event_topic_arn."
  type        = bool
  default     = false
}

variable "web_push_vapid_public_key" {
  description = "VAPID public key for web push. Generate with `npx web-push generate-vapid-keys`."
  type        = string
  default     = ""
}

variable "web_push_vapid_private_key" {
  description = "VAPID private key for web push."
  type        = string
  default     = ""
  sensitive   = true
}

variable "web_push_vapid_subject" {
  description = "VAPID subject (mailto: URL) embedded in push messages."
  type        = string
  default     = ""
}

variable "sms_notifications_enabled" {
  description = "Set to '1' only with SMS production access and an approved origination identity. Off by default; verification fails with 503 and reminders dry-run."
  type        = string
  default     = ""
}

# --- Plant identification (Plant.id integration) ---
variable "plant_id_api_key" {
  description = "Plant.id API key. Optional; without it the identify endpoint falls back to a demo response."
  type        = string
  default     = ""
  sensitive   = true
}

variable "identify_metering_enabled" {
  description = "Set to '1' to ENFORCE the Plant.id identify monthly meter (blocks once a household exceeds its cap). Empty/'' only tracks usage without blocking (beta default). Production should set '1' so the per-call Plant.id credit can't be cost-amplified."
  type        = string
  default     = ""
}

# --- Leaf-health monthly cap (Bedrock vision; services/leafHealthBudget.ts) ---
# Empty = code default (a flat 200 per household per month, every tier). The
# per-tier values inherit the flat one when empty; setting any of them makes
# the handler resolve the household's plan first. '0' = unlimited.
variable "leaf_health_monthly_cap" {
  description = "Flat monthly leaf-health check cap per household for every tier without a per-tier override. Empty = code default (200). '0' = unlimited."
  type        = string
  default     = ""
}

variable "leaf_health_monthly_cap_seedling" {
  description = "Monthly leaf-health check cap for Seedling households. Empty = inherit leaf_health_monthly_cap. '0' = unlimited."
  type        = string
  default     = ""
}

variable "leaf_health_monthly_cap_garden" {
  description = "Monthly leaf-health check cap for Garden households. Empty = inherit leaf_health_monthly_cap. '0' = unlimited."
  type        = string
  default     = ""
}

variable "leaf_health_monthly_cap_greenhouse" {
  description = "Monthly leaf-health check cap for Greenhouse households. Empty = inherit leaf_health_monthly_cap. '0' = unlimited."
  type        = string
  default     = ""
}

# Declaring "this environment has no Bedrock" is what earns the canned demo
# assessment on an AccessDeniedException. Off by default so an environment
# that IS supposed to reach Bedrock fails loudly (503 + ERROR log) rather than
# answering with a fixture at HTTP 200.
variable "leaf_health_demo" {
  description = "Return the canned demo leaf-health assessment when Bedrock refuses this deployment. Set true ONLY for an environment with no Bedrock access."
  type        = bool
  default     = false
}

variable "perenual_api_key_parameter_name" {
  description = "SSM SecureString parameter name (e.g. '/family-greenhouse/perenual-api-key') holding the Perenual API key. The Lambda fetches the value at cold start; the secret material never lands in Terraform state. Empty disables Perenual integration."
  type        = string
  default     = ""
}

variable "perenual_daily_budget" {
  description = "Max Perenual API calls per day. Empty lets the code default (80) apply."
  type        = string
  default     = ""
}

# --- OpenWeather (climate / weather) integration ---
variable "openweather_api_key" {
  description = "OpenWeather API key. Optional, but without it the weather service short-circuits to null and the climate features silently disable."
  type        = string
  default     = ""
  sensitive   = true
}

variable "openweather_daily_budget" {
  description = "Max OpenWeather API calls per day. Empty lets the code default (800) apply."
  type        = string
  default     = ""
}

# --- Bedrock embeddings (chat RAG corpus) ---
variable "bedrock_embed_model_id" {
  description = "Bedrock embedding model ID for the chat RAG corpus. Empty lets the code default (amazon.titan-embed-text-v2:0) apply."
  type        = string
  default     = ""
}

variable "sprout_integration_enabled" {
  description = "Set to '1' to enable the first-party Sprout chat path."
  type        = string
  default     = ""
}

variable "sprout_api_url" {
  description = "Base URL for the Sprout API."
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
  description = "Secrets Manager id containing the Sprout HMAC secret."
  type        = string
  default     = ""
}

# --- Sentry / release tagging ---
variable "sentry_dsn" {
  description = "Sentry DSN. Empty = Sentry disabled (instrument() falls through to a no-op wrapper)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "sentry_traces_sample_rate" {
  description = "Sampling rate for performance traces, e.g. '0.1'."
  type        = string
  default     = ""
}

variable "git_sha" {
  description = "Git SHA the bundle was built from. Tagged onto Sentry release + structured logs."
  type        = string
  default     = ""
}

# --- Chat budget tuning (services/chat/budget.ts) ---
# The flat pair applies to every tier without a per-tier value; a per-tier
# value that is empty inherits the flat one for that counter. '0' is a zero
# budget on every one of these (the root validation refuses it).
variable "chat_budget_input_tokens" {
  description = "Per-household monthly input-token cap for chat. Empty = code default (250000)."
  type        = string
  default     = ""
}

variable "chat_budget_output_tokens" {
  description = "Per-household monthly output-token cap for chat. Empty = code default (50000)."
  type        = string
  default     = ""
}

variable "chat_budget_input_tokens_seedling" {
  description = "Monthly chat input-token cap for Seedling households. Empty = inherit chat_budget_input_tokens. '0' is a zero budget, not unlimited."
  type        = string
  default     = ""
}

variable "chat_budget_output_tokens_seedling" {
  description = "Monthly chat output-token cap for Seedling households. Empty = inherit chat_budget_output_tokens. '0' is a zero budget, not unlimited."
  type        = string
  default     = ""
}

variable "chat_budget_input_tokens_garden" {
  description = "Monthly chat input-token cap for Garden households. Empty = inherit chat_budget_input_tokens. '0' is a zero budget, not unlimited."
  type        = string
  default     = ""
}

variable "chat_budget_output_tokens_garden" {
  description = "Monthly chat output-token cap for Garden households. Empty = inherit chat_budget_output_tokens. '0' is a zero budget, not unlimited."
  type        = string
  default     = ""
}

variable "chat_budget_input_tokens_greenhouse" {
  description = "Monthly chat input-token cap for Greenhouse households. Empty = inherit chat_budget_input_tokens. '0' is a zero budget, not unlimited."
  type        = string
  default     = ""
}

variable "chat_budget_output_tokens_greenhouse" {
  description = "Monthly chat output-token cap for Greenhouse households. Empty = inherit chat_budget_output_tokens. '0' is a zero budget, not unlimited."
  type        = string
  default     = ""
}

# --- PostHog (server-side product analytics) ---
# Server PostHog key powers confirmed conversion events emitted from the Stripe
# webhook (e.g. subscription_activated). Empty = the server analytics emitter
# no-ops, so nothing leaks from non-configured environments.
variable "posthog_key" {
  description = "PostHog project API key for server-side analytics. Empty disables the server emitter (no-op)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "posthog_host" {
  description = "PostHog ingestion host for server-side analytics. Empty lets the code default (https://us.i.posthog.com) apply."
  type        = string
  default     = ""
}
