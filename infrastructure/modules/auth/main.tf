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

    # Dormant in production (`public_registration_enabled = true`), and a
    # template precisely so flipping that flag cannot quietly ship AWS's stock
    # invitation copy from our own From: address. The CustomMessage trigger
    # below renders the same body; this declarative template is what applies if
    # the trigger is ever absent (e.g. an environment with no SES module).
    # {username} and {####} are Cognito's substitutions and must appear verbatim.
    invite_message_template {
      email_subject = "You have been invited to Family Greenhouse"
      email_message = <<-EOT
        Hi there,

        Someone has set up a Family Greenhouse account for you — the family
        plant-care app that helps you grow together.

        Your username is: {username}
        Your temporary password is: {####}

        Sign in and you'll be asked to choose your own password. The temporary
        one stops working once you do.

        Not expecting this? You can safely ignore this email — the account
        stays locked until someone signs in with the password above.

        — The Family Greenhouse team
        https://familygreenhouse.net
      EOT
      sms_message   = "Your Family Greenhouse username is {username} and temporary password is {####}"
    }
  }

  # Branded bodies for the message paths a declarative template cannot reach —
  # forgot-password above all, which otherwise ships AWS's stock copy from the
  # same sender as the hand-written sign-up email. Wired only when the email
  # module is provisioned; environments without SES keep Cognito's defaults.
  # See modules/email/cognito_messages.tf and ADR 0022.
  dynamic "lambda_config" {
    for_each = var.custom_message_lambda_arn == "" ? [] : [var.custom_message_lambda_arn]
    content {
      custom_message = lambda_config.value
    }
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
    reply_to_email_address = var.email_reply_to != "" ? var.email_reply_to : (var.email_from_address != "" ? var.email_from_address : null)
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

# Invoke permission for the CustomMessage trigger. It lives HERE, not in the
# email module that owns the function, because `source_arn` is the user pool —
# scoping the grant to this pool instead of to the whole account. The module
# order is email -> auth, so the function already exists by the time this runs.
#
# Terraform creates the pool (with lambda_config) before this permission, so
# there is a seconds-long window during the FIRST apply in which Cognito is
# configured to call a function it may not invoke yet. Cognito validates the
# grant at invoke time, not at configuration time, so the only exposure is a
# password-reset attempt landing inside that window during an apply.
resource "aws_lambda_permission" "cognito_custom_message" {
  count = var.custom_message_function_name == "" ? 0 : 1

  statement_id  = "AllowCognitoCustomMessage"
  action        = "lambda:InvokeFunction"
  function_name = var.custom_message_function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.main.arn
}
