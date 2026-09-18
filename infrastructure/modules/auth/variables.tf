variable "environment" {
  description = "Environment name"
  type        = string
}

variable "project_name" {
  description = "Project name"
  type        = string
}

variable "public_registration_enabled" {
  description = "Permit public Cognito SignUp calls. Defaults closed so every environment must opt in deliberately."
  type        = bool
  default     = false
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

variable "custom_message_lambda_arn" {
  description = "ARN of the CustomMessage trigger that renders the branded forgot-password / admin-invite bodies (modules/email). Empty leaves Cognito's own copy in place."
  type        = string
  default     = ""
}

variable "custom_message_function_name" {
  description = "Function name matching custom_message_lambda_arn. Needed separately because aws_lambda_permission takes a name while the pool takes an ARN."
  type        = string
  default     = ""
}

variable "passkeys_enabled" {
  description = "Turn on Cognito passkey (WebAuthn) sign-in (#671). OFF by default and in every committed tfvars: the owner flips it after reading the plan, which must show aws_cognito_user_pool.main as `~ update in-place` (web_authn_configuration and sign_in_policy are not ForceNew in provider 6.54) — never `-/+ replace`. Needs passkey_relying_party_id."
  type        = bool
  default     = false
}

variable "passkey_relying_party_id" {
  description = "WebAuthn relying-party ID for passkeys: the site's registrable domain (e.g. familygreenhouse.net). The browser only offers a passkey on this domain and its subdomains. Required when passkeys_enabled."
  type        = string
  default     = ""
}
