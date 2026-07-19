terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.52"
    }
    # Zips the inbound-mail forwarder Lambda (modules/email/inbound.tf).
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "family-greenhouse"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

locals {
  application_domain = var.application_domain != "" ? var.application_domain : var.domain_name
  hosted_zone_name   = var.hosted_zone_name != "" ? var.hosted_zone_name : var.domain_name
}

# Provider for CloudFront certificates (must be us-east-1)
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = "family-greenhouse"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# Email module (SES domain identity + DKIM + SPF + DMARC).
# Only created when a domain is set — otherwise Cognito falls back to its
# default no-DKIM service mailbox (fine for dev/staging).
module "email" {
  source = "./modules/email"
  count  = var.domain_name == "" ? 0 : 1

  environment     = var.environment
  project_name    = var.project_name
  domain_name     = var.domain_name
  dmarc_rua_email = var.dmarc_rua_email
}

# Auth module (Cognito). When the email module is present, hand its identity
# ARN over so Cognito sends DKIM-aligned mail from the project domain.
# depends_on the email module so the SES identity verification completes
# before Cognito tries to switch to DEVELOPER mode against an unverified
# identity (Terraform's implicit dependency only tracks the identity ARN,
# not the verification resource).
module "auth" {
  source = "./modules/auth"

  environment                 = var.environment
  project_name                = var.project_name
  public_registration_enabled = var.public_registration_enabled
  email_identity_arn          = var.domain_name == "" ? "" : module.email[0].identity_arn
  email_from_address          = var.email_from_address
  email_reply_to              = var.email_reply_to

  depends_on = [module.email]
}

# Database module (DynamoDB)
module "database" {
  source = "./modules/database"

  environment  = var.environment
  project_name = var.project_name
}

# API module (API Gateway + Lambda)
module "api" {
  source = "./modules/api"

  environment          = var.environment
  project_name         = var.project_name
  cognito_user_pool_id = module.auth.user_pool_id
  cognito_client_id    = module.auth.client_id
  dynamodb_table_name  = module.database.table_name
  dynamodb_table_arn   = module.database.table_arn
  images_bucket_name   = module.frontend.images_bucket_name
  images_bucket_arn    = module.frontend.images_bucket_arn
  allowed_origin       = module.frontend.site_url
  # Scopes the Lambda role's SES send grant to the verified domain identity
  # (instead of Resource "*") when the email module is provisioned.
  ses_identity_arn = var.domain_name == "" ? "" : module.email[0].identity_arn

  # External integrations. Empty defaults disable the corresponding feature
  # — set via tfvars when you have credentials.
  # Perenual uses Parameter Store indirection so the API key never
  # touches Terraform state (see modules/api/main.tf IAM block).
  perenual_api_key_parameter_name = var.perenual_api_key_parameter_name
  perenual_daily_budget           = var.perenual_daily_budget
  openweather_api_key             = var.openweather_api_key
  openweather_daily_budget        = var.openweather_daily_budget
  bedrock_embed_model_id          = var.bedrock_embed_model_id
  chat_enabled                    = var.chat_enabled
  sprout_integration_enabled      = var.sprout_integration_enabled
  sprout_api_url                  = var.sprout_api_url
  sprout_integration_secret_id    = var.sprout_integration_secret_id
  identify_metering_enabled       = var.identify_metering_enabled
  sms_notifications_enabled       = var.sms_notifications_enabled
  git_sha                         = var.git_sha
  sentry_dsn                      = var.sentry_dsn
  sentry_traces_sample_rate       = var.sentry_traces_sample_rate
  posthog_key                     = var.posthog_key
  posthog_host                    = var.posthog_host

  # Stripe. See variables.tf — these must be declared at THIS level too, or
  # Terraform silently drops the tfvars/TF_VAR_* values (undeclared variable
  # is only a warning) and every Lambda sees "" regardless of what's set.
  stripe_secret_key                 = var.stripe_secret_key
  stripe_webhook_secret             = var.stripe_webhook_secret
  stripe_price_id_garden            = var.stripe_price_id_garden
  stripe_price_id_garden_annual     = var.stripe_price_id_garden_annual
  stripe_price_id_garden_lifetime   = var.stripe_price_id_garden_lifetime
  stripe_price_id_greenhouse        = var.stripe_price_id_greenhouse
  stripe_price_id_greenhouse_annual = var.stripe_price_id_greenhouse_annual
  stripe_automatic_tax_enabled      = var.stripe_automatic_tax_enabled
}

# Price ids are visually identical in test and live Stripe mode, so this is
# the only guard available short of calling the Stripe API during plan: warn
# loudly if a live-looking secret key is paired with a still-unconfirmed
# stripe_price_ids_are_live flag.
check "stripe_price_mode_confirmed" {
  assert {
    condition     = !startswith(var.stripe_secret_key, "sk_live_") || var.stripe_price_ids_are_live
    error_message = "STRIPE_SECRET_KEY looks like a live key (sk_live_...) but stripe_price_ids_are_live is still false. Stripe price ids don't encode test/live mode, so Terraform can't detect a mismatch on its own — manually confirm every stripe_price_id_* was created in Stripe LIVE mode, then set stripe_price_ids_are_live = true."
  }
}

# Frontend module (S3 + CloudFront)
module "frontend" {
  source = "./modules/frontend"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment       = var.environment
  project_name      = var.project_name
  domain_name       = local.application_domain
  hosted_zone_name  = local.hosted_zone_name
  include_www_alias = var.application_domain_include_www
}

# Monitoring module (CloudWatch)
module "monitoring" {
  source = "./modules/monitoring"

  environment                 = var.environment
  project_name                = var.project_name
  enable_cost_anomaly_monitor = var.environment == "production"
  api_gateway_id              = module.api.api_gateway_id
  api_access_log_group_name   = module.api.api_access_log_group_name
  api_lambda_log_group_name   = module.api.api_lambda_log_group_name
  auth_lambda_log_group_name  = module.api.auth_lambda_log_group_name
  lambda_function_names       = module.api.lambda_function_names
  alert_email                 = var.alert_email
  alert_sms_number            = var.alert_sms_number
  dynamodb_table_name         = module.database.table_name
  monthly_budget_usd          = var.monthly_budget_usd
  lambda_dlq_name             = module.api.lambda_dlq_name
  # Wired only when the email module is provisioned (domain set). No cycle:
  # monitoring already depends on api (which depends on email), and email
  # depends on nothing here.
  email_forwarder_dlq_name = var.domain_name == "" ? "" : module.email[0].forwarder_dlq_name
}

# NOTE: the WAF (`modules/security`) was removed for cost (~$8-16/mo) — its
# regional web ACL could not attach to the HTTP API (WAFv2 doesn't support
# apigatewayv2; see git history / PR #34) and protected nothing. Edge defense
# now rests on API Gateway stage throttling + Cognito threat protection +
# in-code rate limiting. To reintroduce real edge WAF, front the API with
# CloudFront and attach a CLOUDFRONT-scoped ACL there.

# GitHub OIDC + deploy role for CI/CD. Skipped (count=0) until github_org +
# github_repo are set, so first-time `terraform apply` doesn't try to
# provision an OIDC provider before the repo exists.
module "cicd" {
  source = "./modules/cicd"
  count  = var.github_org == "" || var.github_repo == "" ? 0 : 1

  project_name = var.project_name
  github_org   = var.github_org
  github_repo  = var.github_repo
}
