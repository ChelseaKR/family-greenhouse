resource "aws_cognito_user_pool" "main" {
  name = "${var.project_name}-${var.environment}"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  # PLUS tier required to enable Threat Protection. Cost vs ESSENTIALS:
  # PLUS is ~$0.015/MAU after the free tier (~100 MAU), ESSENTIALS is
  # ~$0.0055/MAU. Tiny dollar amount at sub-1000 MAU; revisit if MAU
  # grows past a few thousand.
  user_pool_tier = "PLUS"

  # Public free-account registration is an explicit, fail-closed environment
  # policy. Production snapshots this value before deploys and restores that
  # exact prior state on rollback; changing it is an in-place pool update.
  admin_create_user_config {
    allow_admin_create_user_only = !var.public_registration_enabled
  }

  # Cognito's "Advanced Security" (Threat Protection) — risk-based adaptive
  # auth + compromised-credential checks against Cognito's leaked-password
  # DB + per-user brute-force detection. ENFORCED means Cognito itself
  # blocks high-risk sign-ins (not just logs them).
  user_pool_add_ons {
    advanced_security_mode = "ENFORCED"
  }

  password_policy {
    # Exact account-creation contract: 12+ characters with uppercase,
    # lowercase, and a digit. Symbols are accepted but not required.
    minimum_length    = 12
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
    require_uppercase = true
  }

  # Optional TOTP (authenticator-app) MFA. OPTIONAL means users may enrol a
  # software token but aren't forced to — non-breaking for existing accounts,
  # while letting security-conscious household owners (who control the
  # authorization attributes) harden their own login. SMS MFA is deliberately
  # left off: it's the weaker factor and carries per-message cost.
  mfa_configuration = "OPTIONAL"
  software_token_mfa_configuration {
    enabled = true
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  # Cognito's default sender (no-reply@verificationemail.com) has no DKIM
  # alignment to our domain and lands in spam. When an SES identity is
  # provided, switch to DEVELOPER mode so confirmations come `From:
  # hello@familygreenhouse.net` with proper DKIM. Falls back to the default
  # service mailbox in dev/staging where we haven't provisioned SES.
  email_configuration {
    email_sending_account  = var.email_identity_arn == "" ? "COGNITO_DEFAULT" : "DEVELOPER"
    source_arn             = var.email_identity_arn == "" ? null : var.email_identity_arn
    from_email_address     = var.email_from_address == "" ? null : var.email_from_address
    reply_to_email_address = coalesce(var.email_reply_to, var.email_from_address, "") == "" ? null : coalesce(var.email_reply_to, var.email_from_address)
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Welcome to Family Greenhouse — confirm your email"
    email_message        = <<-EOT
      Hi there,

      Thanks for signing up for Family Greenhouse — the family plant-care app
      that helps you grow together.

      Your verification code is: {####}

      Pop that into the confirmation screen to finish setting up your account.
      The code expires in 24 hours.

      Didn't sign up? You can safely ignore this email.

      — The Family Greenhouse team
      https://familygreenhouse.net
    EOT
  }

  schema {
    attribute_data_type = "String"
    name                = "household_id"
    mutable             = true

    string_attribute_constraints {
      max_length = 36
      min_length = 0
    }
  }

  schema {
    attribute_data_type = "String"
    name                = "household_role"
    mutable             = true

    string_attribute_constraints {
      max_length = 10
      min_length = 0
    }
  }

  tags = {
    Name = "${var.project_name}-user-pool-${var.environment}"
  }

  lifecycle {
    # DEVELOPER email mode (triggered by providing an SES identity) REQUIRES a
    # from_email_address, but the two are wired from independent variables — so
    # setting a domain without a from-address yields from_email_address = null
    # and Cognito rejects the apply with an opaque InvalidParameter. Catch it at
    # plan time with an actionable message instead.
    precondition {
      condition     = var.email_identity_arn == "" || var.email_from_address != ""
      error_message = "email_from_address is required when an SES identity (email_identity_arn / domain_name) is set: DEVELOPER email mode has no usable sender without it."
    }
  }
}

resource "aws_cognito_user_pool_client" "main" {
  name         = "${var.project_name}-client-${var.environment}"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH",
  ]

  supported_identity_providers = ["COGNITO"]

  read_attributes = [
    "email",
    "name",
    "custom:household_id",
    "custom:household_role",
  ]

  # SECURITY: custom:household_id / custom:household_role are AUTHORIZATION
  # attributes — they decide which household a user belongs to and what they
  # may do there. They must NEVER appear in write_attributes: any attribute
  # listed there is self-service writable by the end user via
  # UpdateUserAttributes with nothing but their own access token, which would
  # let anyone join an arbitrary household or grant themselves "owner"
  # (privilege escalation). They stay in read_attributes (above) so they flow
  # into ID-token claims, and are mutated exclusively by the backend through
  # AdminUpdateUserAttributes (see the cognito-idp grant in modules/api),
  # which enforces membership/role rules first.
  write_attributes = [
    "email",
    "name",
  ]

  access_token_validity  = 1  # hours
  id_token_validity      = 1  # hours
  refresh_token_validity = 30 # days

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  prevent_user_existence_errors = "ENABLED"
}
