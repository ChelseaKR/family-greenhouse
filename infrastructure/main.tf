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

locals {
  application_domain = var.application_domain != "" ? var.application_domain : var.domain_name
  hosted_zone_name   = var.hosted_zone_name != "" ? var.hosted_zone_name : var.domain_name

  # Tags stamped onto every taggable resource by BOTH aws providers below.
  #
  # Why two spellings of the same thing: AWS cost-allocation tag KEYS are
  # case-sensitive, and the payer account activated the lowercase `project`
  # key (plus `environment`) in Cost Explorer. The TitleCase Project/
  # Environment tags this stack already applied are therefore invisible to
  # billing — which is why family-greenhouse showed $0 of tagged spend while
  # still running real infrastructure. The lowercase pair is what the
  # per-project prod/staging budgets actually filter on.
  #
  # The TitleCase pair is deliberately KEPT rather than renamed: nothing in
  # AWS reads a tag key case-insensitively, so dropping it would silently
  # break any console filter, saved report or ad-hoc query built on it, and
  # would rewrite tags on every resource in the stack for no billing gain.
  #
  # `environment` is var.environment ("production" | "staging", enforced by
  # the validation in variables.tf). The two environments are separate
  # Terraform states selected by backend key at init time (see backend.tf),
  # each fed its own environments/<env>/terraform.tfvars, so this value is
  # always the environment being applied and the two budgets can tell each
  # other apart.
  cost_allocation_tags = {
    Project     = "family-greenhouse"
    Environment = var.environment
    ManagedBy   = "terraform"

    project     = "family-greenhouse"
    environment = var.environment
  }

  # IAM is the one service that compares tag KEYS case-insensitively, so the
  # deliberate Project/project and Environment/environment pairs above are
  # rejected outright by CreateRole:
  #
  #   InvalidInput: Duplicate tag keys found. Please note that Tag keys are
  #   case insensitive.
  #
  # This only bites on a fresh create, which is why it stayed latent: existing
  # roles are never re-created, so it surfaced the first time staging was
  # rebuilt from an empty state. Nothing is lost by dropping the lowercase
  # pair here — IAM roles and policies are free, so they never appear in a
  # cost-allocation report, and the lowercase keys exist purely for the
  # per-project budgets. The TitleCase pair the console filters use is kept.
  iam_safe_tags = {
    Project     = "family-greenhouse"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.cost_allocation_tags
  }
}

# Provider for CloudFront certificates (must be us-east-1)
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.cost_allocation_tags
  }
}

# Provider for IAM resources only. Identical to the default provider except
# that its default_tags carry a single spelling of each key — see
# local.iam_safe_tags for why IAM cannot take the case-duplicated pair.
provider "aws" {
  alias  = "iam"
  region = var.aws_region

  default_tags {
    tags = local.iam_safe_tags
  }
}

# Email module (SES domain identity + DKIM + SPF + DMARC).
# Only created when a domain is set — otherwise Cognito falls back to its
# default no-DKIM service mailbox (fine for dev/staging).
module "email" {
  source = "./modules/email"

  providers = {
    aws     = aws
    aws.iam = aws.iam
  }
  count = var.domain_name == "" ? 0 : 1

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
  # Branded forgot-password / admin-invite bodies. Absent (empty) in an
  # environment with no domain, where Cognito's own copy is the only option.
  custom_message_lambda_arn    = var.domain_name == "" ? "" : module.email[0].cognito_custom_message_lambda_arn
  custom_message_function_name = var.domain_name == "" ? "" : module.email[0].cognito_custom_message_function_name

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

  providers = {
    aws     = aws
    aws.iam = aws.iam
  }

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
  ses_from_email   = var.email_from_address
  # Reply-To on the app's own sends. `hello@` is send-only in spirit; support@
  # is the address inbound.tf forwards to a human, so a reply to a reminder or
  # a digest reaches somebody.
  ses_reply_to_email = var.email_reply_to
  # Attaching the configuration set is what makes SES publish bounce/complaint
  # events at all; the topic ARN is what the emailEvents Lambda subscribes to.
  ses_configuration_set = var.domain_name == "" ? "" : module.email[0].configuration_set_name
  ses_event_topic_arn   = var.domain_name == "" ? "" : module.email[0].event_topic_arn
  # The SAME predicate that gates `module.email` above, passed down separately
  # because the api module needs it at PLAN time. `ses_event_topic_arn` is a
  # resource attribute and is unknown until the topic exists, which makes it
  # illegal in a `count` — see modules/api/main.tf "SES delivery feedback".
  ses_events_enabled         = var.domain_name != ""
  web_push_vapid_public_key  = var.web_push_vapid_public_key
  web_push_vapid_private_key = var.web_push_vapid_private_key
  web_push_vapid_subject     = var.web_push_vapid_subject

