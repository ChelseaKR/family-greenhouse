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
  description = "Allowed CORS origin"
  type        = string
}

variable "bedrock_chat_model_id" {
  description = "Bedrock model ID or inference profile for the chat Lambda. Defaults to '' which lets the Lambda code fall back to Haiku 4.5."
  type        = string
  default     = ""
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
  description = "Stripe price ID for the Garden tier ($4.99/mo). Required for /billing/checkout."
  type        = string
  default     = ""
}

variable "stripe_price_id_greenhouse" {
  description = "Stripe price ID for the Greenhouse tier ($9.99/mo). Required for /billing/checkout."
  type        = string
  default     = ""
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
  description = "Set to '1' to actually publish SMS via SNS. Off by default; reminder code dry-runs to logs."
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

variable "perenual_api_key_secret_id" {
  description = "Secrets Manager secret name (e.g. 'family-greenhouse/perenual-api-key') holding the Perenual API key. The Lambda fetches the value at cold start; the secret material never lands in Terraform state. Empty disables Perenual integration."
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

# --- Chat budget tuning ---
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
