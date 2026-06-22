terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.51"
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

  environment        = var.environment
  project_name       = var.project_name
  email_identity_arn = var.domain_name == "" ? "" : module.email[0].identity_arn
  email_from_address = var.email_from_address
  email_reply_to     = var.email_reply_to

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
  # Perenual uses the Secrets-Manager-ID indirection so the API key never
  # touches Terraform state (see modules/api/main.tf IAM block).
  perenual_api_key_secret_id = var.perenual_api_key_secret_id
  perenual_daily_budget      = var.perenual_daily_budget
  openweather_api_key        = var.openweather_api_key
  openweather_daily_budget   = var.openweather_daily_budget
  bedrock_embed_model_id     = var.bedrock_embed_model_id
  identify_metering_enabled  = var.identify_metering_enabled
}

# Frontend module (S3 + CloudFront)
module "frontend" {
  source = "./modules/frontend"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment  = var.environment
  project_name = var.project_name
  domain_name  = var.domain_name
}

# Monitoring module (CloudWatch)
module "monitoring" {
  source = "./modules/monitoring"

  environment           = var.environment
  project_name          = var.project_name
  api_gateway_name      = module.api.api_gateway_name
  lambda_function_names = module.api.lambda_function_names
  alert_email           = var.alert_email
  alert_sms_number      = var.alert_sms_number
  dynamodb_table_name   = module.database.table_name
  api_endpoint          = module.api.api_gateway_endpoint
  monthly_budget_usd    = var.monthly_budget_usd
  lambda_dlq_name       = module.api.lambda_dlq_name
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