  # External integrations. Empty defaults disable the corresponding feature
  # — set via tfvars when you have credentials.
  # Perenual uses Parameter Store indirection so the API key never
  # touches Terraform state (see modules/api/main.tf IAM block).
  perenual_api_key_parameter_name = var.perenual_api_key_parameter_name
  perenual_daily_budget           = var.perenual_daily_budget
  plant_id_api_key                = var.plant_id_api_key
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

  # AI inference cost caps. All blank = the code defaults every tier has
  # always had (200 leaf-health checks; 250k/50k chat tokens). See the
  # "AI inference cost caps" block in variables.tf for what each lever does.
  leaf_health_monthly_cap            = var.leaf_health_monthly_cap
  leaf_health_monthly_cap_seedling   = var.leaf_health_monthly_cap_seedling
  leaf_health_monthly_cap_garden     = var.leaf_health_monthly_cap_garden
  leaf_health_monthly_cap_greenhouse = var.leaf_health_monthly_cap_greenhouse
  leaf_health_demo                   = var.leaf_health_demo
  chat_budget_input_tokens           = var.chat_budget_input_tokens
  chat_budget_output_tokens          = var.chat_budget_output_tokens
  # Per-tier chat budgets; a blank one inherits the flat pair above.
  chat_budget_input_tokens_seedling    = var.chat_budget_input_tokens_seedling
  chat_budget_output_tokens_seedling   = var.chat_budget_output_tokens_seedling
  chat_budget_input_tokens_garden      = var.chat_budget_input_tokens_garden
  chat_budget_output_tokens_garden     = var.chat_budget_output_tokens_garden
  chat_budget_input_tokens_greenhouse  = var.chat_budget_input_tokens_greenhouse
  chat_budget_output_tokens_greenhouse = var.chat_budget_output_tokens_greenhouse

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
  stripe_price_id_identify_top_up   = var.stripe_price_id_identify_top_up
  stripe_automatic_tax_enabled      = var.stripe_automatic_tax_enabled
  payments_enabled                  = var.payments_enabled
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

# The two commercial gates guard real charges to real cards, so they are
# enforced with preconditions rather than `check` blocks: a check block only
# emits a WARNING and lets `terraform apply` proceed, which in CI (plan -out
# then apply tfplan) means nobody ever sees it. A failed precondition fails the
# plan outright, so a misconfigured launch cannot reach an apply at all.
resource "terraform_data" "commercial_gate_guard" {
  input = var.payments_enabled

  lifecycle {
    # Enabling payments with a blank secret key or blank MONTHLY price id would
    # publish buy buttons that fail at Stripe (502) for every household. The
    # annual and lifetime ids are deliberately not required: a blank one only
    # hides that cadence, which is a valid partial launch.
    precondition {
      condition = var.payments_enabled != "1" || (
        var.stripe_secret_key != "" &&
        var.stripe_webhook_secret != "" &&
        var.stripe_price_id_garden != "" &&
        var.stripe_price_id_greenhouse != ""
      )
      error_message = "payments_enabled is \"1\" but Stripe configuration is incomplete. Checkout needs stripe_secret_key, stripe_webhook_secret, stripe_price_id_garden, and stripe_price_id_greenhouse to all be non-empty; without them every checkout attempt returns a 502."
    }

    # The two gates are independent by design, but opening the runtime half
    # while the committed status file still holds is always a mistake: the
    # backend keeps refusing checkout and the paid UI stays hidden, so the
    # environment looks enabled while behaving exactly as if it were not.
    precondition {
      condition     = var.payments_enabled != "1" || jsondecode(file("${path.module}/../commercial-status.json")).commercialHoldActive == false
      error_message = "payments_enabled is \"1\" but commercial-status.json still has commercialHoldActive = true. Payment activity requires BOTH gates open (see docs/COMMERCIAL-STATUS.md); set commercialHoldActive to false in the same reviewed change, or leave payments_enabled at \"0\"."
    }

    # Live keys must never be paired with unverified price ids. This mirrors
    # the warn-only stripe_price_mode_confirmed check above, but blocks when
    # payments are actually being switched on.
    precondition {
      condition     = var.payments_enabled != "1" || !startswith(var.stripe_secret_key, "sk_live_") || var.stripe_price_ids_are_live
      error_message = "payments_enabled is \"1\" with a live Stripe key, but stripe_price_ids_are_live is still false. Confirm every stripe_price_id_* was created in Stripe LIVE mode, then set stripe_price_ids_are_live = true."
    }
  }
}

check "web_push_vapid_configuration_complete" {
  assert {
    condition = (
      var.web_push_vapid_public_key == "" &&
      var.web_push_vapid_private_key == "" &&
      var.web_push_vapid_subject == ""
      ) || (
      var.web_push_vapid_public_key != "" &&
      var.web_push_vapid_private_key != "" &&
      var.web_push_vapid_subject != ""
    )
    error_message = "Configure all three web_push_vapid_* values together, or leave all three blank to disable background web push."
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
  enable_alarms               = var.enable_monitoring_alarms
  enable_dashboard            = var.enable_monitoring_dashboard
  api_gateway_id              = module.api.api_gateway_id
  api_access_log_group_name   = module.api.api_access_log_group_name
  api_lambda_log_group_name   = module.api.api_lambda_log_group_name
  auth_lambda_log_group_name  = module.api.auth_lambda_log_group_name
  # Scheduled-job log groups: the run-summary metric filters read these. Without
  # them a run where every household failed is indistinguishable from a quiet
  # week (see the filters in modules/monitoring/main.tf). The billing log group
  # is the source of the Stripe no-grant filters added alongside them.
  reminders_lambda_log_group_name = module.api.reminders_lambda_log_group_name
  digests_lambda_log_group_name   = module.api.digests_lambda_log_group_name
  billing_lambda_log_group_name   = module.api.billing_lambda_log_group_name
  lambda_function_names           = module.api.lambda_function_names
  alert_email                     = var.alert_email
  alert_sms_number                = var.alert_sms_number
  dynamodb_table_name             = module.database.table_name
  monthly_budget_usd              = var.monthly_budget_usd
  lambda_dlq_name                 = module.api.lambda_dlq_name
  # Wired only when the email module is provisioned (domain set). No cycle:
  # monitoring already depends on api (which depends on email), and email
  # depends on nothing here.
  email_forwarder_dlq_name       = var.domain_name == "" ? "" : module.email[0].forwarder_dlq_name
  email_forwarder_log_group_name = var.domain_name == "" ? "" : module.email[0].forwarder_log_group_name
  # Same conditional wiring as the forwarder DLQ: the SES reputation alarms
  # exist only when the email module does.
  ses_configuration_set_name = var.domain_name == "" ? "" : module.email[0].configuration_set_name

  # External availability (issue #464). Every alarm in modules/monitoring reads
  # a metric this stack publishes and treats missing data as not-breaching, so
  # none of them can see "the stack served nobody". These two health checks are
  # the only monitoring here that observes production from OUTSIDE it.
  #
  # The hostnames come from the modules that own them rather than from tfvars,
  # so changing the domain cannot leave a health check probing the old name
  # while still reporting healthy. `site_url` is the custom domain when one is
  # set and the CloudFront hostname otherwise; `api_url` carries the stage, so
  # the host is its first path segment and the stage goes into the path.
  enable_site_health_check = var.enable_site_health_check
  enable_api_health_check  = var.enable_api_health_check

  # Whether the frontend error rail can report at all (issue #576). The two
  # health checks above watch the site and the API from outside; this watches
  # the reporting path itself, which runs THROUGH the API it reports failures
  # of and was therefore silent in exactly the cases worth alarming on. Its
  # heartbeat comes from .github/workflows/uptime.yml, so it belongs only to an
  # environment that workflow actually probes.
  enable_telemetry_delivery_alarm = var.enable_telemetry_delivery_alarm

  site_health_check_host = replace(module.frontend.site_url, "https://", "")
  api_health_check_host  = split("/", replace(module.api.api_url, "https://", ""))[0]
  api_health_check_path  = "/${var.environment}/health"
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

  providers = {
    aws     = aws
    aws.iam = aws.iam
  }
  count = var.github_org == "" || var.github_repo == "" ? 0 : 1

  project_name = var.project_name
  github_org   = var.github_org
  github_repo  = var.github_repo
}
